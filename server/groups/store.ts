/**
 * Groups persistence (migration 053, docs/spec-access.md §15). Plain data
 * access — who may call what is decided in groups/service.ts. The role a group
 * gives its members is NOT computed here: that is access/roles.ts and its SQL
 * twin access/roleSql.ts, like every other source of a role.
 */
import type { PoolClient } from 'pg';
import type { GroupInfo, GroupMemberInfo, GroupSource, GroupSpaceRoleInfo, SpaceGroupMemberInfo, SpaceRole } from '../../shared/contracts.js';
import { getPool, query, queryOne } from '../db/pool.js';
import { conflict, notFound } from '../errors.js';

interface GroupRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  source: GroupSource;
  archived_at: string | null;
  created_at: string;
  member_count: string | number;
}

/** Active (not disabled, not system) members only. */
const MEMBER_COUNT_SQL = `(SELECT COUNT(*) FROM group_members gmc JOIN users gmu ON gmu.id = gmc.user_id
                            WHERE gmc.group_id = g.id AND NOT gmu.disabled AND NOT gmu.is_system)`;

const GROUP_SELECT = `SELECT g.id, g.slug, g.name, g.description, g.source, g.archived_at, g.created_at, ${MEMBER_COUNT_SQL} AS member_count FROM groups g`;

export interface StoredGroup extends Omit<GroupInfo, 'canManage'> {}

function rowToGroup(row: GroupRow): StoredGroup {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    source: row.source,
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    memberCount: Number(row.member_count),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listGroups(options: { includeArchived: boolean }): Promise<StoredGroup[]> {
  const rows = await query<GroupRow>(`${GROUP_SELECT} ${options.includeArchived ? '' : 'WHERE g.archived_at IS NULL'} ORDER BY lower(g.name), g.slug`);
  return rows.map(rowToGroup);
}

export async function getGroup(id: string): Promise<StoredGroup | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  const row = await queryOne<GroupRow>(`${GROUP_SELECT} WHERE g.id = $1`, [id]);
  return row ? rowToGroup(row) : undefined;
}

export async function requireGroup(id: string): Promise<StoredGroup> {
  const group = await getGroup(id);
  if (!group) throw notFound('group');
  return group;
}

/** The groups among `ids` that exist (archived included), keyed by id. */
export async function getGroupsByIds(ids: readonly string[]): Promise<Map<string, StoredGroup>> {
  const valid = ids.filter((id) => UUID_RE.test(id));
  if (valid.length === 0) return new Map();
  const rows = await query<GroupRow>(`${GROUP_SELECT} WHERE g.id = ANY($1::uuid[])`, [valid]);
  return new Map(rows.map((row) => [row.id, rowToGroup(row)]));
}

export async function createGroup(input: { slug: string; name: string; description: string }, createdBy: string): Promise<StoredGroup> {
  try {
    const row = await queryOne<{ id: string }>('INSERT INTO groups (slug, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [
      input.slug,
      input.name,
      input.description,
      createdBy,
    ]);
    return requireGroup(row!.id);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('a group with this slug already exists');
    throw err;
  }
}

export async function updateGroup(id: string, patch: { name?: string; description?: string }): Promise<void> {
  await query('UPDATE groups SET name = COALESCE($2, name), description = COALESCE($3, description) WHERE id = $1', [id, patch.name ?? null, patch.description ?? null]);
}

export async function setGroupArchived(client: PoolClient, id: string, archived: boolean): Promise<void> {
  await client.query(`UPDATE groups SET archived_at = CASE WHEN $2 THEN COALESCE(archived_at, now()) ELSE NULL END WHERE id = $1`, [id, archived]);
}

export async function deleteGroup(client: PoolClient, id: string): Promise<void> {
  await client.query('DELETE FROM groups WHERE id = $1', [id]);
}

// --- members -----------------------------------------------------------------

