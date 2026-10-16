/**
 * Writes of the page index (index v2, Obsidian brief wave 1b) — the two phases.
 *
 * PHASE 1, indexPageMeta(page, body, frontmatter): parse one document
 * (parse.ts) and replace its derived rows — page_headings, page_blocks,
 * page_tags, page_links — plus pages_index.frontmatter and meta_version, in one
 * transaction. Links are written RAW: kind provisional ('external' / 'asset' /
 * 'unresolved', never 'page'), no target_page_id. Called by storage.ts for
 * every document the scan reads and on every save (patchEntryContent).
 *
 * PHASE 2, resolveLinks(space, scope): set-based resolution for a space. It
 * loads the link rows in scope, the pages they could mean and the space's
 * files they could mean (`space_files`, wave 3) in one query each, classifies
 * them in memory with resolve.ts (the md rules and the wikilink rules,
 * nearest-folder included, which SQL cannot express; a non-page target is
 * 'asset' only when its file exists, else 'unresolved'), writes
 * back only the rows that changed in one UPDATE … FROM unnest, then sets
 * fragment_resolved in one UPDATE (heading slug / block id joins), and emits
 * `pg_notify('folio_index_resolved', {schema, space})` (no consumer yet).
 *   - scope 'all': every non-external link of the space. After a big scan,
 *     after a rename/move once its rewriters ran (collab.ts), and whenever the
 *     cheap scope would be too wide.
 *   - scope { sourceIds, changedPaths, targetIds }: the links OF the given
 *     pages; the links whose target could be one of `changedPaths` (pages or
 *     files that appeared, moved or went away — matched by file name, its
 *     stem, its folder for an index page, and their percent-encoded spellings); links
 *     whose target page row is gone (FK SET NULL); and the fragments of links
 *     INTO `targetIds` (their headings/blocks may have changed).
 * A deleted target therefore keeps its inbound rows: SET NULL, then 'unresolved'
 * here; a page that appears (created, restored from the trash, synced in)
 * resolves the links waiting for it.
 *
 * App links (16.10.2026: `/s/<space>/p/<id>`, the space home, a folder route —
 * resolve.ts parseAppLink) name their page by id or route, in ANY space: the
 * pages they name are loaded by id across spaces (loadAppPages), a page of
 * another space is recorded with its route as target_path. Every resolution of
 * a space retries its unresolved app links; a page of ANOTHER space deleted or
 * restored is noticed at this space's next resolution (its rows keep pointing at
 * nothing meanwhile: FK SET NULL, read as unresolved).
 */
import type { CanvasDocument, LinkKind } from '../../shared/contracts.js';
import { INDEX_META_VERSION } from '../../shared/contracts.js';
import { query, withTransaction } from '../db/pool.js';
import { timeSlicer } from '../markdownAst.js';
import { instanceHost } from '../publicUrl.js';
import { buildPagePathIndex, wikilinkBasenames } from '../wikilinks.js';
import { parseCanvasMeta, parsePageMetaAsync, type ParsedPageMeta } from './parse.js';
import {
  APP_LINK_SHAPE,
  appDirCandidates,
  appFilesPath,
  classifyLinkTarget,
  fileLinkCandidates,
  isWikiSyntax,
  markdownLinkCandidates,
  NO_PAGES,
  parseAppLink,
  resolveRelative,
  type AppLinkRef,
  type AppPageLookup,
  type FileLookup,
  type PageLookup,
} from './resolve.js';

export const INDEX_RESOLVED_CHANNEL = 'folio_index_resolved';

/** Above this many changed paths a scan resolves the whole space instead of the matching links. */
export const SCOPED_RESOLVE_MAX_PATHS = 200;

