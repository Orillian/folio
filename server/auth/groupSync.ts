/**
 * Group sync at sign-in (migration 057, docs/AUTH.md): the groups an identity
 * provider asserts about a person become Folio group memberships.
 *
 * ONE entry point for every protocol — `syncIdpGroups(userId, providerId,
 * providerKind, rawGroups, opts)`. OIDC calls it from the callback right after
 * the account is resolved (oidc.ts); the SAML ACS handler must call it the same
 * way with `providerKind: 'saml'` and the attribute values as `rawGroups`.
 * It never throws: a failure is logged and audited as `auth.group_sync_skipped`
 * and the sign-in goes on.
 *
 * Rules (owner decisions):
 *  - Off unless the provider's `groupSync.enabled`. The claim is
 *    `claimMapping.groups`; the caller extracts it, this module reads the value.
 *  - Which Folio group an IdP value means: mode 'name' — the group whose slug
 *    or name equals the value (case-insensitive), or the one this provider kind
 *    created for it earlier (`groups.external_id`); mode 'mapping' — only the
 *    explicit table IdP value -> Folio group slug. `allow` (prefix list or
 *    /regex/) drops unrelated IdP groups first. `createMissing` creates a group
 *    (source = the provider kind, external_id = the IdP value) when none matches.
 *  - Added: `group_members` rows with source = the kind and source_provider_id =
 *    this provider. Removed: only rows with that same source AND provider that
 *    the provider no longer asserts. A manual (`local`) membership, a manager
 *    flag, another provider's membership and an archived group are never touched.
 *  - All writes are one transaction. A removal that would leave a space without
 *    an admin (the last-admin guard of groups/store.ts) is undone for that group
 *    alone — the membership stays and `auth.group_sync_warning` is audited.
 *  - Entra "overage" (the claim replaced by `_claim_names` / `hasgroups`): the
 *    caller passes `overage: true`; nothing is changed and
 *    `auth.group_sync_skipped` {reason: 'overage'} is audited.
 *  - An absent claim is an empty list (Entra omits it for a person in no group).
 *  - Audit: `group.create`, `group.member_add` / `group.member_remove` with
 *    meta {source: 'idp', provider}, one `auth.group_sync` summary per sign-in.
 */
import type { PoolClient } from 'pg';
import { withTransaction } from '../db/pool.js';
import { recordAudit } from '../audit.js';
import * as groupStore from '../groups/store.js';
import * as providers from './providers.js';
import type { AuthProvider } from './providers.js';
import { allowPredicate, extractGroupValues, slugifyGroupValue } from './groupSyncConfig.js';

export type GroupSyncSkipReason = 'overage' | 'invalid_claim' | 'too_many_groups' | 'error';

export interface GroupSyncResult {
  /** 'off': sync is disabled for the provider (nothing audited); 'skipped': see `reason`; 'synced'. */
  status: 'off' | 'skipped' | 'synced';
  reason?: GroupSyncSkipReason;
  added: number;
  removed: number;
  /** Memberships asserted and already present (any source). */
  unchanged: number;
  /** Groups created (createMissing). */
  created: number;
  /** IdP values dropped by the allowlist. */
  filtered: number;
  /** IdP values that matched no Folio group (and createMissing is off). */
  unmatched: number;
  /** Matched groups that are archived — neither joined nor left. */
  archived: number;
  /** Removals undone because they would have left a space without an admin. */
  keptLastAdmin: number;
}

const MAX_VALUES = 500;

const empty = (status: GroupSyncResult['status'], reason?: GroupSyncSkipReason): GroupSyncResult => ({
  status,
  ...(reason ? { reason } : {}),
  added: 0,
  removed: 0,
  unchanged: 0,
  created: 0,
  filtered: 0,
  unmatched: 0,
  archived: 0,
  keptLastAdmin: 0,
});

interface GroupRow {
  id: string;
  slug: string;
  name: string;
  source: string;
  external_id: string | null;
  archived_at: string | null;
}

