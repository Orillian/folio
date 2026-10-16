/**
 * The read model of a canvas page (kind 'canvas', a `.canvas` JSON Canvas
 * file): what `GET /api/pages/:id` (PageDoc.canvas), the share link, the public
 * site and MCP read_page show. Read-only — nothing here writes the file.
 *
 * File cards are resolved BY PATH at read time, for the reader at hand
 * (CanvasReader), never from a cached id: the path in the file is what
 * Obsidian opens, and a canvas is not rewritten when its target is renamed in
 * a light-footprint space — such a card then reads 'missing', exactly like
 * Obsidian shows a card whose file was moved behind its back.
 *  - a page the reader may open -> 'page' with its title, kind and icon, and
 *    for a document the Markdown of its start (or of the `subpath` heading /
 *    block, cut the way an embed is cut: server/embed.ts sliceEmbedFragment);
 *  - a page the reader may NOT open -> 'noAccess', and the card's `file` /
 *    `subpath` are blanked in the document sent: no title, no path;
 *  - a file of the space that is not a page (an image, audio, any attachment)
 *    -> 'file' with its media type (the browser fetches it from
 *    `/files/<space>/<path>`, which applies its own rule: fileAccess.ts counts
 *    a canvas's cards as references);
 *  - nothing at that path -> 'missing'.
 * Group background images are resolved the same way.
 */
import type { CanvasDocument, CanvasFileTarget, CanvasNode, CanvasPayload, PageKind } from '../shared/contracts.js';
import { CANVAS_EXCERPT_MAX_CHARS } from '../shared/contracts.js';
import { canvasFileMedia, parseJsonCanvas } from '../shared/canvas/index.js';
import { query } from './db/pool.js';
import { visiblePagesSql, type PageViewer } from './accessSql.js';
import * as storage from './storage.js';
import type { PageIndexEntry } from './storage.js';
import * as collab from './collab.js';
import { sliceEmbedFragment } from './embed.js';
import { resolveRelative } from './indexV2/resolve.js';

/** Who reads the canvas: a signed-in user or the public site (accessSql.ts), or a share link with its own page set. */
export type CanvasReader = PageViewer | { kind: 'share'; pageIds: ReadonlySet<string> };

/** At most this many document cards of one canvas get an excerpt; the rest show their title only. */
export const CANVAS_MAX_EXCERPTS = 200;

interface PageRow {
  id: string;
  path: string;
  kind: PageKind;
  title: string;
  icon: string | null;
}

/** `text` cut to at most `max` characters, at a paragraph (else a line) break when there is one in the last third. */
export function cutExcerpt(text: string, max = CANVAS_EXCERPT_MAX_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, max);
  const para = head.lastIndexOf('\n\n');
  const line = head.lastIndexOf('\n');
  const cut = para > max * 0.66 ? para : line > max * 0.66 ? line : max;
  return { text: head.slice(0, cut).trimEnd(), truncated: true };
}

async function docBody(entry: PageIndexEntry): Promise<string> {
  return collab.isDocLive(entry.id) ? (collab.getLiveText(entry.id) ?? (await storage.readFreshDocBody(entry.id))) : storage.readFreshDocBody(entry.id);
}

