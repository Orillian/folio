/**
 * Page access (a `page_access` row and its grants) and the trash.
 *
 * Deleting a page drops its index row, and the access rules hang off that row,
 * so storage.deletePage / deleteSpace write the rules of every restricted page
 * a deletion takes away into the trash item's `payload` (TrashPagePayload.access).
 * This module is the other half: what a restore may put back — the rule exactly
 * as it was, narrowed to who can still hold it — and who may read the title of a
 * trashed restricted page.
 *
 * What changed while the item sat in the trash decides what the restore does;
 * it never makes a page more open than it was:
 *  - a grant to somebody who is not an active member of the space any more is
 *    dropped (a grant cannot outlive the membership; they are not given it back
 *    if they return);
 *  - the owner stays the owner even if they left the space: the page then
 *    stays hidden from everyone but the grantees, exactly like a live page
 *    whose owner was removed, and is theirs again if they come back;
 *  - only when the owner's ACCOUNT is gone (the rule cannot point at nobody)
 *    does the person who restores become the owner — the page stays restricted.
 * An item without a record (deleted before rules were kept, or nothing in it
 * was restricted) restores as it always did: no rule is invented.
 */
import type { User } from '../../shared/contracts.js';
import { query } from '../db/pool.js';
import * as pageAccess from '../pageAccess.js';
import { groupInSpaceSql } from '../access/roleSql.js';
import { intersectAccessRules } from '../storage.js';
import type { PageAccessRule, RestoredAccess, TrashAccessEntry } from '../storage.js';
import { isBelow } from '../access/pageTree.js';
import type { TrashRow } from './service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The payload is JSON from the database: take only what is well-formed. */
export function accessEntriesOf(row: Pick<TrashRow, 'payload'>): TrashAccessEntry[] {
  const raw = (row.payload as { access?: unknown } | null)?.access;
  if (!Array.isArray(raw)) return [];
  const entries: TrashAccessEntry[] = [];
  for (const item of raw as Array<Partial<TrashAccessEntry> | null>) {
    if (!item || typeof item.pageId !== 'string' || typeof item.relPath !== 'string' || typeof item.ownerId !== 'string' || !UUID_RE.test(item.ownerId)) continue;
    const grants = (Array.isArray(item.grants) ? item.grants : []).filter(
      (g): g is PageAccessRule['grants'][number] => !!g && typeof g.userId === 'string' && UUID_RE.test(g.userId) && (g.role === 'viewer' || g.role === 'editor'),
    );
    const groupGrants = (Array.isArray(item.groupGrants) ? item.groupGrants : []).filter(
      (g): g is NonNullable<PageAccessRule['groupGrants']>[number] =>
        !!g && typeof g.groupId === 'string' && UUID_RE.test(g.groupId) && (g.role === 'viewer' || g.role === 'editor'),
    );
    const inheritedFrom = Array.isArray(item.inheritedFrom) ? item.inheritedFrom.filter((id): id is string => typeof id === 'string') : [];
    entries.push({
      pageId: item.pageId,
      relPath: item.relPath,
      ownerId: item.ownerId,
      grants,
      ...(groupGrants.length ? { groupGrants } : {}),
      ...(inheritedFrom.length ? { inheritedFrom } : {}),
    });
  }
  return entries;
}

/** The rules on the item's own target page (not on anything below it): its own, and what it inherited from restricted ancestors (stage 7); empty when it was open. */
export function targetRulesOf(row: TrashRow): TrashAccessEntry[] {
  if (row.kind === 'space') return [];
  return accessEntriesOf(row).filter((entry) => entry.pageId === row.page_id);
}

/**
 * Per-request cache of "who can read this space right now"; the trash list asks
 * it for every restricted item.
 */
export class MemberCache {
  private readonly bySpace = new Map<string, Promise<Set<string>>>();
  of(space: string): Promise<Set<string>> {
    let found = this.bySpace.get(space);
    if (!found) {
      found = pageAccess.activeMemberIds(space);
      this.bySpace.set(space, found);
    }
    return found;
  }
}

/**
 * Whether `actor` could have read the trashed target page: an active member of
 * the space who is the owner of its rule or holds a grant. The trash itself is
 * for administrators; an administrator who was not let into the page does not
 * learn its title or path from it.
 */
export async function canReadTrashedTarget(actor: User, row: TrashRow, members: MemberCache): Promise<boolean> {
  const rules = targetRulesOf(row);
  if (rules.length === 0) return true;
  if (!(await members.of(row.space_slug)).has(actor.id)) return false;
  return rules.every((rule) => rule.ownerId === actor.id || rule.grants.some((grant) => grant.userId === actor.id));
}

