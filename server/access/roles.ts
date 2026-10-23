/**
 * The one role resolver (TypeScript side). Answers "which role does this
 * person have in this space" and "which role on this page", for one user at a
 * time — session.ts (effectiveRole, membershipsFor, canAdministerSpace,
 * effectivePageRole) and pageAccess.ts are thin wrappers over it.
 *
 * Shape: a LOADER reads the raw sources of a role in one query, a pure
 * RESOLVER combines them. A new source (stage 1: group roles) is one more
 * field in `SpaceRoleSources`, filled by `loadSpaceRoleSources` and combined by
 * `resolveSpaceRole` — and one more branch in roleSql.ts, the SQL twin used by
 * every query that enumerates people or pages. roles.test.ts checks that the
 * two agree on random fixtures.
 */
import { spaceOpenToInstance } from '../../shared/contracts.js';
import type { PageAccessGrantRole, SpaceRole, SpaceVisibility, User } from '../../shared/contracts.js';
import { query } from '../db/pool.js';
import { effectiveRolesSql, restrictionChainSql } from './roleSql.js';

export const ROLE_RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, admin: 2 };

export function roleAtLeast(role: SpaceRole | undefined, min: SpaceRole): boolean {
  return role !== undefined && ROLE_RANK[role] >= ROLE_RANK[min];
}

/** The highest of `roles` (undefined/null entries ignored); undefined when there is none. */
export function maxRole(...roles: Array<SpaceRole | null | undefined>): SpaceRole | undefined {
  let best: SpaceRole | undefined;
  for (const role of roles) if (role && (best === undefined || ROLE_RANK[role] > ROLE_RANK[best])) best = role;
  return best;
}

/** Who is asking: only these three facts of a User matter to the rule. `system` = session.isSystemUser(user). */
export interface RoleSubject {
  id: string;
  disabled: boolean;
  system: boolean;
}

export function roleSubject(user: Pick<User, 'id' | 'disabled'>, system: boolean): RoleSubject {
  return { id: user.id, disabled: user.disabled === true, system };
}

/** Everything a space role is made of, for one (user, space). */
export interface SpaceRoleSources {
  /** undefined = no such space. */
  visibility: SpaceVisibility | undefined;
  /** The user's own `space_members` row. */
  direct: SpaceRole | undefined;
  /** The roles in this space of the groups the user belongs to (archived groups included — the resolver drops them). */
  groups: Array<{ role: SpaceRole; archived: boolean }>;
}

/**
 * The rule, as a pure function (docs/spec-access.md §1–§5): nothing for a
 * disabled user; a system user is only an implicit viewer of a `public` space;
 * everybody else gets the highest of their direct role, the roles of their
 * active (not archived) groups and the implicit viewer of an `instance` /
 * `public` space. No instance-admin bypass, no nested groups.
 */
export function resolveSpaceRole(subject: Pick<RoleSubject, 'disabled' | 'system'>, src: SpaceRoleSources): SpaceRole | undefined {
  if (subject.disabled) return undefined;
  if (subject.system) return src.visibility === 'public' ? 'viewer' : undefined;
  return maxRole(
    src.direct,
    ...src.groups.filter((group) => !group.archived).map((group) => group.role),
    spaceOpenToInstance(src.visibility) ? 'viewer' : undefined,
  );
}

interface SourceRow {
  slug: string;
  visibility: SpaceVisibility;
  direct: SpaceRole | null;
  groups: Array<{ role: SpaceRole; archived: boolean }>;
}

/** The sources for `userId` in `space` (or in every space when `space` is omitted) — one query, the only loader. */
async function loadSpaceRoleSources(userId: string, space?: string): Promise<Map<string, SpaceRoleSources>> {
  const rows = await query<SourceRow>(
    `SELECT s.slug, s.visibility,
            (SELECT m.role FROM space_members m WHERE m.space_slug = s.slug AND m.user_id = $1::uuid) AS direct,
            COALESCE((SELECT json_agg(json_build_object('role', r.role, 'archived', g.archived_at IS NOT NULL))
                        FROM space_group_roles r
                        JOIN groups g ON g.id = r.group_id
                        JOIN group_members gm ON gm.group_id = r.group_id AND gm.user_id = $1::uuid
                       WHERE r.space_slug = s.slug), '[]'::json) AS groups
       FROM spaces s
      WHERE ($2::text IS NULL OR s.slug = $2::text)`,
    [userId, space ?? null],
  );
  return new Map(rows.map((row) => [row.slug, { visibility: row.visibility, direct: row.direct ?? undefined, groups: row.groups }]));
}

const NO_SPACE: SpaceRoleSources = { visibility: undefined, direct: undefined, groups: [] };

