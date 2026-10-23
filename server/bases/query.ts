/**
 * Answers a base view (Obsidian Bases, 16.10.2026): loads the candidate pages
 * from the page index — ONLY pages the reader may open (accessSql.ts
 * visiblePagesSql, the rules of search and the graph: space membership or an
 * open space, page access, `.agent/**`, no `_templates/**`, no folders) AND the
 * SQL prefilter of the base's filters (sql.ts) — then hands them to the shared
 * engine (shared/bases/engine.ts) for the exact filters, formulas, sort, groups
 * and summaries.
 *
 * Per query: one row query (capped at BASE_SCAN_CAP + 1, by path), one for the
 * rows' tags, one for their links, one for the space's readable page paths
 * (link resolution), plus backlinks / file creation times only when the base
 * reads them. A link to a page the reader may not open is shown as written,
 * never resolved to it (the "closed page looks like a missing one" rule).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BaseConfig, BaseQueryResponse } from '../../shared/bases/types.js';
import { BASE_SCAN_CAP } from '../../shared/bases/types.js';
import { baseReadsFields, pickView, runBase } from '../../shared/bases/engine.js';
import { makeBudget } from '../../shared/bases/evaluate.js';
import { folderDisplay, folderTitleMap } from '../../shared/folderTitles.js';
import { basenameOf, parseWikilinkText, type BaseRowData } from '../../shared/bases/values.js';
import { query } from '../db/pool.js';
import { sqlParam, visiblePagesSql, type PageViewer } from '../accessSql.js';
import { notClosedSql } from '../access/roleSql.js';
import { buildPagePathIndex, resolveWikilinkPath } from '../wikilinks.js';
import { readDeclaredTypes } from '../propertyTypes.js';
import * as storage from '../storage.js';
import { prefilterSql } from './sql.js';

export interface BaseQueryOptions {
  space: string;
  config: BaseConfig;
  viewName?: string;
  viewer: PageViewer;
  /** May the reader edit page properties at all: the space role is editor+ and the token may write. */
  spaceEditor: boolean;
  tokenMayWrite: boolean;
  /** `this`: the base page, or the page a base block is embedded in. */
  thisPageId: string | null;
  offset?: number;
  limit?: number;
  /** Show `file.folder` as the folder page's title (the web app); agents get the path. */
  folderTitles?: boolean;
  /** Tests: a fixed clock. */
  nowMs?: number;
}

interface PageRowSql {
  id: string;
  path: string;
  title: string;
  kind: string;
  file_size: string | number | null;
  file_mtime: Date | string | null;
  updated_at: Date | string;
  frontmatter: Record<string, unknown> | null;
  can_edit: boolean;
}

const ms = (v: Date | string | null): number | null => (v === null ? null : new Date(v).getTime());

function toRowData(r: PageRowSql): BaseRowData {
  return {
    id: r.id,
    path: r.path,
    title: r.title,
    kind: r.kind,
    size: r.file_size === null ? null : Number(r.file_size),
    mtime: ms(r.file_mtime) ?? ms(r.updated_at),
    ctime: null,
    properties: r.frontmatter && typeof r.frontmatter === 'object' ? r.frontmatter : {},
    tags: [],
    links: [],
    linkIds: [],
    embeds: [],
  };
}

/** The SQL for "may this reader edit this page's properties" (pageAccess.effectivePageRole, editor+: owner or editor grant on every restriction of the chain), per row. */
function canEditSql(viewer: PageViewer, params: unknown[], spaceEditor: boolean): string {
  if (viewer.kind !== 'user' || !spaceEditor) return 'false';
  const user = sqlParam(params, viewer.userId);
  return `(p.kind <> 'folder' AND ${notClosedSql('p.id', { user, minRole: 'editor' })})`;
}

const ROW_COLUMNS = 'p.id, p.path, p.title, p.kind, p.file_size, p.file_mtime, p.updated_at, p.frontmatter';

