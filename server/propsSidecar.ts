/**
 * Property sidecars (15.10.2026, owner's decision): the properties of a page
 * whose file cannot hold front matter — a board (`.excalidraw.svg`), a PDF, an
 * Office file — live in a YAML file under the space's `.folio/` folder (at the
 * content root, the folder the site/PDF settings and `properties.json` use),
 * mirroring the page's path:
 *
 *   docs/report.pdf            ->  .folio/docs/report.pdf.props.yaml
 *   boards/flow.excalidraw.svg ->  .folio/boards/flow.excalidraw.svg.props.yaml
 *
 * The file is a plain YAML mapping with the same value model as front matter
 * (it is read and edited by the very same code: server/frontmatter.ts, over
 * the text wrapped in `---` lines, so an edit keeps every other byte — key
 * order, comments, quoting). It exists only while the page has a property:
 * the first one creates it, removing the last one deletes it.
 *
 * This module is the file-system half, relative to a content root (no space
 * lookups, no commits): paths, reading, the text edit, and the moves a page's
 * rename / move / delete / copy / restore make (storage.ts and trash). The
 * write with its commit is properties.ts (spaceAppearance.ts writeFolioFile).
 * Never through a symlink; `.folio/` and every folder under it must be real
 * directories. Sidecars are never pages and never files of the files index
 * (the scan skips dot folders).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PageKind } from '../shared/contracts.js';
import { readFrontmatterBlock, writeFrontmatterKeys, type FrontmatterKeyEdit } from './frontmatter.js';

export const SIDECAR_DIR = '.folio';
export const SIDECAR_SUFFIX = '.props.yaml';
/** A sidecar larger than this is not read (shown as unreadable, read-only). */
export const SIDECAR_MAX_BYTES = 256 * 1024;

const SIDECAR_KINDS: ReadonlySet<PageKind> = new Set<PageKind>(['board', 'pdf', 'office']);

/** Pages whose properties live in a sidecar. */
export function usesSidecar(kind: PageKind): boolean {
  return SIDECAR_KINDS.has(kind);
}

/** True for a page path that cannot name a sidecar safely. */
function unsafeRel(rel: string): boolean {
  return rel === '' || rel.startsWith('/') || rel.split('/').some((part) => part === '' || part === '.' || part === '..');
}

/** `docs/report.pdf` -> `.folio/docs/report.pdf.props.yaml` (content-root relative, POSIX). */
export function sidecarRelPath(pageRelPath: string): string {
  return `${SIDECAR_DIR}/${pageRelPath}${SIDECAR_SUFFIX}`;
}

/** `.folio/docs/report.pdf.props.yaml` -> `docs/report.pdf`; null for anything else. */
export function pageRelOfSidecar(sidecarRel: string): string | null {
  if (!sidecarRel.startsWith(`${SIDECAR_DIR}/`) || !sidecarRel.endsWith(SIDECAR_SUFFIX)) return null;
  const rel = sidecarRel.slice(SIDECAR_DIR.length + 1, -SIDECAR_SUFFIX.length);
  return unsafeRel(rel) ? null : rel;
}

function absOf(contentRoot: string, rel: string): string {
  return path.join(contentRoot, ...rel.split('/'));
}

/** Every directory from `.folio` down to `relDir` is a real directory (true when one is missing: nothing to read, mkdir makes real ones). */
async function dirsAreSafe(contentRoot: string, relDir: string): Promise<boolean> {
  let abs = contentRoot;
  for (const part of relDir.split('/')) {
    abs = path.join(abs, part);
    try {
      const st = await fs.lstat(abs);
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
    } catch {
      return true;
    }
  }
  return true;
}

/** mkdir -p of `relDir` under the content root, refusing a symlink or a file on the way. */
export async function ensureSidecarDirs(contentRoot: string, relDir: string): Promise<void> {
  if (!(await dirsAreSafe(contentRoot, relDir))) throw new Error(`${relDir} is not a directory in the repository`);
  await fs.mkdir(absOf(contentRoot, relDir), { recursive: true });
}

