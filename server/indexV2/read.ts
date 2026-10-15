/**
 * Reads of the page index (index v2, Obsidian brief wave 1b) for REST and MCP.
 * Every query filters with accessSql.ts's visiblePagesSql IN SQL — the same
 * rules as search — so a page the caller may not read is never returned, never
 * counted, and never named through a link:
 *  - backlinks, tags, unresolved links and orphans count only SOURCE pages the
 *    caller may read; `_templates/` sources are left out (a template is not
 *    content);
 *  - an outbound link whose target page the caller may not read is reported the
 *    way a missing page is (kind 'unresolved', no id, no fragment check, the
 *    path as written) — the MCP "page not found" rule: a closed page and a page
 *    that does not exist look the same.
 */
import type {
  BacklinkContext,
  LinkFragmentKind,
  LinkKind,
  LinkSyntax,
  OrphanPage,
  PageHeading,
  PageLinkRef,
  PageMeta,
  PageMetadata,
  PageTagRef,
  SpaceTag,
  UnresolvedLinksResponse,
} from '../../shared/contracts.js';
import { query, queryOne } from '../db/pool.js';
import { sqlParam, visiblePagesSql, type PageViewer } from '../accessSql.js';
import { isWikiSyntax, unresolvedWikiPath } from './resolve.js';

const ORDER_SENTINEL = Number.MAX_SAFE_INTEGER;

export const UNRESOLVED_DEFAULT_LIMIT = 100;
export const UNRESOLVED_MAX_LIMIT = 500;

/** `?limit=` / the MCP argument -> 1..500, default 100. */
export function clampUnresolvedLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return UNRESOLVED_DEFAULT_LIMIT;
  return Math.min(UNRESOLVED_MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/** `?offset=` -> a non-negative integer, default 0. */
export function clampOffset(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export type VisibleBacklink = PageMeta & BacklinkContext;

interface BacklinkRow {
  id: string;
  space_slug: string;
  path: string;
  kind: PageMeta['kind'];
  title: string;
  sort_order: number | null;
  status: string | null;
  updated_at: string;
  syntax: LinkSyntax;
  fragment: string | null;
  line: number;
  context: string;
}

/**
 * GET /api/pages/:id/backlinks and MCP get_backlinks: one entry per resolved
 * page link INTO `targetPageId` from a source the viewer may read — the page's
 * usual meta plus where the link is (syntax, fragment, line, context). A page
 * linking twice appears twice (clients dedupe by id); sorted by title, path, line.
 */
export async function getVisibleBacklinks(targetPageId: string, viewer: PageViewer): Promise<VisibleBacklink[]> {
  const params: unknown[] = [targetPageId];
  const visible = visiblePagesSql('p', viewer, params, { excludeTemplates: true });
  const rows = await query<BacklinkRow>(
    `SELECT p.id, p.space_slug, p.path, p.kind, p.title, p.sort_order, p.status, p.updated_at,
            l.syntax, l.fragment, l.line, l.context
       FROM page_links l
       JOIN pages_index p ON p.id = l.source_page_id
      WHERE l.target_page_id = $1 AND l.kind = 'page' AND ${visible}
      ORDER BY p.title, p.path, l.line, l.id`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    space: r.space_slug,
    path: r.path,
    kind: r.kind,
    title: r.title,
    order: r.sort_order ?? ORDER_SENTINEL,
    status: (r.status ?? 'published') as PageMeta['status'],
    updatedAt: new Date(r.updated_at).toISOString(),
    syntax: r.syntax,
    fragment: r.fragment,
    line: r.line,
    context: r.context,
  }));
}

interface LinkRow {
  target_path: string;
  link_path: string;
  target_page_id: string | null;
  syntax: LinkSyntax;
  kind: LinkKind;
  fragment: string | null;
  fragment_kind: LinkFragmentKind | null;
  fragment_resolved: boolean | null;
  display_text: string | null;
  line: number;
  context: string;
  target_visible: boolean;
}

/**
 * The typed outbound links of a page, for what `viewer` may read (the route checks the page itself). A target the
 * viewer cannot read is reported like a missing one — kind 'unresolved', no id, no fragment check, the path as
 * written. Used by GET /api/pages/:id/meta (inside PageMetadata) and by the public site's /links route, which
 * sends ONLY this.
 */
export async function getPageLinks(pageId: string, viewer: PageViewer): Promise<PageLinkRef[]> {
  const linkParams: unknown[] = [pageId];
  // A link target is "seen" by the same rules as any page, templates included (a link to one is a real link).
  const targetVisible = visiblePagesSql('t', viewer, linkParams);
  const linkRows = await query<LinkRow>(
    `SELECT l.target_path, l.link_path, l.target_page_id, l.syntax, l.kind, l.fragment, l.fragment_kind, l.fragment_resolved,
            l.display_text, l.line, l.context,
            (t.id IS NOT NULL AND ${targetVisible}) AS target_visible
       FROM page_links l
       LEFT JOIN pages_index t ON t.id = l.target_page_id
      WHERE l.source_page_id = $1
      ORDER BY l.line, l.id`,
    linkParams,
  );
  const links: PageLinkRef[] = linkRows.map((l) => {
    const hidden = l.kind === 'page' && !l.target_visible;
    return {
      // The path as written is not a leak, even for a target the caller cannot read; the reading view matches wikilinks by it.
      linkPath: l.link_path,
      targetPath: hidden && isWikiSyntax(l.syntax) ? unresolvedWikiPath(l.link_path) : l.target_path,
      targetPageId: hidden ? null : l.target_page_id,
      syntax: l.syntax,
      kind: hidden ? 'unresolved' : l.kind,
      fragment: l.fragment,
      fragmentKind: l.fragment_kind,
      fragmentResolved: hidden ? null : l.fragment_resolved,
      displayText: l.display_text,
      line: l.line,
      context: l.context,
    };
  });
  return links;
}

