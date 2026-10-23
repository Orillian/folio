/**
 * The one SQL fragment for "which pages may this caller read" — search's
 * in-query ACL (round 27), extracted so every list-shaped read filters in SQL,
 * never by a post-filter: search, backlinks, and the page index reads
 * (indexV2/read.ts: page metadata, tags, unresolved links, orphans). A row
 * that is not visible is never ranked, counted or returned, so a count cannot
 * reveal a closed page either.
 *
 * A signed-in caller (or PAT) reads a page when ALL hold:
 *  - the space: the caller has a role there (access/roleSql.ts — the one SQL
 *    form of auth/session.ts effectiveRole; no instance-admin bypass);
 *  - page access: no restriction on the page's chain closes it to the caller —
 *    the page's own `page_access` row and those of its restricted ancestors
 *    (a child of a restricted page is restricted too), each passed by owning
 *    it or holding a grant (roleSql.ts closedPagesSql; pageAccess.ts
 *    effectivePageRole is the TypeScript twin);
 *  - `.agent/**` only for an instance admin or an admin of the space
 *    (session.ts canAdministerSpace; agentPath.ts isAgentPath);
 *  - with `excludeTemplates`, nothing under `_templates/` (storage.ts
 *    isUnderTemplates) — the index reads hide templates; search keeps them.
 * Disabled users never get here (the session is refused); callers that take a
 * bare user (MCP) check `disabled` themselves.
 *
 * The public-site reader (an anonymous visitor, McpActor.publicSpace) reads the
 * public page set of ONE published space: no restricted page (nor any page
 * below one), no `.agent/**`,
 * no `_templates/` (publicSites.ts publicReadablePageIds / isPublicPage).
 */

import { notClosedSql, spacesWithRoleSql } from './access/roleSql.js';

export type PageViewer =
  | { kind: 'user'; userId: string; isInstanceAdmin: boolean }
  | { kind: 'public'; space: string };

export interface VisiblePagesOptions {
  /** Also hide `_templates/**` (always hidden for the public reader). */
  excludeTemplates?: boolean;
}

/** The viewer for a signed-in user (REST session / PAT, MCP actor without a public space). */
export function userViewer(user: { id: string; isAdmin?: boolean }): PageViewer {
  return { kind: 'user', userId: user.id, isInstanceAdmin: user.isAdmin === true };
}

/** Adds `value` to `params` and returns its `$n` placeholder. */
export function sqlParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

/**
 * A SQL condition (to AND into a WHERE) that is true for the `pages_index` rows
 * aliased `alias` which `viewer` may read. Its parameters are appended to
 * `params` and referenced by position, so the caller builds the rest of its
 * query around them.
 */
export function visiblePagesSql(alias: string, viewer: PageViewer, params: unknown[], options: VisiblePagesOptions = {}): string {
  const p = alias;
  // Mirrors storage.isUnderTemplates (can't call it from SQL) — keep in sync.
  const notTemplate = `NOT (${p}.path = '_templates' OR substr(${p}.path, 1, 11) = '_templates/')`;
  if (viewer.kind === 'public') {
    const space = sqlParam(params, viewer.space);
    return `(${p}.space_slug = ${space}
        AND EXISTS (SELECT 1 FROM spaces acl_sp WHERE acl_sp.slug = ${p}.space_slug AND acl_sp.visibility = 'public')
        AND ${notClosedSql(`${p}.id`, { space })}
        -- Mirrors agentPath.ts's isAgentPath (can't call it from SQL) — keep in sync.
        AND NOT (${p}.path = '.agent' OR substr(${p}.path, 1, 7) = '.agent/')
        AND ${notTemplate})`;
  }
  const user = sqlParam(params, viewer.userId);
  const admin = sqlParam(params, viewer.isInstanceAdmin);
  // The space gate and the space-admin test are access/roleSql.ts's rule. `= ANY (ARRAY(...))` makes each an InitPlan:
  // evaluated once per query, never turned into a join that would reorder the caller's plan.
  return `(
        ${p}.space_slug = ANY (ARRAY(${spacesWithRoleSql(user)}))
        AND ${notClosedSql(`${p}.id`, { user })}
        AND (
          -- Mirrors agentPath.ts's isAgentPath (can't call it from SQL) — keep both in sync.
          NOT (${p}.path = '.agent' OR ${p}.path LIKE '.agent/%')
          OR ${admin}::boolean
          OR ${p}.space_slug = ANY (ARRAY(${spacesWithRoleSql(user, 'admin')}))
        )${options.excludeTemplates ? `\n        AND ${notTemplate}` : ''}
      )`;
}