/** The sidecar's text, or null (none, too big, a symlink, under a symlinked folder). */
export async function readSidecarText(contentRoot: string, pageRelPath: string): Promise<string | null> {
  if (unsafeRel(pageRelPath)) return null;
  const rel = sidecarRelPath(pageRelPath);
  if (!(await dirsAreSafe(contentRoot, path.posix.dirname(rel)))) return null;
  try {
    const abs = absOf(contentRoot, rel);
    const st = await fs.lstat(abs);
    if (!st.isFile() || st.size > SIDECAR_MAX_BYTES) return null;
    return await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

/** A line YAML would read as a document marker: the text cannot be wrapped as a front matter block. */
const DOCUMENT_MARKER_RE = /^(?:---|\.\.\.)[ \t]*\r?$/m;

/** The sidecar text as a front matter block (`---` lines around it), for the front matter editors. */
export function wrapSidecar(text: string): string {
  const body = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return `---\n${body}---\n`;
}

/** wrapSidecar undone. */
export function unwrapSidecar(raw: string): string {
  if (raw === '') return '';
  const open = /^---[ \t]*\r?\n/.exec(raw);
  const close = /(?:^|\n)---[ \t]*\r?\n?$/.exec(raw);
  if (!open || !close) throw new Error('internal: sidecar edit lost its delimiters');
  return raw.slice(open[0].length, close.index + (close[0].startsWith('\n') ? 1 : 0));
}

export interface SidecarData {
  /** The mapping ({} for an empty or missing file, and for one that cannot be read). */
  data: Record<string, unknown>;
  parseable: boolean;
}

/** The sidecar text as a mapping. Not a YAML mapping (a list, a scalar, a second document) -> unparseable. */
export function parseSidecar(text: string | null): SidecarData {
  if (text === null || text.trim() === '') return { data: {}, parseable: true };
  if (DOCUMENT_MARKER_RE.test(text)) return { data: {}, parseable: false };
  const block = readFrontmatterBlock(wrapSidecar(text));
  if (!block.parseable) return { data: {}, parseable: false };
  const data = block.data as unknown;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { data: {}, parseable: false };
  return { data: data as Record<string, unknown>, parseable: true };
}

/**
 * The sidecar text after `edits` (writeFrontmatterKeys rules: untouched keys
 * keep their bytes, a new key is appended, a removed key loses its lines).
 * '' when nothing is left — the caller deletes the file then.
 */
export function editSidecarText(text: string | null, edits: ReadonlyMap<string, FrontmatterKeyEdit>): string {
  const current = text ?? '';
  const out = unwrapSidecar(writeFrontmatterKeys(wrapSidecar(current), edits));
  // A file left with nothing but blank lines (and no comment) has nothing to keep.
  return out.trim() === '' ? '' : out;
}

/** Removes empty folders from `relDir` up to (not including) `.folio`. */
async function pruneEmptyDirs(contentRoot: string, relDir: string): Promise<void> {
  let dir = relDir;
  while (dir.startsWith(`${SIDECAR_DIR}/`)) {
    try {
      await fs.rmdir(absOf(contentRoot, dir));
    } catch {
      return; // not empty (or gone): stop
    }
    dir = path.posix.dirname(dir);
  }
}

/** Writes (or with null / '' deletes) one sidecar, without a commit — for callers that commit it with other files. Returns the content-root-relative path. */
export async function putSidecarText(contentRoot: string, pageRelPath: string, text: string | null): Promise<string> {
  if (unsafeRel(pageRelPath)) throw new Error(`invalid page path: ${pageRelPath}`);
  const rel = sidecarRelPath(pageRelPath);
  const abs = absOf(contentRoot, rel);
  if (text === null || text === '') {
    const st = await fs.lstat(abs).catch(() => null);
    if (st && (st.isFile() || st.isSymbolicLink())) await fs.rm(abs, { force: true });
    await pruneEmptyDirs(contentRoot, path.posix.dirname(rel));
    return rel;
  }
  await ensureSidecarDirs(contentRoot, path.posix.dirname(rel));
  const st = await fs.lstat(abs).catch(() => null);
  if (st?.isSymbolicLink()) await fs.rm(abs, { force: true });
  // The `.<name>.….tmp` shape git.ts keeps out of every `git add -A` (ATOMIC_TEMP_PATHSPEC), like storage.writeFileAtomic.
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`);
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, abs);
  return rel;
}

/** Every sidecar of the content root: page path -> text (unreadable ones are left out). */
export async function listSidecars(contentRoot: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const root = absOf(contentRoot, SIDECAR_DIR);
  if (!(await dirsAreSafe(contentRoot, SIDECAR_DIR))) return out;
  async function walk(absDir: string, relDir: string): Promise<void> {
    const dirents = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      const rel = `${relDir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        await walk(path.join(absDir, dirent.name), rel);
        continue;
      }
      if (!dirent.isFile() || !dirent.name.endsWith(SIDECAR_SUFFIX)) continue;
      const pageRel = pageRelOfSidecar(rel);
      if (!pageRel) continue;
      const abs = path.join(absDir, dirent.name);
      const st = await fs.lstat(abs).catch(() => null);
      if (!st || st.size > SIDECAR_MAX_BYTES) continue;
      const text = await fs.readFile(abs, 'utf8').catch(() => null);
      if (text !== null) out.set(pageRel, text);
    }
  }
  await walk(root, SIDECAR_DIR);
  return out;
}

