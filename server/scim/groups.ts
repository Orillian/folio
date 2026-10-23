/**
 * SCIM /Groups (RFC 7643 §4.2). A SCIM Group is a Folio group with source 'scim' created by the token's provider
 * (groups.scim_provider_id, migration 059); local groups and other providers' groups are invisible to the token.
 *
 * Members are Folio accounts linked to the same provider (users.ts). A membership written over SCIM has
 * source 'scim'; one that already existed (added by hand in Folio) is left as it is: SCIM never removes a
 * local membership, and "add" of a person who is already a member is a no-op. Okta replaces the whole member
 * list (PUT, or PATCH replace); Entra ID sends add / remove with value arrays; both work.
 *
 * DELETE archives the group (its space roles and page grants stop applying, nothing is lost); a POST with the
 * same externalId later revives it. Any change that would leave a space without an admin — the group holds the
 * space's admin role and the change removes its last active admin — is refused with 409 (mutability), and the
 * whole request is rolled back.
 */
import type { PoolClient } from 'pg';
import { recordAudit } from '../audit.js';
import { query, queryOne, withTransaction } from '../db/pool.js';
import * as groupStore from '../groups/store.js';
import { scimBadRequest, scimConflict, scimNotFound } from './errors.js';
import type { FilterTerm } from './filter.js';
import { GROUP_SCHEMA, parsePatch, parseScim, scimGroupSchema, stripCoreUrn } from './schemas.js';
import { listResponse, userLocation, visibleUserIds, type Page, type ScimContext } from './users.js';

interface GroupRow {
  id: string;
  name: string;
  external_id: string | null;
  created_at: string;
}

interface MemberRow {
  user_id: string;
  name: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GROUP_SELECT = `SELECT g.id, g.name, g.external_id, g.created_at FROM groups g
 WHERE g.source = 'scim' AND g.scim_provider_id = $1 AND g.archived_at IS NULL`;

function groupLocation(ctx: ScimContext, id: string): string {
  return `${ctx.baseUrl}/Groups/${id}`;
}

/** The members the provider can see: accounts linked to it (any membership source). */
async function membersOf(ctx: ScimContext, groupIds: readonly string[]): Promise<Map<string, MemberRow[]>> {
  const out = new Map<string, MemberRow[]>(groupIds.map((id) => [id, []]));
  if (groupIds.length === 0) return out;
  const rows = await query<MemberRow & { group_id: string }>(
    `SELECT DISTINCT gm.group_id, u.id AS user_id, u.name
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id AND NOT u.is_system
       JOIN user_identities i ON i.user_id = u.id AND i.provider_id = $1 AND i.scim_deleted_at IS NULL
      WHERE gm.group_id = ANY($2::uuid[])
      ORDER BY u.name`,
    [ctx.provider.id, groupIds],
  );
  for (const row of rows) out.get(row.group_id)?.push(row);
  return out;
}

function toScimGroup(ctx: ScimContext, row: GroupRow, members: MemberRow[] | null): Record<string, unknown> {
  const created = new Date(row.created_at).toISOString();
  return {
    schemas: [GROUP_SCHEMA],
    id: row.id,
    displayName: row.name,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    ...(members ? { members: members.map((m) => ({ value: m.user_id, display: m.name, type: 'User', $ref: userLocation(ctx, m.user_id) })) } : {}),
    meta: { resourceType: 'Group', created, lastModified: created, location: groupLocation(ctx, row.id) },
  };
}

async function findGroup(ctx: ScimContext, id: string): Promise<GroupRow | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  return queryOne<GroupRow>(`${GROUP_SELECT} AND g.id = $2`, [ctx.provider.id, id]);
}

async function requireGroup(ctx: ScimContext, id: string): Promise<GroupRow> {
  const row = await findGroup(ctx, id);
  if (!row) throw scimNotFound('group');
  return row;
}

export async function getScimGroup(ctx: ScimContext, id: string, opts: { excludeMembers: boolean }): Promise<Record<string, unknown>> {
  const row = await requireGroup(ctx, id);
  const members = opts.excludeMembers ? null : ((await membersOf(ctx, [row.id])).get(row.id) ?? []);
  return toScimGroup(ctx, row, members);
}