/** Tags and links of `rows` (in place). Links to pages outside `readable` are kept as written. */
async function attachTagsAndLinks(rows: BaseRowData[], readable: Map<string, string>): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const tagRows = await query<{ page_id: string; tag: string }>('SELECT DISTINCT page_id, tag FROM page_tags WHERE page_id = ANY($1::text[]) ORDER BY 1, 2', [ids]);
  for (const t of tagRows) byId.get(t.page_id)?.tags.push(t.tag);
  const linkRows = await query<{ s: string; kind: string; target_path: string; link_path: string; target_page_id: string | null; syntax: string }>(
    `SELECT source_page_id AS s, kind, target_path, link_path, target_page_id, syntax
       FROM page_links
      WHERE source_page_id = ANY($1::text[]) AND kind <> 'external'
      ORDER BY id`,
    [ids],
  );
  for (const l of linkRows) {
    const row = byId.get(l.s);
    if (!row) continue;
    const open = l.target_page_id !== null && readable.has(l.target_page_id);
    const target = l.kind === 'page' ? (open ? (readable.get(l.target_page_id!) ?? l.target_path) : l.link_path) : l.kind === 'asset' ? l.target_path : l.link_path;
    if (!target) continue;
    if (!row.links.includes(target)) row.links.push(target);
    if (open && !row.linkIds!.includes(l.target_page_id!)) row.linkIds!.push(l.target_page_id!);
    if (l.syntax === 'embed' || l.syntax === 'image') row.embeds!.push(target);
  }
}

async function attachBacklinks(rows: BaseRowData[], space: string, viewer: PageViewer): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [rows.map((r) => r.id), space];
  const visible = visiblePagesSql('p', viewer, params, { excludeTemplates: true });
  const back = await query<{ t: string; path: string }>(
    `SELECT DISTINCT l.target_page_id AS t, p.path
       FROM page_links l JOIN pages_index p ON p.id = l.source_page_id
      WHERE l.target_page_id = ANY($1::text[]) AND l.kind = 'page' AND p.space_slug = $2 AND ${visible}
      ORDER BY 2`,
    params,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const b of back) (byId.get(b.t)!.backlinks ??= []).push(b.path);
}

async function attachCtime(rows: BaseRowData[], space: string): Promise<void> {
  const root = storage.getSpaceDir(space);
  await Promise.all(
    rows.map(async (r) => {
      const st = await fs.stat(path.join(root, ...r.path.split('/'))).catch(() => null);
      r.ctime = st ? (st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs) : null;
    }),
  );
}

/** One page's row data (for `this`), when the reader may open it. */
async function loadOne(id: string, viewer: PageViewer): Promise<BaseRowData | null> {
  const params: unknown[] = [id];
  const visible = visiblePagesSql('p', viewer, params);
  const rows = await query<PageRowSql>(`SELECT ${ROW_COLUMNS}, false AS can_edit FROM pages_index p WHERE p.id = $1 AND ${visible}`, params);
  return rows[0] ? toRowData(rows[0]) : null;
}