/** The sidecars of one page path (`dir` false) or of every page under a folder (`dir` true): page path -> text. */
export async function sidecarsUnder(contentRoot: string, rel: string, dir: boolean): Promise<Map<string, string>> {
  if (unsafeRel(rel)) return new Map();
  if (!dir) {
    const text = await readSidecarText(contentRoot, rel);
    return text === null ? new Map() : new Map([[rel, text]]);
  }
  const all = await listSidecars(contentRoot);
  return new Map([...all].filter(([pageRel]) => pageRel.startsWith(`${rel}/`)));
}

/**
 * The sidecars follow a page (or a folder of pages) that moved from `fromRel`
 * to `toRel` on disk: each one is moved to the new path (an existing sidecar
 * there is replaced — it described a file that is not there any more).
 * Best effort per file: one that cannot move is logged and left. Returns the
 * content-root-relative paths touched (old and new), for a commit.
 */
export async function moveSidecars(contentRoot: string, fromRel: string, toRel: string, dir: boolean): Promise<string[]> {
  if (fromRel === toRel || unsafeRel(fromRel) || unsafeRel(toRel)) return [];
  const touched: string[] = [];
  for (const [pageRel, text] of await sidecarsUnder(contentRoot, fromRel, dir)) {
    const target = dir ? `${toRel}${pageRel.slice(fromRel.length)}` : toRel;
    try {
      touched.push(await putSidecarText(contentRoot, target, text));
      touched.push(await putSidecarText(contentRoot, pageRel, null));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[props] could not move the properties of ${pageRel} to ${target}:`, err);
    }
  }
  return touched;
}

/** Copies the sidecar of a page at `fromRel` (content root `fromRoot`) to `toRel` under `toRoot` (a copy of the page; another space allowed). Best effort. */
export async function copySidecar(fromRoot: string, fromRel: string, toRoot: string, toRel: string): Promise<void> {
  if (unsafeRel(fromRel) || unsafeRel(toRel)) return;
  const text = await readSidecarText(fromRoot, fromRel);
  if (text === null) return;
  await putSidecarText(toRoot, toRel, text).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[props] could not copy the properties of ${fromRel} to ${toRel}:`, err);
  });
}

/** Deletes the sidecars of a page / folder; returns what they held (page path + text), for the trash item. */
export async function removeSidecars(contentRoot: string, rel: string, dir: boolean): Promise<Array<{ path: string; content: string }>> {
  const removed: Array<{ path: string; content: string }> = [];
  for (const [pageRel, text] of await sidecarsUnder(contentRoot, rel, dir)) {
    try {
      await putSidecarText(contentRoot, pageRel, null);
      removed.push({ path: pageRel, content: text });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[props] could not remove the properties of ${pageRel}:`, err);
    }
  }
  return removed;
}