export async function listScimGroups(ctx: ScimContext, terms: FilterTerm[], page: Page, opts: { excludeMembers: boolean }): Promise<Record<string, unknown>> {
  const params: unknown[] = [ctx.provider.id];
  const clauses: string[] = [];
  for (const term of terms) {
    params.push(term.value);
    const p = `$${params.length}`;
    if (term.attr === 'displayname') clauses.push(`lower(g.name) = lower(${p}::text)`);
    else if (term.attr === 'externalid') clauses.push(`g.external_id = ${p}::text`);
    else if (term.attr === 'id') clauses.push(`g.id::text = ${p}::text`);
    else if (term.attr === 'members.value') clauses.push(`EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.id AND gm.user_id::text = ${p}::text)`);
    else throw scimBadRequest(`filtering Groups on "${term.attr}" is not supported`, 'invalidFilter');
  }
  const where = clauses.map((c) => ` AND ${c}`).join('');
  const countRow = await queryOne<{ count: string }>(`SELECT COUNT(*) AS count FROM (${GROUP_SELECT}${where}) x`, params);
  const total = Number(countRow?.count ?? 0);
  if (page.count === 0) return listResponse([], total, page);
  const rows = await query<GroupRow>(`${GROUP_SELECT}${where} ORDER BY g.created_at, g.id OFFSET $${params.length + 1} LIMIT $${params.length + 2}`, [
    ...params,
    page.startIndex - 1,
    page.count,
  ]);
  const members = opts.excludeMembers ? null : await membersOf(ctx, rows.map((r) => r.id));
  return listResponse(
    rows.map((r) => toScimGroup(ctx, r, members ? (members.get(r.id) ?? []) : null)),
    total,
    page,
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function slugBase(displayName: string): string {
  const base = displayName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return base || 'group';
}

async function freeSlug(client: PoolClient, displayName: string): Promise<string> {
  const base = slugBase(displayName);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const taken = await client.query('SELECT 1 FROM groups WHERE slug = $1', [candidate]);
    if (taken.rowCount === 0) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Member values -> account ids; every one must be a user of this provider (400 otherwise). */
async function resolveMembers(ctx: ScimContext, raw: unknown): Promise<string[]> {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const ids: string[] = [];
  for (const item of list) {
    const value = typeof item === 'string' ? item : typeof item === 'object' && item !== null ? (item as { value?: unknown }).value : undefined;
    if (typeof value !== 'string' || !value.trim()) throw scimBadRequest('a member needs a "value" (the user id)');
    ids.push(value.trim());
  }
  const unique = [...new Set(ids)];
  const visible = await visibleUserIds(ctx.provider.id, unique);
  const unknown = unique.filter((id) => !visible.has(id));
  if (unknown.length > 0) throw scimBadRequest(`unknown member(s) for this provider: ${unknown.slice(0, 5).join(', ')}`);
  return unique;
}

/** 409 when a space where this group is admin has no admin left (on the transaction about to commit). */
async function assertKeepsSpaceAdmins(client: PoolClient, groupId: string): Promise<void> {
  for (const space of await groupStore.adminSpacesOfGroup(client, groupId)) {
    if ((await groupStore.countSpaceAdminsOn(client, space)) === 0) {
      throw scimConflict(
        `this change would leave the space "${space}" without an admin: the group holds its admin role. Give the space another admin in Folio first.`,
        'mutability',
      );
    }
  }
}

interface MemberChange {
  added: string[];
  removed: string[];
}

async function addMembers(client: PoolClient, groupId: string, userIds: readonly string[], change: MemberChange): Promise<void> {
  for (const userId of userIds) {
    const res = await client.query(
      `INSERT INTO group_members (group_id, user_id, source) VALUES ($1, $2, 'scim') ON CONFLICT (group_id, user_id) DO NOTHING`,
      [groupId, userId],
    );
    if ((res.rowCount ?? 0) > 0) change.added.push(userId);
  }
}

/** Only memberships SCIM made (source 'scim'); `userIds` null = all of them. */
async function removeMembers(client: PoolClient, groupId: string, userIds: readonly string[] | null, change: MemberChange): Promise<void> {
  const res = await client.query<{ user_id: string }>(
    `DELETE FROM group_members WHERE group_id = $1 AND source = 'scim' AND ($2::uuid[] IS NULL OR user_id = ANY($2::uuid[])) RETURNING user_id`,
    [groupId, userIds ? userIds.filter((id) => UUID_RE.test(id)) : null],
  );
  change.removed.push(...res.rows.map((r) => r.user_id));
}

async function replaceMembers(client: PoolClient, groupId: string, userIds: readonly string[], change: MemberChange): Promise<void> {
  const res = await client.query<{ user_id: string }>(
    `DELETE FROM group_members WHERE group_id = $1 AND source = 'scim' AND NOT (user_id = ANY($2::uuid[])) RETURNING user_id`,
    [groupId, [...userIds]],
  );
  change.removed.push(...res.rows.map((r) => r.user_id));
  await addMembers(client, groupId, userIds, change);
}

async function auditMembers(ctx: ScimContext, groupId: string, groupName: string, change: MemberChange): Promise<void> {
  const ids = [...change.added, ...change.removed];
  if (ids.length === 0) return;
  const names = new Map((await query<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = ANY($1::uuid[])', [ids])).map((r) => [r.id, r.name]));
  for (const userId of change.added) {
    recordAudit(null, 'scim.member_add', groupId, { provider: ctx.provider.slug, groupName, targetUserId: userId, targetUserName: names.get(userId) ?? null });
  }
  for (const userId of change.removed) {
    recordAudit(null, 'scim.member_remove', groupId, { provider: ctx.provider.slug, groupName, targetUserId: userId, targetUserName: names.get(userId) ?? null });
  }
}

async function renameGroup(client: PoolClient, groupId: string, displayName: string | undefined, externalId: string | null | undefined): Promise<void> {
  try {
    await client.query('UPDATE groups SET name = COALESCE($2, name), external_id = CASE WHEN $3 THEN $4 ELSE external_id END WHERE id = $1', [
      groupId,
      displayName ?? null,
      externalId !== undefined,
      externalId ?? null,
    ]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw scimConflict('another SCIM group already has this externalId');
    throw err;
  }
}

export async function createScimGroup(ctx: ScimContext, body: unknown): Promise<Record<string, unknown>> {
  const input = parseScim(scimGroupSchema, body);
  const externalId = input.externalId?.trim() || null;
  const memberIds = await resolveMembers(ctx, input.members);
  const change: MemberChange = { added: [], removed: [] };
  const clash = await queryOne<{ id: string }>(`${GROUP_SELECT} AND lower(g.name) = lower($2)`, [ctx.provider.id, input.displayName]);
  if (clash) throw scimConflict(`a group named "${input.displayName}" already exists for this provider`);

  const { id, revived } = await withTransaction(async (client) => {
    if (externalId) {
      const prior = await client.query<{ id: string; scim_provider_id: string | null; archived_at: string | null }>(
        "SELECT id, scim_provider_id, archived_at FROM groups WHERE source = 'scim' AND external_id = $1",
        [externalId],
      );
      const row = prior.rows[0];
      if (row && (row.scim_provider_id !== ctx.provider.id || !row.archived_at)) throw scimConflict('a SCIM group with this externalId already exists');
      if (row) {
        // DELETE archived it; the same group comes back with its space roles.
        await client.query('UPDATE groups SET archived_at = NULL, name = $2 WHERE id = $1', [row.id, input.displayName]);
        await replaceMembers(client, row.id, memberIds, change);
        return { id: row.id, revived: true };
      }
    }
    const slug = await freeSlug(client, input.displayName);
    let inserted;
    try {
      inserted = await client.query<{ id: string }>(
        `INSERT INTO groups (slug, name, description, source, external_id, scim_provider_id) VALUES ($1, $2, '', 'scim', $3, $4) RETURNING id`,
        [slug, input.displayName, externalId, ctx.provider.id],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw scimConflict('a SCIM group with this externalId already exists');
      throw err;
    }
    await addMembers(client, inserted.rows[0].id, memberIds, change);
    return { id: inserted.rows[0].id, revived: false };
  });
  recordAudit(null, 'scim.group_create', id, { provider: ctx.provider.slug, groupName: input.displayName, externalId, members: memberIds.length, ...(revived ? { revived: true } : {}) });
  await auditMembers(ctx, id, input.displayName, change);
  return getScimGroup(ctx, id, { excludeMembers: false });
}

export async function replaceScimGroup(ctx: ScimContext, id: string, body: unknown): Promise<Record<string, unknown>> {
  const row = await requireGroup(ctx, id);
  const input = parseScim(scimGroupSchema, body);
  // An omitted `members` keeps the membership: clearing a group by leaving a field out is too easy to do by accident.
  const memberIds = input.members === undefined || input.members === null ? null : await resolveMembers(ctx, input.members);
  const externalId = 'externalId' in (body as object) ? input.externalId?.trim() || null : undefined;
  const change: MemberChange = { added: [], removed: [] };
  await withTransaction(async (client) => {
    await renameGroup(client, row.id, input.displayName, externalId);
    if (memberIds) await replaceMembers(client, row.id, memberIds, change);
    await assertKeepsSpaceAdmins(client, row.id);
  });
  if (input.displayName !== row.name || (externalId !== undefined && externalId !== row.external_id)) {
    recordAudit(null, 'scim.group_update', row.id, { provider: ctx.provider.slug, groupName: input.displayName, ...(input.displayName !== row.name ? { previousName: row.name } : {}) });
  }
  await auditMembers(ctx, row.id, input.displayName, change);
  return getScimGroup(ctx, row.id, { excludeMembers: false });
}

export async function patchScimGroup(ctx: ScimContext, id: string, body: unknown): Promise<Record<string, unknown> | null> {
  const ops = parsePatch(body);
  const row = await requireGroup(ctx, id);
  // Resolve every member value up front (400 before anything is written).
  type Step =
    | { kind: 'add' | 'remove' | 'replace'; ids: string[] | null }
    | { kind: 'rename'; displayName?: string; externalId?: string | null };
  const steps: Step[] = [];
  let membersTouched = false;
  for (const op of ops) {
    const path = op.path ? stripCoreUrn(op.path).trim() : '';
    const lower = path.toLowerCase();
    const filtered = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path);
    if (filtered) {
      if (op.op !== 'remove') throw scimBadRequest(`"${op.op}" on a filtered members path is not supported`, 'invalidPath');
      steps.push({ kind: 'remove', ids: [filtered[1]] });
      membersTouched = true;
    } else if (lower === 'members') {
      membersTouched = true;
      if (op.op === 'remove') steps.push({ kind: 'remove', ids: op.value === undefined ? null : await valueIds(op.value) });
      else steps.push({ kind: op.op, ids: await resolveMembers(ctx, op.value) });
    } else if (lower === 'displayname') {
      if (op.op === 'remove' || typeof op.value !== 'string' || !op.value.trim()) throw scimBadRequest('displayName must be a non-empty string');
      steps.push({ kind: 'rename', displayName: op.value.trim().slice(0, 200) });
    } else if (lower === 'externalid') {
      if (op.op !== 'remove' && op.value !== null && typeof op.value !== 'string') throw scimBadRequest('externalId must be a string');
      steps.push({ kind: 'rename', externalId: op.op === 'remove' ? null : (op.value as string | null)?.trim() || null });
    } else if (!path) {
      if (typeof op.value !== 'object' || op.value === null || Array.isArray(op.value)) throw scimBadRequest('a PATCH operation without a path needs an object value', 'invalidSyntax');
      const value = op.value as Record<string, unknown>;
      // Okta: {"op": "replace", "value": {"id": "…", "displayName": "New name"}}
      if (typeof value.displayName === 'string' && value.displayName.trim()) steps.push({ kind: 'rename', displayName: value.displayName.trim().slice(0, 200) });
      if ('externalId' in value) steps.push({ kind: 'rename', externalId: typeof value.externalId === 'string' ? value.externalId.trim() || null : null });
      if ('members' in value) {
        membersTouched = true;
        steps.push({ kind: op.op === 'remove' ? 'remove' : op.op, ids: await resolveMembers(ctx, value.members) });
      }
    } else {
      throw scimBadRequest(`unsupported PATCH path for a Group: ${op.path}`, 'invalidPath');
    }
  }

  const change: MemberChange = { added: [], removed: [] };
  let displayName = row.name;
  let externalId: string | null | undefined;
  await withTransaction(async (client) => {
    for (const step of steps) {
      if (step.kind === 'rename') {
        if (step.displayName) displayName = step.displayName;
        if (step.externalId !== undefined) externalId = step.externalId;
        await renameGroup(client, row.id, step.displayName, step.externalId);
      } else if (step.kind === 'add') await addMembers(client, row.id, step.ids ?? [], change);
      else if (step.kind === 'remove') await removeMembers(client, row.id, step.ids, change);
      else await replaceMembers(client, row.id, step.ids ?? [], change);
    }
    if (change.removed.length > 0) await assertKeepsSpaceAdmins(client, row.id);
  });
  if (displayName !== row.name || (externalId !== undefined && externalId !== row.external_id)) {
    recordAudit(null, 'scim.group_update', row.id, { provider: ctx.provider.slug, groupName: displayName, ...(displayName !== row.name ? { previousName: row.name } : {}) });
  }
  // A member added and removed in the same request leaves no trace.
  const both = new Set(change.added.filter((id) => change.removed.includes(id)));
  await auditMembers(ctx, row.id, displayName, { added: change.added.filter((id) => !both.has(id)), removed: change.removed.filter((id) => !both.has(id)) });
  return membersTouched ? null : getScimGroup(ctx, row.id, { excludeMembers: false });
}

/** Ids from a remove's value (no visibility check needed: only SCIM memberships of this group are removed). */
async function valueIds(raw: unknown): Promise<string[]> {
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((item) => {
    const value = typeof item === 'string' ? item : typeof item === 'object' && item !== null ? (item as { value?: unknown }).value : undefined;
    if (typeof value !== 'string' || !value.trim()) throw scimBadRequest('a member needs a "value" (the user id)');
    return value.trim();
  });
}

export async function deleteScimGroup(ctx: ScimContext, id: string): Promise<void> {
  const row = await requireGroup(ctx, id);
  await withTransaction(async (client) => {
    await groupStore.setGroupArchived(client, row.id, true);
    await assertKeepsSpaceAdmins(client, row.id);
  });
  recordAudit(null, 'scim.group_archive', row.id, { provider: ctx.provider.slug, groupName: row.name });
}