interface Planned {
  groupId: string;
  slug: string;
  name: string;
  archived: boolean;
}

/** Looks an IdP value up among the loaded groups: by what this kind created for it, then slug, then name. */
function findByValue(groups: GroupRow[], kind: string, value: string): GroupRow | undefined {
  const lower = value.toLowerCase();
  return (
    groups.find((g) => g.source === kind && g.external_id === value) ??
    groups.find((g) => g.slug === slugifyGroupValue(value) || g.slug === lower) ??
    groups.find((g) => g.name.toLowerCase() === lower)
  );
}

async function createGroupRow(client: PoolClient, input: { slug: string; name: string; kind: string; externalId: string }): Promise<{ row: GroupRow; inserted: boolean }> {
  const inserted = await client.query<GroupRow>(
    `INSERT INTO groups (slug, name, source, external_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING RETURNING id, slug, name, source, external_id, archived_at`,
    [input.slug, input.name.slice(0, 120), input.kind, input.externalId],
  );
  if (inserted.rows[0]) return { row: inserted.rows[0], inserted: true };
  // A concurrent sign-in created it first.
  const found = await client.query<GroupRow>(
    `SELECT id, slug, name, source, external_id, archived_at FROM groups WHERE slug = $1 OR (source = $2 AND external_id = $3) LIMIT 1`,
    [input.slug, input.kind, input.externalId],
  );
  return { row: found.rows[0]!, inserted: false };
}

/**
 * Brings `userId`'s memberships from `providerKind` provider `providerId` in line with `rawGroups` (the groups
 * claim / attribute exactly as the provider sent it). `opts.overage`: the provider said the list is too long to send.
 * `opts.provider`: the already-loaded provider (saves a query).
 */