async function excerptOf(entry: PageIndexEntry, subpath: string | undefined): Promise<{ excerpt: string; excerptTruncated?: true; subpathMissing?: true }> {
  const body = await docBody(entry);
  let section = body;
  let subpathMissing = false;
  if (subpath) {
    try {
      section = sliceEmbedFragment(body, subpath.replace(/^#/, ''));
    } catch {
      subpathMissing = true;
    }
  }
  const cut = cutExcerpt(section);
  return { excerpt: cut.text, ...(cut.truncated ? { excerptTruncated: true as const } : {}), ...(subpathMissing ? { subpathMissing: true as const } : {}) };
}

/** The ids among `ids` the reader may open. */
async function openableIds(space: string, ids: string[], reader: CanvasReader): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  if (reader.kind === 'share') return new Set(ids.filter((id) => reader.pageIds.has(id)));
  const params: unknown[] = [space, ids];
  const visible = visiblePagesSql('p', reader, params);
  const rows = await query<{ id: string }>(`SELECT p.id FROM pages_index p WHERE p.space_slug = $1 AND p.id = ANY($2::text[]) AND ${visible}`, params);
  return new Set(rows.map((r) => r.id));
}

/**
 * Resolves the file cards and group backgrounds of `doc` (a canvas of `space`)
 * for `reader`. Returns the targets by node id and the document with the
 * no-access cards' paths blanked.
 */
export async function resolveCanvasFiles(
  space: string,
  doc: CanvasDocument,
  reader: CanvasReader,
  options: { excerpts?: boolean } = {},
): Promise<{ document: CanvasDocument; files: Record<string, CanvasFileTarget>; backgrounds: Record<string, CanvasFileTarget> }> {
  const wanted = new Set<string>();
  const pathOf = (raw: string) => resolveRelative('', raw) ?? '';
  for (const node of doc.nodes) {
    if (node.type === 'file') wanted.add(pathOf(node.file));
    else if (node.type === 'group' && node.background) wanted.add(pathOf(node.background));
  }
  wanted.delete('');
  const paths = [...wanted];
  const pages = paths.length
    ? await query<PageRow>('SELECT id, path, kind, title, icon FROM pages_index WHERE space_slug = $1 AND path = ANY($2::text[])', [space, paths])
    : [];
  const pageByPath = new Map(pages.map((p) => [p.path, p]));
  const filePaths = paths.filter((p) => !pageByPath.has(p));
  const fileRows = filePaths.length
    ? await query<{ path: string }>('SELECT path FROM space_files WHERE space_slug = $1 AND path = ANY($2::text[])', [space, filePaths])
    : [];
  const files = new Set(fileRows.map((r) => r.path));
  const openable = await openableIds(space, pages.map((p) => p.id), reader);

  let excerptsLeft = options.excerpts === false ? 0 : CANVAS_MAX_EXCERPTS;
  const target = async (raw: string, subpath: string | undefined): Promise<CanvasFileTarget> => {
    const p = pathOf(raw);
    const page = pageByPath.get(p);
    if (page) {
      if (!openable.has(page.id)) return { status: 'noAccess' };
      const out: CanvasFileTarget = { status: 'page', pageId: page.id, kind: page.kind, title: page.title, path: page.path, ...(page.icon ? { icon: page.icon } : {}) };
      if (page.kind === 'doc' && excerptsLeft > 0) {
        excerptsLeft--;
        const entry = await storage.getEntry(page.id);
        if (entry) Object.assign(out, await excerptOf(entry, subpath).catch(() => ({})));
      }
      return out;
    }
    if (p && files.has(p)) return { status: 'file', path: p, media: canvasFileMedia(p) };
    return { status: 'missing', path: p || raw };
  };

  const byId: Record<string, CanvasFileTarget> = {};
  const backgrounds: Record<string, CanvasFileTarget> = {};
  const nodes: CanvasNode[] = [];
  for (const node of doc.nodes) {
    if (node.type === 'file') {
      const t = await target(node.file, node.subpath);
      byId[node.id] = t;
      nodes.push(t.status === 'noAccess' ? { ...node, file: '', subpath: undefined } : node);
    } else if (node.type === 'group' && node.background) {
      const t = await target(node.background, undefined);
      // A background is an image of the space; a page there (or one the reader may not open) is no background at all.
      if (t.status === 'file' || t.status === 'missing') backgrounds[node.id] = t;
      nodes.push(t.status === 'noAccess' || t.status === 'page' ? { ...node, background: undefined } : node);
    } else {
      nodes.push(node);
    }
  }
  // `subpath: undefined` / `background: undefined` must not survive into JSON as keys either.
  const clean = nodes.map((n) => JSON.parse(JSON.stringify(n)) as typeof n);
  return { document: { nodes: clean, edges: doc.edges }, files: byId, backgrounds };
}

/** The canvas page as its reader sees it (see the module doc). */
export async function buildCanvasPayload(entry: PageIndexEntry, reader: CanvasReader): Promise<CanvasPayload> {
  const raw = await storage.readCanvasRaw(entry.id);
  if ('error' in raw) return { document: null, error: raw.error, warnings: [], files: {}, backgrounds: {} };
  const parsed = parseJsonCanvas(raw.text);
  if (!parsed.ok) return { document: null, error: parsed.error, warnings: [], files: {}, backgrounds: {} };
  const resolved = await resolveCanvasFiles(entry.space, parsed.document, reader);
  return { document: resolved.document, warnings: parsed.warnings, files: resolved.files, backgrounds: resolved.backgrounds };
}