function posixParent(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** Postgres text cannot hold NUL. */
function clean(s: string): string;
function clean(s: string | null): string | null;
function clean(s: string | null): string | null {
  return s === null || !s.includes('\u0000') ? s : s.replace(/\u0000/g, '');
}

/** The front matter as jsonb text: JSON-safe (dates become ISO strings), never failing the index over an odd value. */
function frontmatterJson(frontmatter: Record<string, unknown> | null | undefined): string {
  if (!frontmatter) return '{}';
  try {
    return JSON.stringify(frontmatter).replace(/\\u0000/g, '');
  } catch {
    return '{}';
  }
}

export interface IndexedPage {
  id: string;
  space: string;
  relPath: string;
}

/**
 * Phase 1 for one document: parses `body` (front matter removed) and replaces
 * its rows. Returns the parse (tests and callers that want it). Does NOT
 * resolve — call resolveLinks next.
 */
export async function indexPageMeta(page: IndexedPage, body: string, frontmatter: Record<string, unknown> | null | undefined): Promise<ParsedPageMeta> {
  return writePageMeta(page, await parsePageMetaAsync(body, frontmatter), frontmatter);
}

/** Phase 1 for a canvas page: its file cards, the links and tags of its text cards (parse.ts parseCanvasMeta). */
export async function indexCanvasMeta(page: IndexedPage, doc: CanvasDocument, frontmatter: Record<string, unknown> | null | undefined): Promise<ParsedPageMeta> {
  return writePageMeta(page, parseCanvasMeta(doc, frontmatter), frontmatter);
}

async function writePageMeta(page: IndexedPage, meta: ParsedPageMeta, frontmatter: Record<string, unknown> | null | undefined): Promise<ParsedPageMeta> {
  const sourceDir = posixParent(page.relPath);
  // No pages and no files known yet: the kinds are provisional (phase 2 settles them); the space makes `/files/<space>/…` a path of the space.
  const provisional: PageLookup = { ...NO_PAGES, space: page.space, appHost: instanceHost() };
  const links = meta.links.map((l) => ({ ...l, target: classifyLinkTarget(l.syntax, l.linkPath, sourceDir, provisional) }));
  await withTransaction(async (client) => {
    // Two saves of one page (a debounced write-back and a REST PUT) index one after the other: without the row
    // lock the second DELETE would not see the first one's fresh rows and both sets would stay. NO KEY UPDATE
    // does not block the FK checks (KEY SHARE) of links pointing at this page.
    await client.query('SELECT 1 FROM pages_index WHERE id = $1 FOR NO KEY UPDATE', [page.id]);
    await client.query('DELETE FROM page_headings WHERE page_id = $1', [page.id]);
    await client.query('DELETE FROM page_blocks WHERE page_id = $1', [page.id]);
    await client.query('DELETE FROM page_tags WHERE page_id = $1', [page.id]);
    await client.query('DELETE FROM page_links WHERE source_page_id = $1', [page.id]);
    if (meta.headings.length > 0) {
      await client.query(
        `INSERT INTO page_headings (page_id, position, level, text, slug, line)
         SELECT $1, * FROM unnest($2::int[], $3::smallint[], $4::text[], $5::text[], $6::int[])`,
        [
          page.id,
          meta.headings.map((h) => h.position),
          meta.headings.map((h) => h.level),
          meta.headings.map((h) => clean(h.text)),
          meta.headings.map((h) => clean(h.slug)),
          meta.headings.map((h) => h.line),
        ],
      );
    }
    if (meta.blocks.length > 0) {
      await client.query(
        `INSERT INTO page_blocks (page_id, block_id, line)
         SELECT $1, * FROM unnest($2::text[], $3::int[]) ON CONFLICT (page_id, block_id) DO NOTHING`,
        [page.id, meta.blocks.map((b) => b.blockId), meta.blocks.map((b) => b.line)],
      );
    }
    if (meta.tags.length > 0) {
      await client.query(
        `INSERT INTO page_tags (page_id, tag, source, line)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::int[])`,
        [page.id, meta.tags.map((t) => clean(t.tag)), meta.tags.map((t) => t.source), meta.tags.map((t) => t.line)],
      );
    }
    if (links.length > 0) {
      await client.query(
        `INSERT INTO page_links (source_page_id, target_path, link_path, syntax, kind, fragment, fragment_kind, fragment_key, display_text, line, context)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::int[], $11::text[])`,
        [
          page.id,
          links.map((l) => clean(l.target.targetPath)),
          links.map((l) => clean(l.linkPath)),
          links.map((l) => l.syntax),
          links.map((l) => l.target.kind),
          links.map((l) => clean(l.fragment)),
          links.map((l) => l.fragmentKind),
          links.map((l) => clean(l.fragmentKey)),
          links.map((l) => clean(l.displayText)),
          links.map((l) => l.line),
          links.map((l) => clean(l.context)),
        ],
      );
    }
    await client.query('UPDATE pages_index SET frontmatter = $2::jsonb, meta_version = $3 WHERE id = $1', [page.id, frontmatterJson(frontmatter), INDEX_META_VERSION]);
  });
  return meta;
}

export type ResolveScope =
  | 'all'
  | {
      /** Pages whose own links are resolved (just indexed). */
      sourceIds?: readonly string[];
      /** Page paths that appeared, moved or disappeared: links that could mean them are re-resolved. */
      changedPaths?: readonly string[];
      /** Pages whose headings/blocks changed: the fragments of links into them are re-checked. */
      targetIds?: readonly string[];
    };

/** Lowercased file-name keys a link's target_path may end with when it means `pagePath` (see resolveLinks' scope). */
export function targetNameKeys(pagePath: string): string[] {
  const segments = pagePath.split('/');
  const names = new Set<string>();
  const base = segments[segments.length - 1] ?? '';
  if (base) names.add(base);
  if (/\.md$/i.test(base) && base.length > 3) names.add(base.slice(0, -3));
  if (/^(index|readme)\.md$/i.test(base) && segments.length > 1) names.add(segments[segments.length - 2]);
  const out = new Set<string>();
  for (const name of names) {
    for (const v of [name, encodeURIComponent(name), name.replace(/ /g, '%20')]) out.add(v.toLowerCase());
  }
  return [...out];
}

interface LinkRow {
  id: string;
  source_path: string;
  syntax: Parameters<typeof classifyLinkTarget>[0];
  link_path: string;
  kind: LinkKind;
  target_path: string;
  target_page_id: string | null;
}

const LINK_ROW_COLUMNS = `l.id::text AS id, s.path AS source_path, l.syntax, l.link_path, l.kind, l.target_path, l.target_page_id`;

/**
 * External rows never change kind — except an app-absolute `/files/…` URL,
 * which is a path of the space when it names this space (rows indexed before
 * wave 3 still carry 'external' for it), and a Folio app URL (`/s/…`, or an
 * absolute one whose host may be — or become — the instance's: PUBLIC_URL is
 * read at resolution time).
 */
const APP_ROW = `(l.link_path LIKE '/s/%' OR l.link_path ~* '^https?://[^/?#]+/s/')`;
const RESOLVABLE_ROW = `(l.kind <> 'external' OR l.link_path LIKE '/files/%' OR ${APP_ROW})`;

/** Every folder `paths` live in (`a/b/c.png` -> `a`, `a/b`). */
function foldersOf(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    let i = p.indexOf('/');
    while (i !== -1) {
      out.add(p.slice(0, i));
      i = p.indexOf('/', i + 1);
    }
  }
  return out;
}

