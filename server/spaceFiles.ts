/**
 * The files of a space (Obsidian brief, wave 3; migration 043): every regular
 * file under the content root that is not a page — `assets/`, attachments kept
 * next to notes, any other file — indexed AS A FILE in `space_files`. Never a
 * page kind, never in the tree or the search.
 *
 * Who writes the table:
 *  - the scan (storage.ts scanSpace) walks the working tree anyway; it hands the
 *    files it met to syncScannedFiles, which mirrors them incrementally (a row
 *    whose mtime and size did not change is not written) and deletes the rows
 *    of files that are gone;
 *  - a repo-mode upload (storage.ts saveAssetIntoRepo) records its new file at
 *    once (recordFile), so the embed the editor inserts next resolves without
 *    waiting for a rescan.
 * What the scan never hands over: dotfiles and everything under a dot folder
 * (`.git/`, `.folio/`, `.obsidian/`, `.agent/`), `*.folio` metadata files, the
 * space's scan-ignore list, symlinks, and files that are pages (outside
 * `assets/` — a `.md` inside `assets/` is a file, not a page, as before).
 *
 * Who reads it: the link resolver (indexV2/store.ts resolveLinks, rules in
 * indexV2/resolve.ts) — a non-page link or embed target that exists here is
 * kind 'asset' with target_path = the file's path, one that does not is
 * 'unresolved' — and GET /api/spaces/:space/files (spaceFilesRoutes.ts).
 *
 * Listing ACL: viewer+ on the space; a file whose every referencing page is
 * hidden from the caller is left out (the same rule fileAccess.ts serves the
 * bytes by: "a session user may read such a file unless every page referencing
 * it is hidden from them"), and `referencedBy` counts only the source pages the
 * caller may read (accessSql.ts visiblePagesSql, `_templates/` excluded like
 * every other index read).
 */
import fs from 'node:fs/promises';
import type { SpaceFileInfo, SpaceFilesResponse } from '../shared/contracts.js';
import { sqlParam, visiblePagesSql, type PageViewer } from './accessSql.js';
import { query, queryOne } from './db/pool.js';
import * as pageIndex from './indexV2/store.js';

export interface ScannedFile {
  /** POSIX path relative to the content root. */
  path: string;
  size: number;
  mtime: Date;
}

export interface FilesSyncResult {
  /** Paths that were not indexed before (links that could mean them are re-resolved). */
  added: string[];
  /** Paths whose file is gone. */
  removed: string[];
  /** Paths whose size or mtime changed. */
  changed: number;
  /** Files indexed for the space after the sync. */
  total: number;
}

/** Rows per INSERT … SELECT FROM unnest. */
const WRITE_CHUNK = 1000;

/** Postgres text cannot hold NUL; such a name is not indexed at all. */
function storable(p: string): boolean {
  return !p.includes('\u0000');
}

/** True for a path the files index never holds: a dot segment anywhere, a `*.folio` metadata file. */
export function isUnlistedFilePath(relPath: string): boolean {
  const segments = relPath.split('/');
  if (segments.some((s) => s === '' || s.startsWith('.'))) return true;
  return segments[segments.length - 1].toLowerCase().endsWith('.folio');
}

async function upsertRows(space: string, rows: ScannedFile[]): Promise<void> {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    await query(
      `INSERT INTO space_files (space_slug, path, size, mtime)
       SELECT $1, * FROM unnest($2::text[], $3::bigint[], $4::timestamptz[])
       ON CONFLICT (space_slug, path) DO UPDATE SET size = EXCLUDED.size, mtime = EXCLUDED.mtime, sha256 = NULL`,
      [space, chunk.map((r) => r.path), chunk.map((r) => r.size), chunk.map((r) => r.mtime)],
    );
  }
}

/**
 * Mirrors the files one scan met into `space_files`: new and changed rows are
 * written, unchanged ones are not, rows of files that are gone are deleted.
 * `files` must be EVERY non-page file of the space (the scan's whole walk).
 */