/** The effective role of `subject` in `space`; undefined = none (or no such space). */
export async function effectiveSpaceRole(subject: RoleSubject, space: string): Promise<SpaceRole | undefined> {
  if (subject.disabled) return undefined;
  const sources = await loadSpaceRoleSources(subject.id, space);
  return resolveSpaceRole(subject, sources.get(space) ?? NO_SPACE);
}

/** space slug -> effective role, for every space where `subject` has one. */
export async function spaceRolesForUser(subject: RoleSubject): Promise<Record<string, SpaceRole>> {
  if (subject.disabled) return {};
  const out: Record<string, SpaceRole> = {};
  for (const [slug, sources] of await loadSpaceRoleSources(subject.id)) {
    const role = resolveSpaceRole(subject, sources);
    if (role) out[slug] = role;
  }
  return out;
}

/**
 * user id -> effective role, for every PERSON (system accounts excluded) with a
 * role in `space` — page-access candidates, the trash's "active members".
 * Built on roleSql.ts (the set form of the same rule).
 */
export async function spaceMemberRoles(space: string): Promise<Map<string, SpaceRole>> {
  const rows = await query<{ user_id: string; role: SpaceRole }>(
    `SELECT r.user_id, r.role
       FROM (${effectiveRolesSql({ space: '$1' })}) r
       JOIN users u ON u.id = r.user_id
      WHERE NOT u.is_system`,
    [space],
  );
  return new Map(rows.map((row) => [row.user_id, row.role]));
}

// ---------------------------------------------------------------------------
// Page level (docs/spec-access.md §13)
// ---------------------------------------------------------------------------

/** One restricted page of a page's chain (the page itself or a restricted ancestor), as one user sees it. */
export interface PageRestriction {
  pageId: string;
  ownerId: string;
  /** The user's own grant. */
  userGrant?: PageAccessGrantRole;
  /** The grants on this page of the groups the user belongs to; `inSpace` = the group holds a role in the page's space or the space is open to the instance. */
  groupGrants?: Array<{ role: PageAccessGrantRole; archived: boolean; inSpace: boolean }>;
}

/** Everything a page role is made of, for one (user, page), on top of the space role. */
export interface PageRoleSources {
  /**
   * Every restriction the page is under: its own `page_access` row and the rows
   * of its restricted ancestors (access/pageTree.ts — a child of a restricted
   * page is restricted too). Empty = open to the space.
   */
  restrictions: PageRestriction[];
}

/** The role one restriction gives: its owner `editor`, a grantee the highest of their own grant and their active in-space groups' grants, nobody else anything. */
export function restrictionRole(userId: string, rule: PageRestriction): SpaceRole | undefined {
  if (rule.ownerId === userId) return 'editor';
  const groupGrants = (rule.groupGrants ?? []).filter((grant) => !grant.archived && grant.inSpace).map((grant) => grant.role);
  return maxRole(rule.userGrant, ...groupGrants);
}

/**
 * Pure: nothing without a space role (a page ACL only narrows); a page under
 * no restriction is the space role; otherwise the LOWEST of the roles each
 * restriction on the chain gives (restrictionRole) — one restriction the user
 * does not pass hides the page, a viewer grant anywhere on the chain makes it
 * read-only. Restrictions intersect: a child can narrow its parent's audience,
 * never widen it. As before stage 7 the page role is not capped by the space
 * role (a page `editor` grant lets a space viewer edit that page), and there
 * is no space-admin bypass. `.agent/**` is decided by the caller
 * (session.effectivePageRole), before this.
 */
export function resolvePageRole(userId: string, spaceRole: SpaceRole | undefined, src: PageRoleSources): SpaceRole | undefined {
  if (!spaceRole) return undefined;
  if (src.restrictions.length === 0) return spaceRole;
  let lowest: SpaceRole | undefined;
  for (const rule of src.restrictions) {
    const role = restrictionRole(userId, rule);
    if (!role) return undefined;
    if (lowest === undefined || ROLE_RANK[role] < ROLE_RANK[lowest]) lowest = role;
  }
  return lowest;
}

/** The restrictions page `$1` is under (roleSql.ts restrictionChainSql). */
const CHAIN_SQL = restrictionChainSql('$1');