export async function queryBase(opts: BaseQueryOptions): Promise<BaseQueryResponse> {
  const { config, space, viewer } = opts;
  const view = pickView(config, opts.viewName);

  // The candidates: readable, prefiltered, at most BASE_SCAN_CAP (+1 to know there were more).
  const params: unknown[] = [space];
  const visible = visiblePagesSql('p', viewer, params, { excludeTemplates: true });
  const prefilter = prefilterSql([config.filters, view?.filters], params);
  const canEdit = canEditSql(viewer, params, opts.spaceEditor && opts.tokenMayWrite);
  const cap = sqlParam(params, BASE_SCAN_CAP + 1);
  const sqlRows = await query<PageRowSql>(
    `SELECT ${ROW_COLUMNS}, ${canEdit} AS can_edit
       FROM pages_index p
      WHERE p.space_slug = $1 AND p.kind <> 'folder' AND ${visible} AND ${prefilter}
      ORDER BY p.path
      LIMIT ${cap}`,
    params,
  );
  const truncated = sqlRows.length > BASE_SCAN_CAP;
  const kept = truncated ? sqlRows.slice(0, BASE_SCAN_CAP) : sqlRows;
  const rows = kept.map(toRowData);
  const editable = new Set(kept.filter((r) => r.can_edit).map((r) => r.id));

  // Every page of the space the reader may open: link resolution and `file("…")` / `link.asFile()`.
  const allParams: unknown[] = [space];
  const allVisible = visiblePagesSql('p', viewer, allParams, { excludeTemplates: true });
  const all = await query<{ id: string; path: string; title: string }>(`SELECT p.id, p.path, p.title FROM pages_index p WHERE p.space_slug = $1 AND p.kind <> 'folder' AND ${allVisible}`, allParams);
  const readable = new Map(all.map((r) => [r.id, r.path]));
  const idByPath = new Map(all.map((r) => [r.path, r.id]));
  const pathIndex = buildPagePathIndex(all.map((r) => r.path));
  // The titles of the folders' pages (readable ones; a closed page shows its slug).
  const folderTitles = opts.folderTitles ? folderTitleMap(all) : null;

  await attachTagsAndLinks(rows, readable);
  const extra = baseReadsFields(config, ['backlinks', 'ctime']);
  if (extra.has('backlinks')) await attachBacklinks(rows, space, viewer);
  if (extra.has('ctime')) await attachCtime(rows, space);

  const rowByPath = new Map(rows.map((r) => [r.path, r]));
  const thisRow = opts.thisPageId ? await loadOne(opts.thisPageId, viewer) : null;
  if (thisRow) await attachTagsAndLinks([thisRow], readable);

  const resolvePath = (target: string): string | null => {
    const clean = (parseWikilinkText(target)?.path ?? target).trim();
    if (!clean) return null;
    if (idByPath.has(clean)) return clean;
    return resolveWikilinkPath(pathIndex, '', clean);
  };
  // Pages outside the candidates (a link target): their path-derived fields only.
  const stubs = new Map<string, BaseRowData>();
  const lookupFile = (target: string): BaseRowData | null => {
    const p = resolvePath(target);
    if (!p) return null;
    const hit = rowByPath.get(p) ?? (thisRow?.path === p ? thisRow : undefined);
    if (hit) return hit;
    let stub = stubs.get(p);
    if (!stub) {
      stub = { id: idByPath.get(p)!, path: p, title: basenameOf(p), kind: 'doc', size: null, mtime: null, ctime: null, properties: {}, tags: [], links: [] };
      stubs.set(p, stub);
    }
    return stub;
  };

  const declared = (await readDeclaredTypes(space)).types;
  const dateKeys = new Set(Object.entries(declared).filter(([, t]) => t === 'date' || t === 'datetime').map(([k]) => k));

  const result = runBase({
    config,
    viewName: opts.viewName,
    rows,
    env: { dateKeys, thisRow, lookupFile, nowMs: opts.nowMs ?? Date.now(), budget: makeBudget() },
    canEditRow: (r) => editable.has(r.id),
    folderLabel: folderTitles ? (dir) => (dir === '/' ? null : folderDisplay(dir, folderTitles)) : undefined,
    resolveLink: (target) => {
      const p = resolvePath(target);
      return p ? { path: p, pageId: idByPath.get(p) } : null;
    },
    offset: opts.offset,
    limit: opts.limit,
  });

  // Card covers: a URL or a colour as they are; a link to a file of the space → its /files/ URL.
  const { coverTargets, ...response } = result;
  if (coverTargets) {
    const byRow = new Map(response.rows.map((r) => [r.id, r]));
    const fileTargets = Object.entries(coverTargets).filter(([, t]) => !/^(https?:\/\/|#[0-9a-f]{3,8}$)/i.test(t.trim()));
    const files =
      fileTargets.length > 0
        ? await query<{ path: string }>('SELECT path FROM space_files WHERE space_slug = $1', [space])
        : [];
    const fileIndex = buildPagePathIndex(files.map((f) => f.path));
    for (const [id, raw] of Object.entries(coverTargets)) {
      const t = raw.trim();
      const row = byRow.get(id);
      if (!row) continue;
      if (/^(https?:\/\/|#[0-9a-f]{3,8}$)/i.test(t)) {
        row.cover = t;
        continue;
      }
      const p = fileIndex.paths.has(t) ? t : resolveWikilinkPath(fileIndex, path.posix.dirname(row.path) === '.' ? '' : path.posix.dirname(row.path), t);
      if (p) row.cover = `/files/${encodeURIComponent(space)}/${p.split('/').map(encodeURIComponent).join('/')}`;
    }
  }
  if (truncated) response.warnings.push(`More than ${BASE_SCAN_CAP} pages match; the view covers the first ${BASE_SCAN_CAP} by path. Narrow the filters to see the rest.`);
  return { ...response, truncated };
}