export async function syncIdpGroups(
  userId: string,
  providerId: string,
  providerKind: 'oidc' | 'saml',
  rawGroups: unknown,
  opts: { overage?: boolean; provider?: AuthProvider } = {},
): Promise<GroupSyncResult> {
  let provider: AuthProvider | undefined;
  try {
    provider = opts.provider ?? (await providers.getProviderById(providerId));
  } catch (err) {
    console.error('[group-sync] provider lookup failed:', err instanceof Error ? err.message : err);
    return empty('skipped', 'error');
  }
  if (!provider || !provider.groupSync.enabled) return empty('off');
  const config = provider.groupSync;
  const audit = { provider: provider.slug };

  const skip = (reason: GroupSyncSkipReason, extra: Record<string, unknown> = {}): GroupSyncResult => {
    recordAudit(userId, 'auth.group_sync_skipped', provider!.slug, { ...audit, reason, ...extra });
    return empty('skipped', reason);
  };

  if (opts.overage) return skip('overage');
  const values = extractGroupValues(rawGroups);
  if (values === null) return skip('invalid_claim');
  if (values.length > MAX_VALUES) return skip('too_many_groups', { count: values.length });

  try {
    const allowed = allowPredicate(config.allow);
    const result = empty('synced');
    const plannedGroups = new Map<string, Planned>();
    const events: Array<{ action: string; meta: Record<string, unknown> }> = [];
    const warnings: Array<Record<string, unknown>> = [];

    await withTransaction(async (client) => {
      const loaded = await client.query<GroupRow>('SELECT id, slug, name, source, external_id, archived_at FROM groups');
      const groups = loaded.rows;
      const mapping = new Map(Object.entries(config.mapping).map(([idp, slug]) => [idp.toLowerCase(), slug]));

      for (const value of values) {
        if (!allowed(value)) {
          result.filtered++;
          continue;
        }
        let row: GroupRow | undefined;
        let slugToCreate: string;
        if (config.mode === 'mapping') {
          const target = mapping.get(value.toLowerCase());
          if (!target) {
            result.unmatched++;
            continue;
          }
          row = groups.find((g) => g.slug === target);
          slugToCreate = target;
        } else {
          row = findByValue(groups, providerKind, value);
          slugToCreate = slugifyGroupValue(value);
        }
        if (!row && config.createMissing) {
          const created = await createGroupRow(client, { slug: slugToCreate, name: config.mode === 'mapping' ? slugToCreate : value, kind: providerKind, externalId: value });
          row = created.row;
          if (!groups.some((g) => g.id === row!.id)) groups.push(row);
          if (created.inserted) {
            result.created++;
            events.push({ action: 'group.create', meta: { groupId: row.id, groupName: row.name, groupSlug: row.slug, source: 'idp', provider: provider!.slug } });
          }
        }
        if (!row) {
          result.unmatched++;
          continue;
        }
        plannedGroups.set(row.id, { groupId: row.id, slug: row.slug, name: row.name, archived: row.archived_at !== null });
      }

      const current = await client.query<{ group_id: string; slug: string; name: string; archived: boolean; source: string; source_provider_id: string | null }>(
        `SELECT gm.group_id, g.slug, g.name, g.archived_at IS NOT NULL AS archived, gm.source, gm.source_provider_id
           FROM group_members gm JOIN groups g ON g.id = gm.group_id
          WHERE gm.user_id = $1`,
        [userId],
      );
      const memberOf = new Set(current.rows.map((r) => r.group_id));

      for (const planned of plannedGroups.values()) {
        if (planned.archived) {
          result.archived++;
          continue;
        }
        if (memberOf.has(planned.groupId)) {
          result.unchanged++;
          continue;
        }
        const inserted = await client.query(
          `INSERT INTO group_members (group_id, user_id, source, source_provider_id) VALUES ($1, $2, $3, $4) ON CONFLICT (group_id, user_id) DO NOTHING`,
          [planned.groupId, userId, providerKind, provider!.id],
        );
        if ((inserted.rowCount ?? 0) > 0) {
          result.added++;
          events.push({ action: 'group.member_add', meta: { groupId: planned.groupId, groupName: planned.name, groupSlug: planned.slug, targetUserId: userId, source: 'idp', provider: provider!.slug } });
        } else result.unchanged++;
      }

      const stale = current.rows.filter((r) => r.source === providerKind && r.source_provider_id === provider!.id && !r.archived && !plannedGroups.has(r.group_id));
      for (const row of stale) {
        await client.query('SAVEPOINT idp_remove');
        await client.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [row.group_id, userId]);
        const adminSpaces = await groupStore.adminSpacesOfGroup(client, row.group_id);
        let lastAdminOf: string | undefined;
        for (const space of adminSpaces) {
          if ((await groupStore.countSpaceAdminsOn(client, space)) === 0) {
            lastAdminOf = space;
            break;
          }
        }
        if (lastAdminOf) {
          await client.query('ROLLBACK TO SAVEPOINT idp_remove');
          result.keptLastAdmin++;
          warnings.push({ groupId: row.group_id, groupName: row.name, groupSlug: row.slug, targetUserId: userId, reason: 'last_admin', space: lastAdminOf, provider: provider!.slug });
        } else {
          result.removed++;
          events.push({ action: 'group.member_remove', meta: { groupId: row.group_id, groupName: row.name, groupSlug: row.slug, targetUserId: userId, source: 'idp', provider: provider!.slug } });
        }
        await client.query('RELEASE SAVEPOINT idp_remove');
      }
    });

    for (const e of events) recordAudit(userId, e.action, String(e.meta.groupId), e.meta);
    for (const w of warnings) recordAudit(userId, 'auth.group_sync_warning', String(w.groupId), w);
    recordAudit(userId, 'auth.group_sync', provider.slug, {
      ...audit,
      groups: values.length,
      added: result.added,
      removed: result.removed,
      unchanged: result.unchanged,
      created: result.created,
      filtered: result.filtered,
      unmatched: result.unmatched,
      archived: result.archived,
      keptLastAdmin: result.keptLastAdmin,
    });
    return result;
  } catch (err) {
    console.error('[group-sync] failed:', err instanceof Error ? err.message : err);
    return skip('error', { detail: err instanceof Error ? err.message.slice(0, 200) : String(err) });
  }
}