/** What the links in scope could mean, for the scoped load: exact paths, wikilink basenames, folder candidates. */
interface Wanted {
  exact: string[];
  basenames: string[];
  folders: string[];
}

async function loadPages(space: string, wanted: Wanted | null): Promise<PageLookup> {
  const rows =
    wanted === null
      ? await query<{ id: string; path: string }>('SELECT id, path FROM pages_index WHERE space_slug = $1', [space])
      : wanted.exact.length === 0 && wanted.basenames.length === 0
        ? []
        : await query<{ id: string; path: string }>(
            `SELECT id, path FROM pages_index
              WHERE space_slug = $1 AND (path = ANY($2::text[]) OR lower(regexp_replace(path, '^.*/', '')) = ANY($3::text[]))`,
            [space, wanted.exact, wanted.basenames],
          );
  const idByPath = new Map(rows.map((r) => [r.path, r.id]));
  const files = await loadFiles(space, wanted, wanted === null ? rows.map((r) => r.path) : []);
  return { idAt: (p) => idByPath.get(p) ?? null, wikiIndex: buildPagePathIndex(rows.map((r) => r.path)), files, space };
}

/** The space's files (`space_files`) the links in scope could mean; `allPagePaths` (scope 'all') also makes their folders known. */
async function loadFiles(space: string, wanted: Wanted | null, allPagePaths: string[]): Promise<FileLookup> {
  let paths: string[];
  let folders: Set<string>;
  if (wanted === null) {
    paths = (await query<{ path: string }>('SELECT path FROM space_files WHERE space_slug = $1', [space])).map((r) => r.path);
    folders = foldersOf([...allPagePaths, ...paths]);
  } else {
    paths =
      wanted.exact.length === 0 && wanted.basenames.length === 0
        ? []
        : (
            await query<{ path: string }>(
              `SELECT path FROM space_files
                WHERE space_slug = $1 AND (path = ANY($2::text[]) OR lower(regexp_replace(path, '^.*/', '')) = ANY($3::text[]))`,
              [space, wanted.exact, wanted.basenames],
            )
          ).map((r) => r.path);
    folders =
      wanted.folders.length === 0
        ? new Set()
        : new Set(
            (
              await query<{ d: string }>(
                `SELECT d FROM unnest($2::text[]) AS d
                  WHERE EXISTS (SELECT 1 FROM space_files f WHERE f.space_slug = $1 AND left(f.path, length(d) + 1) = d || '/')
                     OR EXISTS (SELECT 1 FROM pages_index p WHERE p.space_slug = $1 AND left(p.path, length(d) + 1) = d || '/')`,
                [space, wanted.folders],
              )
            ).map((r) => r.d),
          );
  }
  const exact = new Set(paths);
  return { has: (p) => exact.has(p), wikiIndex: buildPagePathIndex(paths), isFolder: (p) => folders.has(p) };
}