/**
 * The rules to give back with the item's pages, checked against the space as
 * it is now. `mapPath` turns a space-relative path at deletion time into the
 * path the file has after the restore (undefined = not part of this restore).
 * `undefined` result = nothing to restore.
 */
export async function resolveRestoredAccess(
  row: TrashRow,
  space: string,
  actor: User,
  mapPath: (oldRelPath: string) => string | undefined,
): Promise<RestoredAccess | undefined> {
  const entries = await withInheritance(accessEntriesOf(row), space, mapPath);
  if (entries.length === 0) return undefined;
  const members = await pageAccess.activeMemberIds(space);
  // A group grant comes back only for a group that still exists, is active and is in the space (the same rule as granting it).
  const groupsInSpace = new Set(
    (await query<{ id: string }>(`SELECT g.id FROM groups g WHERE g.archived_at IS NULL AND ${groupInSpaceSql('g.id', '$1')}`, [space])).map((g) => g.id),
  );
  const owners = await query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1::uuid[])', [[...new Set(entries.map((entry) => entry.ownerId))]]);
  const existing = new Set(owners.map((owner) => owner.id));

  const byId = new Map<string, PageAccessRule>();
  const byPath = new Map<string, PageAccessRule>();
  for (const entry of entries) {
    const ownerId = existing.has(entry.ownerId) ? entry.ownerId : actor.id;
    const seen = new Set<string>([ownerId]);
    const grants: PageAccessRule['grants'] = [];
    for (const grant of entry.grants) {
      if (!members.has(grant.userId) || seen.has(grant.userId)) continue;
      seen.add(grant.userId);
      grants.push({ userId: grant.userId, role: grant.role });
    }
    const groupGrants = (entry.groupGrants ?? []).filter((grant) => groupsInSpace.has(grant.groupId));
    const rule: PageAccessRule = { ownerId, grants, ...(groupGrants.length ? { groupGrants } : {}) };
    byId.set(entry.pageId, rule);
    const newPath = mapPath(entry.relPath);
    if (newPath !== undefined) byPath.set(newPath, rule);
  }
  return { byId, byPath };
}

/**
 * Stage 7: an entry with `inheritedFrom` is what the deleted page inherited from
 * restricted ancestors that stayed behind. Where the page lands under every one
 * of them again (they still exist, are still restricted and are still above the
 * restored path), they restrict it as before and the entry is dropped.
 * Otherwise it becomes part of the page's own rule — alone, or intersected with
 * the page's own recorded rule — so the page never comes back more open than it
 * was.
 */
async function withInheritance(entries: TrashAccessEntry[], space: string, mapPath: (oldRelPath: string) => string | undefined): Promise<TrashAccessEntry[]> {
  const inherited = entries.filter((entry) => entry.inheritedFrom?.length);
  if (inherited.length === 0) return entries;
  const own = entries.filter((entry) => !entry.inheritedFrom?.length);
  const ancestorIds = [...new Set(inherited.flatMap((entry) => entry.inheritedFrom!))];
  const live = new Map(
    (
      await query<{ id: string; path: string; kind: string; is_index: boolean }>(
        `SELECT p.id, p.path, p.kind, p.is_index FROM page_access a JOIN pages_index p ON p.id = a.page_id WHERE p.space_slug = $1 AND p.id = ANY($2::text[])`,
        [space, ancestorIds],
      )
    ).map((row) => [row.id, row]),
  );
  for (const entry of inherited) {
    const newPath = mapPath(entry.relPath);
    const covered =
      newPath !== undefined &&
      entry.inheritedFrom!.every((id) => {
        const ancestor = live.get(id);
        return ancestor !== undefined && isBelow({ path: ancestor.path, kind: ancestor.kind, isIndex: ancestor.is_index }, newPath);
      });
    if (covered) continue;
    const index = own.findIndex((candidate) => candidate.pageId === entry.pageId);
    if (index === -1) {
      own.push({ pageId: entry.pageId, relPath: entry.relPath, ownerId: entry.ownerId, grants: entry.grants, ...(entry.groupGrants ? { groupGrants: entry.groupGrants } : {}) });
    } else {
      const base = own[index];
      // The page's own rule first: its owner stays the owner when every level lets them in.
      own[index] = { pageId: base.pageId, relPath: base.relPath, ...intersectAccessRules([entry, base]) };
    }
  }
  return own;
}