export async function listGroupMembers(groupId: string): Promise<GroupMemberInfo[]> {
  const rows = await query<{
    user_id: string;
    name: string;
    email: string;
    username: string | null;
    disabled: boolean;
    is_manager: boolean;
    source: GroupSource;
    added_at: string;
  }>(
    `SELECT gm.user_id, u.name, u.email, u.username, u.disabled, gm.is_manager, gm.source, gm.added_at
       FROM group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = $1 AND NOT u.is_system
      ORDER BY lower(u.name), u.email`,
    [groupId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    email: row.email,
    ...(row.username ? { username: row.username } : {}),
    disabled: row.disabled,
    isManager: row.is_manager,
    source: row.source,
    addedAt: new Date(row.added_at).toISOString(),
  }));
}

export async function getGroupMembership(groupId: string, userId: string): Promise<{ isManager: boolean; source: GroupSource } | undefined> {
  if (!UUID_RE.test(groupId) || !UUID_RE.test(userId)) return undefined;
  const row = await queryOne<{ is_manager: boolean; source: GroupSource }>('SELECT is_manager, source FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
  return row ? { isManager: row.is_manager, source: row.source } : undefined;
}

/** Ids of the groups `userId` manages (archived ones included). */
export async function managedGroupIds(userId: string): Promise<Set<string>> {
  const rows = await query<{ group_id: string }>('SELECT group_id FROM group_members WHERE user_id = $1 AND is_manager', [userId]);
  return new Set(rows.map((row) => row.group_id));
}

/** Adds `userId` (no-op when already a member, unless `isManager` is given — then the flag is set). Returns whether a new row was inserted. */
export async function addGroupMember(client: PoolClient | null, groupId: string, userId: string, isManager?: boolean): Promise<boolean> {
  const result = await (client ?? getPool()).query<{ inserted: boolean }>(
    `INSERT INTO group_members (group_id, user_id, is_manager) VALUES ($1, $2, COALESCE($3, false))
     ON CONFLICT (group_id, user_id) DO UPDATE SET is_manager = COALESCE($3, group_members.is_manager)
     RETURNING (xmax = 0) AS inserted`,
    [groupId, userId, isManager ?? null],
  );
  return Boolean(result.rows[0]?.inserted);
}

export async function removeGroupMember(client: PoolClient, groupId: string, userId: string): Promise<boolean> {
  const result = await client.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
  return (result.rowCount ?? 0) > 0;
}

export async function setGroupManager(groupId: string, userId: string, isManager: boolean): Promise<boolean> {
  const rows = await query<{ user_id: string }>('UPDATE group_members SET is_manager = $3 WHERE group_id = $1 AND user_id = $2 RETURNING user_id', [groupId, userId, isManager]);
  return rows.length > 0;
}

/** The groups `userId` belongs to (GET /api/users/:id/access). */
export async function groupsOfUser(userId: string): Promise<Array<{ id: string; slug: string; name: string; isManager: boolean; archived: boolean }>> {
  const rows = await query<{ id: string; slug: string; name: string; is_manager: boolean; archived: boolean }>(
    `SELECT g.id, g.slug, g.name, gm.is_manager, g.archived_at IS NOT NULL AS archived
       FROM group_members gm JOIN groups g ON g.id = gm.group_id
      WHERE gm.user_id = $1
      ORDER BY lower(g.name)`,
    [userId],
  );
  return rows.map((row) => ({ id: row.id, slug: row.slug, name: row.name, isManager: row.is_manager, archived: row.archived }));
}

// --- space roles ---------------------------------------------------------------

export async function listGroupSpaceRoles(groupId: string): Promise<GroupSpaceRoleInfo[]> {
  const rows = await query<{ space_slug: string; name: string; role: SpaceRole }>(
    `SELECT r.space_slug, s.name, r.role FROM space_group_roles r JOIN spaces s ON s.slug = r.space_slug
      WHERE r.group_id = $1 ORDER BY lower(s.name)`,
    [groupId],
  );
  return rows.map((row) => ({ space: row.space_slug, spaceName: row.name, role: row.role }));
}

/** Spaces where `groupId` holds `admin` — the ones its archive / delete / member removal could leave without an admin. */
export async function adminSpacesOfGroup(client: PoolClient, groupId: string): Promise<string[]> {
  const result = await client.query<{ space_slug: string }>("SELECT space_slug FROM space_group_roles WHERE group_id = $1 AND role = 'admin'", [groupId]);
  return result.rows.map((row) => row.space_slug);
}

export async function listSpaceGroups(space: string): Promise<SpaceGroupMemberInfo[]> {
  const rows = await query<GroupRow & { role: SpaceRole }>(
    `SELECT g.id, g.slug, g.name, g.description, g.source, g.archived_at, g.created_at, ${MEMBER_COUNT_SQL} AS member_count, r.role
       FROM space_group_roles r JOIN groups g ON g.id = r.group_id
      WHERE r.space_slug = $1
      ORDER BY lower(g.name)`,
    [space],
  );
  return rows.map((row) => ({
    group: { id: row.id, slug: row.slug, name: row.name, archived: row.archived_at !== null },
    role: row.role,
    memberCount: Number(row.member_count),
  }));
}

export async function getSpaceGroupRole(space: string, groupId: string): Promise<SpaceRole | undefined> {
  const row = await queryOne<{ role: SpaceRole }>('SELECT role FROM space_group_roles WHERE space_slug = $1 AND group_id = $2', [space, groupId]);
  return row?.role;
}

export async function setSpaceGroupRole(client: PoolClient, space: string, groupId: string, role: SpaceRole): Promise<void> {
  await client.query(
    `INSERT INTO space_group_roles (space_slug, group_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (space_slug, group_id) DO UPDATE SET role = EXCLUDED.role`,
    [space, groupId, role],
  );
}

export async function removeSpaceGroupRole(client: PoolClient, space: string, groupId: string): Promise<void> {
  await client.query('DELETE FROM space_group_roles WHERE space_slug = $1 AND group_id = $2', [space, groupId]);
}

/** Every group role, instance-wide (the access matrix). */
export async function listAllGroupRoles(): Promise<Array<{ groupId: string; space: string; role: SpaceRole }>> {
  const rows = await query<{ group_id: string; space_slug: string; role: SpaceRole }>('SELECT group_id, space_slug, role FROM space_group_roles');
  return rows.map((row) => ({ groupId: row.group_id, space: row.space_slug, role: row.role }));
}

// --- last-admin guard ----------------------------------------------------------

/**
 * The admins of `space` as the last-admin guard counts them (spec-access.md
 * §5, §15): every direct `admin` row (as before 053 — a disabled direct admin
 * still counts, unchanged), plus every active (not disabled) member of an
 * active group holding `admin` there. Distinct people. Run on the transaction
 * that made the change, so the count is of the state about to be committed.
 */
export async function countSpaceAdminsOn(client: PoolClient, space: string): Promise<number> {
  const result = await client.query<{ count: string }>(SPACE_ADMINS_COUNT_SQL, [space, null]);
  return Number(result.rows[0]?.count ?? '0');
}

/** Shared with auth/store.ts countSpaceAdmins (`$2` = a user whose DIRECT row is about to change, excluded from the direct part only). */
export const SPACE_ADMINS_COUNT_SQL = `SELECT COUNT(DISTINCT x.user_id) AS count FROM (
    SELECT m.user_id FROM space_members m
     WHERE m.space_slug = $1 AND m.role = 'admin' AND ($2::uuid IS NULL OR m.user_id <> $2::uuid)
    UNION
    SELECT gm.user_id
      FROM space_group_roles r
      JOIN groups g ON g.id = r.group_id AND g.archived_at IS NULL
      JOIN group_members gm ON gm.group_id = r.group_id
      JOIN users u ON u.id = gm.user_id AND NOT u.disabled AND NOT u.is_system
     WHERE r.space_slug = $1 AND r.role = 'admin'
  ) x`;

/** Throws 409 (rolling the caller's transaction back) when any of `spaces` would be left without an admin. */
export async function assertSpacesKeepAdmin(client: PoolClient, spaces: Iterable<string>): Promise<void> {
  for (const space of new Set(spaces)) {
    if ((await countSpaceAdminsOn(client, space)) === 0) throw conflict('cannot remove the last admin of this space');
  }
}