/** The pages `refs` may name — by id in any space, and the index pages of the folder routes — in two queries at most. */
async function loadAppPages(refs: AppLinkRef[]): Promise<AppPageLookup> {
  const ids = [...new Set(refs.flatMap((r) => (r.kind === 'page' ? [r.id] : [])))];
  const dirRefs = refs.filter((r): r is Extract<AppLinkRef, { kind: 'dir' }> => r.kind === 'dir');
  const byId = new Map<string, { space: string; path: string }>();
  if (ids.length > 0) {
    const rows = await query<{ id: string; space_slug: string; path: string }>(
      `SELECT id, space_slug, path FROM pages_index WHERE id = ANY($1::text[]) AND kind <> 'folder'`,
      [ids],
    );
    for (const r of rows) byId.set(r.id, { space: r.space_slug, path: r.path });
  }
  const atPath = new Map<string, { id: string; path: string }>();
  if (dirRefs.length > 0) {
    const spaces = [...new Set(dirRefs.map((r) => r.space))];
    const paths = [...new Set(dirRefs.flatMap((r) => appDirCandidates(r.dir)))];
    const rows = await query<{ id: string; space_slug: string; path: string }>(
      `SELECT id, space_slug, path FROM pages_index WHERE space_slug = ANY($1::text[]) AND path = ANY($2::text[]) AND kind <> 'folder'`,
      [spaces, paths],
    );
    for (const r of rows) atPath.set(`${r.space_slug}\u0000${r.path}`, { id: r.id, path: r.path });
  }
  return {
    byId: (id) => byId.get(id) ?? null,
    dirPage: (space, dir) => {
      for (const candidate of appDirCandidates(dir)) {
        const hit = atPath.get(`${space}\u0000${candidate}`);
        if (hit) return hit;
      }
      return null;
    },
  };
}

/** Every file of the space (`space_files`) as the link resolver sees it - for readers outside the index (the exports resolve an attachment by name the way the index did). */
export function loadSpaceFiles(space: string): Promise<FileLookup> {
  return loadFiles(space, null, []);
}