export async function syncScannedFiles(space: string, files: readonly ScannedFile[]): Promise<FilesSyncResult> {
  const existing = await query<{ path: string; size: string; mtime: Date }>('SELECT path, size, mtime FROM space_files WHERE space_slug = $1', [space]);
  const known = new Map(existing.map((r) => [r.path, r]));
  const seen = new Set<string>();
  const write: ScannedFile[] = [];
  const added: string[] = [];
  let changed = 0;
  for (const file of files) {
    if (!storable(file.path) || isUnlistedFilePath(file.path) || seen.has(file.path)) continue;
    seen.add(file.path);
    const row = known.get(file.path);
    if (!row) {
      added.push(file.path);
      write.push(file);
    } else if (Number(row.size) !== file.size || new Date(row.mtime).getTime() !== file.mtime.getTime()) {
      changed++;
      write.push(file);
    }
  }
  const removed = existing.map((r) => r.path).filter((p) => !seen.has(p));
  if (write.length > 0) await upsertRows(space, write);
  for (let i = 0; i < removed.length; i += WRITE_CHUNK) {
    await query('DELETE FROM space_files WHERE space_slug = $1 AND path = ANY($2::text[])', [space, removed.slice(i, i + WRITE_CHUNK)]);
  }
  return { added, removed, changed, total: seen.size };
}

/**
 * One file written outside a scan (a repo-mode upload): indexed now, and the
 * links that could mean it re-resolved. Best effort — the next scan corrects
 * whatever this misses; never throws.
 */
export async function recordFile(space: string, relPath: string, abs: string): Promise<void> {
  try {
    if (!storable(relPath) || isUnlistedFilePath(relPath)) return;
    const st = await fs.lstat(abs).catch(() => null);
    if (!st || !st.isFile()) return;
    await upsertRows(space, [{ path: relPath, size: st.size, mtime: st.mtime }]);
    await pageIndex.resolveLinks(space, { changedPaths: [relPath] });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[files] could not index ${space}/${relPath}:`, err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/spaces/:space/files
// ---------------------------------------------------------------------------

export const FILES_DEFAULT_LIMIT = 100;
export const FILES_MAX_LIMIT = 500;

/** `?limit=` -> 1..500, default 100. */
export function clampFilesLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return FILES_DEFAULT_LIMIT;
  return Math.min(FILES_MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/** `?prefix=` names a folder: `assets`, `assets/` and `/assets/` all mean "under assets/". Empty: the whole space. */
export function normalizeFilesPrefix(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (!trimmed) return '';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

export interface ListFilesOptions {
  prefix: string;
  q: string;
  limit: number;
  offset: number;
}

/** The asset links into `f.path` from pages of the space; `visible` narrows the sources. */
function referencingSources(visible: string | null): string {
  return `SELECT 1 FROM page_links l JOIN pages_index s ON s.id = l.source_page_id
           WHERE l.kind = 'asset' AND l.target_path = f.path AND s.space_slug = f.space_slug${visible ? ` AND ${visible}` : ''}`;
}

export async function listSpaceFiles(space: string, viewer: PageViewer, options: ListFilesOptions): Promise<SpaceFilesResponse> {
  const params: unknown[] = [space];
  const conditions = [`f.space_slug = $1`, `f.path !~ '(^|/)\\.'`];
  const prefix = normalizeFilesPrefix(options.prefix);
  if (prefix) conditions.push(`left(f.path, length(${sqlParam(params, prefix)})) = $${params.length}`);
  const q = options.q.trim();
  if (q) conditions.push(`strpos(lower(f.path), lower(${sqlParam(params, q)})) > 0`);
  // A file only hidden pages reference is hidden too (fileAccess.ts would not serve it to this caller either).
  const anyVisible = visiblePagesSql('s', viewer, params);
  conditions.push(`(NOT EXISTS (${referencingSources(null)}) OR EXISTS (${referencingSources(anyVisible)}))`);
  const where = conditions.join(' AND ');

  const total = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM space_files f WHERE ${where}`, params);

  const listParams = [...params];
  const counted = visiblePagesSql('s', viewer, listParams, { excludeTemplates: true });
  const limit = sqlParam(listParams, options.limit);
  const offset = sqlParam(listParams, options.offset);
  const rows = await query<{ path: string; size: string; mtime: Date; referenced_by: number }>(
    `SELECT f.path, f.size, f.mtime,
            (SELECT COUNT(DISTINCT s.id)::int FROM page_links l JOIN pages_index s ON s.id = l.source_page_id
              WHERE l.kind = 'asset' AND l.target_path = f.path AND s.space_slug = f.space_slug AND ${counted}) AS referenced_by
       FROM space_files f
      WHERE ${where}
      ORDER BY f.path
      LIMIT ${limit} OFFSET ${offset}`,
    listParams,
  );
  const files: SpaceFileInfo[] = rows.map((r) => ({
    path: r.path,
    size: Number(r.size),
    updatedAt: new Date(r.mtime).toISOString(),
    referencedBy: r.referenced_by,
  }));
  return { files, total: total?.n ?? 0 };
}