/** GET /api/pages/:id/meta and MCP get_page_metadata, for a page the caller may already read (the route checks). */
export async function getPageMetadata(page: { id: string; space: string; relPath: string; title: string }, viewer: PageViewer): Promise<PageMetadata> {
  const row = await queryOne<{ frontmatter: Record<string, unknown> | null; meta_version: number }>('SELECT frontmatter, meta_version FROM pages_index WHERE id = $1', [page.id]);
  const headings = await query<PageHeading>('SELECT level, text, slug, line FROM page_headings WHERE page_id = $1 ORDER BY position', [page.id]);
  const blocks = await query<{ blockId: string; line: number }>('SELECT block_id AS "blockId", line FROM page_blocks WHERE page_id = $1 ORDER BY line, block_id', [page.id]);
  const tags = await query<PageTagRef>(`SELECT tag, source, line FROM page_tags WHERE page_id = $1 ORDER BY (source = 'body'), line NULLS FIRST, tag`, [page.id]);

  const links = await getPageLinks(page.id, viewer);

  const countParams: unknown[] = [page.id];
  const sourceVisible = visiblePagesSql('s', viewer, countParams, { excludeTemplates: true });
  const count = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM page_links l JOIN pages_index s ON s.id = l.source_page_id
      WHERE l.target_page_id = $1 AND l.kind = 'page' AND ${sourceVisible}`,
    countParams,
  );

  return {
    id: page.id,
    space: page.space,
    path: page.relPath,
    title: page.title,
    headings,
    blocks,
    tags,
    properties: row?.frontmatter ?? {},
    links,
    backlinkCount: count?.n ?? 0,
    metaVersion: row?.meta_version ?? 0,
  };
}

/** GET /api/spaces/:space/tags: every tag on a page the caller may read, with the number of such pages; by tag. */
export async function listSpaceTags(space: string, viewer: PageViewer): Promise<SpaceTag[]> {
  const params: unknown[] = [space];
  const visible = visiblePagesSql('p', viewer, params, { excludeTemplates: true });
  return query<SpaceTag>(
    `SELECT t.tag, COUNT(DISTINCT t.page_id)::int AS pages
       FROM page_tags t
       JOIN pages_index p ON p.id = t.page_id
      WHERE p.space_slug = $1 AND ${visible}
      GROUP BY t.tag
      ORDER BY t.tag`,
    params,
  );
}

/** GET /api/spaces/:space/unresolved-links: links to nothing, from sources the caller may read; by target path, then source path. */
export async function listUnresolvedLinks(space: string, viewer: PageViewer, page: { limit: number; offset: number }): Promise<UnresolvedLinksResponse> {
  const params: unknown[] = [space];
  const visible = visiblePagesSql('p', viewer, params, { excludeTemplates: true });
  const from = `FROM page_links l JOIN pages_index p ON p.id = l.source_page_id WHERE p.space_slug = $1 AND l.kind = 'unresolved' AND ${visible}`;
  const total = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n ${from}`, params);
  const listParams = [...params];
  const limit = sqlParam(listParams, page.limit);
  const offset = sqlParam(listParams, page.offset);
  const rows = await query<{
    source_id: string;
    source_path: string;
    source_title: string;
    target_path: string;
    syntax: LinkSyntax;
    fragment: string | null;
    line: number;
    context: string;
  }>(
    `SELECT p.id AS source_id, p.path AS source_path, p.title AS source_title, l.target_path, l.syntax, l.fragment, l.line, l.context
       ${from}
      ORDER BY l.target_path, p.path, l.line, l.id
      LIMIT ${limit} OFFSET ${offset}`,
    listParams,
  );
  return {
    links: rows.map((r) => ({
      sourceId: r.source_id,
      sourcePath: r.source_path,
      sourceTitle: r.source_title,
      targetPath: r.target_path,
      syntax: r.syntax,
      fragment: r.fragment,
      line: r.line,
      context: r.context,
    })),
    total: total?.n ?? 0,
  };
}

/**
 * GET /api/spaces/:space/orphans: pages the caller may read that no page they
 * may read links to (a page's links to itself do not count) — except the space
 * index page, `_templates/` and `.agent/`. By path.
 */
export async function listOrphans(space: string, viewer: PageViewer): Promise<OrphanPage[]> {
  const params: unknown[] = [space];
  const visible = visiblePagesSql('p', viewer, params, { excludeTemplates: true });
  const sourceVisible = visiblePagesSql('s', viewer, params, { excludeTemplates: true });
  const rows = await query<{ id: string; path: string; title: string; updated_at: string }>(
    `SELECT p.id, p.path, p.title, p.updated_at
       FROM pages_index p
      WHERE p.space_slug = $1 AND ${visible}
        AND NOT (p.path = '.agent' OR substr(p.path, 1, 7) = '.agent/')
        AND NOT (p.is_index AND strpos(p.path, '/') = 0)
        AND NOT EXISTS (
          SELECT 1 FROM page_links l JOIN pages_index s ON s.id = l.source_page_id
           WHERE l.target_page_id = p.id AND l.kind = 'page' AND s.id <> p.id AND ${sourceVisible}
        )
      ORDER BY p.path`,
    params,
  );
  return rows.map((r) => ({ id: r.id, path: r.path, title: r.title, updatedAt: new Date(r.updated_at).toISOString() }));
}