/** Phase 2 — see the module comment. Never throws for a single odd row; a database failure propagates. */
export async function resolveLinks(space: string, scope: ResolveScope): Promise<void> {
  let rows: LinkRow[];
  if (scope === 'all') {
    rows = await query<LinkRow>(
      `SELECT ${LINK_ROW_COLUMNS}
         FROM page_links l JOIN pages_index s ON s.id = l.source_page_id
        WHERE s.space_slug = $1 AND ${RESOLVABLE_ROW}`,
      [space],
    );
  } else {
    const sourceIds = [...new Set(scope.sourceIds ?? [])];
    const keys = [...new Set((scope.changedPaths ?? []).flatMap(targetNameKeys))];
    rows = await query<LinkRow>(
      `SELECT ${LINK_ROW_COLUMNS}
         FROM page_links l JOIN pages_index s ON s.id = l.source_page_id
        WHERE s.space_slug = $1 AND ${RESOLVABLE_ROW}
          AND (l.source_page_id = ANY($2::text[])
               OR (l.kind = 'page' AND l.target_page_id IS NULL)
               OR (l.kind = 'unresolved' AND ${APP_ROW})
               OR lower(regexp_replace(l.target_path, '^.*/', '')) = ANY($3::text[])
               OR lower(regexp_replace(l.link_path, '^.*/', '')) = ANY($3::text[]))`,
      [space, sourceIds, keys],
    );
  }

  if (rows.length > 0) {
    let pages: PageLookup;
    if (scope === 'all') {
      pages = await loadPages(space, null);
    } else {
      // Only the pages and files these links could mean: every candidate path of a markdown-style link (and its
      // folder, for a folder link), every page or file named like a wikilink.
      const exact = new Set<string>();
      const basenames = new Set<string>();
      const folders = new Set<string>();
      for (const row of rows) {
        if (isWikiSyntax(row.syntax)) {
          for (const b of wikilinkBasenames(row.link_path)) basenames.add(b);
        } else {
          // A canvas file card names its target from the space root, exactly (resolve.ts).
          if (row.syntax === 'canvas') {
            const exactPath = resolveRelative('', row.link_path);
            if (exactPath) exact.add(exactPath);
            continue;
          }
          // A Folio app URL names its page by id or route, not by a path of this space (loadAppPages below).
          if (APP_LINK_SHAPE.test(row.link_path)) continue;
          const appPath = row.link_path.startsWith('/') ? appFilesPath(row.link_path, space) : null;
          // A markdown link may name an attachment by its name too (resolve.ts): the files named like it.
          if (appPath === null) for (const b of wikilinkBasenames(row.link_path)) basenames.add(b);
          const resolved = appPath ?? resolveRelative(posixParent(row.source_path), row.link_path);
          if (resolved === null) continue;
          for (const c of markdownLinkCandidates(resolved)) exact.add(c);
          for (const c of fileLinkCandidates(resolved)) {
            exact.add(c);
            folders.add(c);
          }
        }
      }
      pages = await loadPages(space, { exact: [...exact], basenames: [...basenames], folders: [...folders] });
    }
    // App links (`/s/<space>/p/<id>`, the space home, a folder route): the pages they name, in any space.
    const appHost = instanceHost();
    const appRefs = rows.flatMap((row) => {
      if (row.syntax === 'canvas' || isWikiSyntax(row.syntax)) return [];
      const ref = parseAppLink(row.link_path, appHost);
      return ref ? [ref] : [];
    });
    pages = { ...pages, appHost, app: await loadAppPages(appRefs) };

    const changed: Array<{ id: string; kind: LinkKind; targetPath: string; targetPageId: string | null }> = [];
    // A whole space can hold a hundred thousand links: classified in slices, never holding the event loop long.
    const tick = timeSlicer();
    for (const row of rows) {
      await tick();
      const next = classifyLinkTarget(row.syntax, row.link_path, posixParent(row.source_path), pages);
      if (next.kind !== row.kind || next.targetPath !== row.target_path || next.targetPageId !== row.target_page_id) {
        changed.push({ id: row.id, ...next });
      }
    }
    if (changed.length > 0) {
      changed.sort((a, b) => Number(a.id) - Number(b.id)); // one lock order for every writer of these rows
      // A target deleted since the load gets NULL (the subquery), never an FK error; the next resolution marks it.
      await query(
        `UPDATE page_links l
            SET kind = v.kind, target_path = v.target_path,
                target_page_id = (SELECT t.id FROM pages_index t WHERE t.id = v.target_page_id)
           FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[]) AS v(id, kind, target_path, target_page_id)
          WHERE l.id = v.id`,
        [changed.map((c) => c.id), changed.map((c) => c.kind), changed.map((c) => c.targetPath), changed.map((c) => c.targetPageId)],
      );
    }
  }

  // Fragments: `#heading` by slug, `#^id` by block id, only for links that reach a page.
  const fragmentScope =
    scope === 'all'
      ? { sql: `l2.source_page_id IN (SELECT id FROM pages_index WHERE space_slug = $1)`, params: [space] as unknown[] }
      : { sql: `(l2.id = ANY($1::bigint[]) OR l2.target_page_id = ANY($2::text[]))`, params: [rows.map((r) => r.id), [...new Set(scope.targetIds ?? [])]] as unknown[] };
  await query(
    `UPDATE page_links l SET fragment_resolved = v.ok
       FROM (
         SELECT l2.id,
                CASE
                  WHEN l2.fragment_key IS NULL OR l2.target_page_id IS NULL OR l2.kind <> 'page' THEN NULL
                  WHEN l2.fragment_kind = 'block' THEN EXISTS (SELECT 1 FROM page_blocks b WHERE b.page_id = l2.target_page_id AND lower(b.block_id) = l2.fragment_key)
                  ELSE EXISTS (SELECT 1 FROM page_headings h WHERE h.page_id = l2.target_page_id AND h.slug = l2.fragment_key)
                END AS ok
           FROM page_links l2
          WHERE ${fragmentScope.sql}
       ) v
      WHERE l.id = v.id AND l.fragment_resolved IS DISTINCT FROM v.ok`,
    fragmentScope.params,
  );

  await notifyIndexResolved(space);
}