/** The page-level sources for `userId` on page `pageId` — one query, the only loader. */
export async function loadPageRoleSources(userId: string, pageId: string): Promise<PageRoleSources> {
  const rows = await query<{
    page_id: string;
    owner_id: string;
    user_grant: PageAccessGrantRole | null;
    group_grants: NonNullable<PageRestriction['groupGrants']>;
  }>(
    `SELECT c.page_id, c.owner_id,
            (SELECT g.role FROM page_access_grants g WHERE g.page_id = c.page_id AND g.user_id = $2::uuid) AS user_grant,
            COALESCE((SELECT json_agg(json_build_object(
                               'role', g.role,
                               'archived', grp.archived_at IS NOT NULL,
                               'inSpace', EXISTS (SELECT 1 FROM space_group_roles r WHERE r.space_slug = p.space_slug AND r.group_id = g.group_id)
                                          OR sp.visibility IN ('instance', 'public')))
                        FROM page_access_grants g
                        JOIN groups grp ON grp.id = g.group_id
                        JOIN group_members gm ON gm.group_id = g.group_id AND gm.user_id = $2::uuid
                       WHERE g.page_id = c.page_id), '[]'::json) AS group_grants
       FROM (${CHAIN_SQL}) c
       JOIN pages_index p ON p.id = c.page_id
       JOIN spaces sp ON sp.slug = p.space_slug`,
    [pageId, userId],
  );
  return {
    restrictions: rows.map((row) => ({
      pageId: row.page_id,
      ownerId: row.owner_id,
      ...(row.user_grant ? { userGrant: row.user_grant } : {}),
      groupGrants: row.group_grants,
    })),
  };
}

/** The restricted pages a page is under (its own rule included), root-most first — for the access dialog. */
export async function restrictionChain(pageId: string): Promise<Array<{ pageId: string; ownerId: string; title: string; path: string }>> {
  const rows = await query<{ page_id: string; owner_id: string; title: string; path: string }>(`SELECT * FROM (${CHAIN_SQL}) c ORDER BY length(path), path`, [pageId]);
  return rows.map((row) => ({ pageId: row.page_id, ownerId: row.owner_id, title: row.title, path: row.path }));
}

/**
 * The page role of every one of `members` (people with their space role) on
 * page `pageId`, by the same pure resolvePageRole — the access dialog's
 * effective audience. Three queries whatever the number of people.
 */
export async function pageRolesFor(
  pageId: string,
  members: ReadonlyArray<{ userId: string; spaceRole: SpaceRole }>,
  /** `ownRuleOnly`: the rule before stage 7 (the page's own restriction alone) — for server/tools/access-inherit-report.ts. */
  options: { ownRuleOnly?: boolean } = {},
): Promise<Map<string, SpaceRole>> {
  const chain = (await query<{ page_id: string; owner_id: string }>(`SELECT c.page_id, c.owner_id FROM (${CHAIN_SQL}) c`, [pageId])).filter(
    (rule) => !options.ownRuleOnly || rule.page_id === pageId,
  );
  const out = new Map<string, SpaceRole>();
  if (chain.length === 0) {
    for (const member of members) out.set(member.userId, member.spaceRole);
    return out;
  }
  const ruleIds = chain.map((rule) => rule.page_id);
  const grants = await query<{ page_id: string; user_id: string | null; group_id: string | null; role: PageAccessGrantRole; archived: boolean; in_space: boolean }>(
    `SELECT g.page_id, g.user_id, g.group_id, g.role, grp.archived_at IS NOT NULL AS archived,
            (g.group_id IS NOT NULL AND (EXISTS (SELECT 1 FROM space_group_roles r WHERE r.space_slug = p.space_slug AND r.group_id = g.group_id)
                                         OR sp.visibility IN ('instance', 'public'))) AS in_space
       FROM page_access_grants g
       JOIN pages_index p ON p.id = g.page_id
       JOIN spaces sp ON sp.slug = p.space_slug
       LEFT JOIN groups grp ON grp.id = g.group_id
      WHERE g.page_id = ANY($1::text[])`,
    [ruleIds],
  );
  const groupIds = [...new Set(grants.flatMap((grant) => (grant.group_id ? [grant.group_id] : [])))];
  const memberships = groupIds.length
    ? await query<{ group_id: string; user_id: string }>('SELECT group_id, user_id FROM group_members WHERE group_id = ANY($1::uuid[])', [groupIds])
    : [];
  const groupsOf = new Map<string, Set<string>>();
  for (const row of memberships) {
    const set = groupsOf.get(row.user_id) ?? new Set<string>();
    set.add(row.group_id);
    groupsOf.set(row.user_id, set);
  }
  for (const member of members) {
    const mine = groupsOf.get(member.userId) ?? new Set<string>();
    const restrictions: PageRestriction[] = chain.map((rule) => {
      const own = grants.find((grant) => grant.page_id === rule.page_id && grant.user_id === member.userId);
      return {
        pageId: rule.page_id,
        ownerId: rule.owner_id,
        ...(own ? { userGrant: own.role } : {}),
        groupGrants: grants
          .filter((grant) => grant.page_id === rule.page_id && grant.group_id !== null && mine.has(grant.group_id))
          .map((grant) => ({ role: grant.role, archived: grant.archived, inSpace: grant.in_space })),
      };
    });
    const role = resolvePageRole(member.userId, member.spaceRole, { restrictions });
    if (role) out.set(member.userId, role);
  }
  return out;
}