/** Phase 2 for the whole space. */
export function resolveSpaceLinks(space: string): Promise<void> {
  return resolveLinks(space, 'all');
}

/**
 * "The link index of a space was (re)resolved" — `pg_notify` on
 * INDEX_RESOLVED_CHANNEL with `{schema, space}`, the treeSignal.ts payload
 * shape (no titles, paths or ids). Nothing listens yet; a later wave can fan it
 * out over the /events socket the way treeSignal does. Best effort.
 */
export async function notifyIndexResolved(space: string): Promise<void> {
  await query(`SELECT pg_notify($1, json_build_object('schema', current_schema(), 'space', $2::text)::text)`, [INDEX_RESOLVED_CHANNEL, space]).catch(() => {});
}

/**
 * Phase 1 + the cheap phase 2 for one saved document: its own links, the
 * fragments of links into it. Errors are logged, never thrown into the save.
 */
/** reindexSavedPage for a canvas page (its properties changed): its cards are indexed again with the new front matter. */
export async function reindexSavedCanvas(page: IndexedPage, doc: CanvasDocument, frontmatter: Record<string, unknown> | null | undefined): Promise<void> {
  try {
    await indexCanvasMeta(page, doc, frontmatter);
    await resolveLinks(page.space, { sourceIds: [page.id], targetIds: [page.id] });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[index] failed to index ${page.space}/${page.relPath}:`, err);
  }
}

export async function reindexSavedPage(page: IndexedPage, body: string, frontmatter: Record<string, unknown> | null | undefined): Promise<void> {
  try {
    await indexPageMeta(page, body, frontmatter);
    await resolveLinks(page.space, { sourceIds: [page.id], targetIds: [page.id] });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[index] failed to index ${page.space}/${page.relPath}:`, err);
  }
}
