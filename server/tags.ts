/**
 * Tags of a space (Obsidian brief, wave 3): the pages that carry a tag, and the
 * space-wide rename `#from` -> `#to`.
 *
 * LISTING (GET /api/spaces/:space/tags/:tag/pages): `page_tags` rows of the tag
 * and of its children (`a` also lists `a/b`), filtered in SQL by accessSql.ts
 * like every list-shaped read, so a page the caller may not read is never
 * listed or counted; `_templates/` are left out (the tag list does the same).
 *
 * RENAME (POST /api/spaces/:space/tags/rename). Every page that carries
 * `from` (or a child `from/…`) in the page index is looked at — a data table's
 * or form's own `tags:` and a board's / file's sidecar (`.folio/<path>.props.yaml`)
 * too, since 15.10.2026, and in the same commit; in a document the tag is
 * rewritten in two places and nowhere else:
 *  - the BODY: each `#from…` token the page parser indexes as a tag (the same
 *    text nodes of the same mdast, the same boundary rule — after whitespace or
 *    at a line start, never in code, links, HTML or after a backslash), replaced
 *    in place at its source offsets. Everything outside the tokens stays as it
 *    is: the case of the rest of a hierarchical tag (`#Work/Alpha` -> `#to/Alpha`),
 *    a trailing slash, the surrounding text. Written through collab.editDocBody
 *    (live-room aware, like every other body edit) and flushed to disk.
 *  - the FRONT MATTER `tags:` / `labels:`: only the entry that holds the tag
 *    changes, in place under its own key and in its own style (flow list, block
 *    list with its comments, or a comma/space separated string); every other
 *    line of the block is untouched. `labels:` (a synonym of `tags:`) is never
 *    moved into `tags:` or removed.
 *    The edited block is parsed back and must equal "the original data with the
 *    tag renamed" or the page's front matter is left as it was.
 *    This is deliberately not frontmatter.ts writeFrontmatterKeys: that writer
 *    re-renders a changed key as a block list and, when its own line edit cannot
 *    be verified, re-serializes the whole block (comments lost). A rename keeps
 *    the entry's style and otherwise leaves the front matter alone.
 * The whole rename is ONE commit, `docs: rename tag #from -> #to`, of exactly the
 * changed files (git.commitPaths — other people's unsaved edits are not swept
 * in), under the space lock; the index of each changed page is rebuilt.
 *
 * Who is touched: pages the caller can edit (effective page role, page access
 * included). A page they can open but not edit is skipped and counted in
 * `pagesSkipped`. A page that page access hides from them, and `.agent/**` pages
 * for a non-admin, are never touched and never counted (they do not exist for
 * that caller, and a count would tell them how many there are).
 */
import { readManifestText, writeManifestFile } from './artifact/bundle.js';
import { ARTIFACT_MANIFEST_FILE } from './artifact/manifest.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as matterNS from 'gray-matter';
import type { Nodes, Root, Text } from 'mdast';
import type { RenameTagResult, TagPagesResponse, User } from '../shared/contracts.js';
import { normalizeSearchTag } from '../shared/searchQuery.js';
import { isAgentPath } from './agentPath.js';
import * as session from './auth/session.js';
import * as collab from './collab.js';
import { query } from './db/pool.js';
import { withSpaceLock } from './db/redis.js';
import { badRequest, notFound } from './errors.js';
import * as git from './git.js';
import * as gitSync from './gitSync.js';
import { sqlParam, visiblePagesSql, type PageViewer } from './accessSql.js';
import { reindexSavedPage } from './indexV2/store.js';
import { normalizeTag } from './indexV2/parse.js';
import { parseMarkdownAstChunked } from './markdownAst.js';
import { parseSidecar, putSidecarText, readSidecarText, sidecarRelPath, unwrapSidecar, usesSidecar, wrapSidecar } from './propsSidecar.js';
import { ownProperties } from './reservedPropertyKeys.js';
import * as storage from './storage.js';

// Same CJS interop fallback as storage.ts / frontmatter.ts.
const matter = (typeof matterNS === 'function' ? matterNS : (matterNS as unknown as { default: typeof matterNS }).default) as typeof matterNS;

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

export const TAG_PAGES_DEFAULT_LIMIT = 100;
export const TAG_PAGES_MAX_LIMIT = 500;
const MAX_OFFSET = 1_000_000;

export function clampTagPagesLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return TAG_PAGES_DEFAULT_LIMIT;
  return Math.min(TAG_PAGES_MAX_LIMIT, Math.max(1, Math.floor(n)));
}

export function clampTagPagesOffset(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_OFFSET) : 0;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

interface TagPageRow {
  id: string;
  path: string;
  title: string;
  updated_at: string;
  sources: Array<'body' | 'frontmatter'>;
}

/** The pages of `space` the viewer may read that carry `tag` or a child of it; by title, then path. */
export async function listTagPages(space: string, rawTag: string, viewer: PageViewer, page: { limit: number; offset: number }): Promise<TagPagesResponse> {
  const tag = normalizeSearchTag(rawTag);
  if (!tag) throw badRequest('invalid tag');
  const params: unknown[] = [space, tag, `${escapeLike(tag)}/%`];
  const visible = visiblePagesSql('p', viewer, params, { excludeTemplates: true });
  const from = `FROM page_tags t JOIN pages_index p ON p.id = t.page_id
      WHERE p.space_slug = $1 AND (t.tag = $2 OR t.tag LIKE $3) AND ${visible}`;
  const total = (await query<{ n: number }>(`SELECT COUNT(DISTINCT p.id)::int AS n ${from}`, params))[0]?.n ?? 0;
  const listParams = [...params];
  const limit = sqlParam(listParams, page.limit);
  const offset = sqlParam(listParams, page.offset);
  const rows = await query<TagPageRow>(
    `SELECT p.id, p.path, p.title, p.updated_at, array_agg(DISTINCT t.source ORDER BY t.source) AS sources
      ${from}
      GROUP BY p.id, p.path, p.title, p.updated_at
      ORDER BY p.title, p.path
      LIMIT ${limit} OFFSET ${offset}`,
    listParams,
  );
  return {
    tag,
    pages: rows.map((r) => ({ id: r.id, path: r.path, title: r.title, updatedAt: new Date(r.updated_at).toISOString(), sources: r.sources })),
    total,
  };
}

// ---------------------------------------------------------------------------
// Rename: the rule
// ---------------------------------------------------------------------------

/** `from` itself or a child of it. */
const isUnder = (tag: string, from: string): boolean => tag === from || tag.startsWith(`${from}/`);

/**
 * The tag text after the rename for a tag as indexed (`normalized`): `to` plus
 * what followed `from`. Undefined when it is not `from` or one of its children.
 */
function renamedNormalized(normalized: string, from: string, to: string): string | undefined {
  return isUnder(normalized, from) ? to + normalized.slice(from.length) : undefined;
}

// ---------------------------------------------------------------------------
// Rename: the body
// ---------------------------------------------------------------------------

// The text rule of server/indexV2/parse.ts (TAG_RE and the whitespace boundary) — a guard test keeps the two in step.
const TAG_RE = /#([\p{L}\p{N}\p{M}_\-/]+)/gu;

export interface BodyTagToken {
  /** Offset of the `#`. */
  start: number;
  /** Offset just after the last character of the tag. */
  end: number;
  /** The tag as written, without the `#`. */
  raw: string;
  /** The tag as indexed. */
  tag: string;
}

/** Every `#tag` the page parser would index from `body`, with its source offsets, in order. */
export function findBodyTagTokens(body: string): BodyTagToken[] {
  if (!body.includes('#')) return [];
  // The index's own parse (indexV2/parse.ts): the same tags, in linear time for a big body.
  const tree: Root = parseMarkdownAstChunked(body);
  const tokens: BodyTagToken[] = [];

  const textTokens = (node: Text): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    // The SOURCE of the text node (escapes and character references included), so `\#x` and `&#35;x` are not tags.
    const source = body.slice(start, end);
    if (!source.includes('#')) return;
    const re = new RegExp(TAG_RE);
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const before = m.index === 0 ? body[start - 1] : source[m.index - 1];
      if (before !== undefined && !/\s/.test(before)) continue;
      const tag = normalizeTag(m[1]);
      if (!tag) continue;
      tokens.push({ start: start + m.index, end: start + m.index + 1 + m[1].length, raw: m[1], tag });
    }
  };

  const walk = (node: Nodes, inLink: boolean): void => {
    switch (node.type) {
      case 'code':
      case 'inlineCode':
      case 'definition':
      case 'html':
      case 'image':
      case 'imageReference':
        return;
      case 'text':
        if (!inLink) textTokens(node);
        return;
      case 'link':
      case 'linkReference':
        for (const child of node.children) walk(child, true);
        return;
      default:
        break;
    }
    if ('children' in node) for (const child of node.children as Nodes[]) walk(child, inLink);
  };
  walk(tree, false);
  return tokens;
}

/** The token's new text (with the `#`), or undefined when it is not under `from`. */
function renamedToken(token: BodyTagToken, from: string, to: string): string | undefined {
  const renamed = renamedNormalized(token.tag, from, to);
  if (renamed === undefined) return undefined;
  // A token written plainly (lowercase already, no stray slashes): keep the case of whatever follows the prefix.
  if (token.raw.toLowerCase() === token.tag && token.raw.length === token.tag.length) return `#${to}${token.raw.slice(from.length)}`;
  const lead = /^\/+/.exec(token.raw)?.[0] ?? '';
  const trail = /\/+$/.exec(token.raw)?.[0] ?? '';
  return `#${lead}${renamed}${trail}`;
}

/** `body` with every tag under `from` renamed to `to`; byte-for-byte equal outside those tokens. */
export function renameTagInBody(body: string, from: string, to: string): { body: string; renamed: number } {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const token of findBodyTagTokens(body)) {
    const text = renamedToken(token, from, to);
    if (text !== undefined) edits.push({ start: token.start, end: token.end, text });
  }
  if (edits.length === 0) return { body, renamed: 0 };
  let out = body;
  for (const edit of edits.reverse()) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return { body: out, renamed: edits.length };
}

// ---------------------------------------------------------------------------
// Rename: the front matter
// ---------------------------------------------------------------------------

const FM_KEYS = ['tags', 'labels'] as const;

interface FmBlock {
  eol: string;
  open: string;
  close: string;
  lines: string[];
  /** Offset in the raw text right after the closing line's eol. */
  end: number;
}

/** The leading `---` block of `raw`, or undefined when there is none or it is never closed. */
function locateFrontmatter(raw: string): FmBlock | undefined {
  const first = /^(---[ \t]*)(\r?\n)/.exec(raw);
  if (!first) return undefined;
  const lines: string[] = [];
  let pos = first[0].length;
  while (pos <= raw.length) {
    const nl = raw.indexOf('\n', pos);
    const lineEnd = nl === -1 ? raw.length : nl;
    const line = raw.slice(pos, lineEnd).replace(/\r$/, '');
    const next = nl === -1 ? raw.length : nl + 1;
    if (/^---[ \t]*$/.test(line)) return { eol: first[2], open: first[1], close: line, lines, end: next };
    lines.push(line);
    if (nl === -1) break;
    pos = next;
  }
  return undefined;
}

/** [start, end) line range of the top-level entry `key:` (its indented / `- ` continuation lines included), or undefined unless there is exactly one. */
function entryRange(lines: string[], key: string): [number, number] | undefined {
  const keyRe = new RegExp(`^${key}[ \\t]*:(?:[ \\t]|$)`);
  const found: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!keyRe.test(lines[i])) continue;
    const inline = lines[i].slice(lines[i].indexOf(':') + 1).trim();
    let end = i + 1;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^[ \t]+\S/.test(line) || (inline === '' && /^-(?:[ \t]|$)/.test(line))) {
        end = j + 1;
        continue;
      }
      if (line.trim() === '') continue;
      break;
    }
    found.push([i, end]);
    i = end - 1;
  }
  return found.length === 1 ? found[0] : undefined;
}

/** A YAML scalar for a tag item: plain when it surely reads back as the same string, double-quoted otherwise. */
function yamlScalar(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  return /^\p{L}[\p{L}\p{N}_\-/]*$/u.test(s) && !/^(?:true|false|null)$/i.test(s) ? s : JSON.stringify(s);
}

/** `a: v` -> the parsed `v` (undefined when it does not parse). */
function parseScalar(text: string): unknown {
  try {
    return (matter(`---\nv: ${text}\n---\n`, {}).data as { v?: unknown }).v;
  } catch {
    return undefined;
  }
}

/** One tag item (a string or a number) renamed, keeping a leading `#` it was written with; undefined when it is not under `from`. */
function renamedItem(item: unknown, from: string, to: string): string | undefined {
  if (typeof item !== 'string' && typeof item !== 'number') return undefined;
  const text = String(item);
  const normalized = normalizeTag(text);
  if (!normalized) return undefined;
  const renamed = renamedNormalized(normalized, from, to);
  if (renamed === undefined) return undefined;
  const plain = text.replace(/^#+/, '');
  const hashes = text.slice(0, text.length - plain.length);
  // Keep the written case after the prefix when the item is plain; otherwise the normalized form.
  const tail = plain.toLowerCase() === normalized && plain.length === normalized.length ? plain.slice(from.length) : normalized.slice(from.length);
  return `${hashes}${to}${tail}`;
}

/** The new value of a `tags:`/`labels:` value, or undefined when nothing in it is under `from`. */
function renamedValue(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const r = renamedItem(item, from, to);
      if (r === undefined) return item;
      changed = true;
      return r;
    });
    return changed ? next : undefined;
  }
  if (typeof value === 'string') {
    let changed = false;
    const next = value.replace(/[^\s,]+/g, (token) => {
      const r = renamedItem(token, from, to);
      if (r === undefined) return token;
      changed = true;
      return r;
    });
    return changed ? next : undefined;
  }
  return undefined;
}

/** Splits `text` into the value part and a trailing ` # comment` (YAML needs the space before `#`). */
function splitComment(text: string): { value: string; comment: string } {
  const m = /^(.*?)(\s+#.*)$/.exec(text);
  return m ? { value: m[1], comment: m[2] } : { value: text, comment: '' };
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
    }
    return v;
  });
}

/**
 * The new lines of one entry (`tags:`), keeping its style; undefined when it cannot be rendered.
 * `newValue` is the whole new value (flow lists and strings are written from it); `extras` are the
 * items a block list gets appended after its last item (they are already part of `newValue`).
 */
function renderEntry(entry: string[], newValue: unknown, from: string, to: string, extras: readonly unknown[] = []): string[] | undefined {
  const firstColon = entry[0].indexOf(':');
  const head = entry[0].slice(0, firstColon + 1);
  const inlineRaw = entry[0].slice(firstColon + 1);
  const inline = splitComment(inlineRaw.trim());

  if (inline.value === '') {
    // Block list: rewrite only the `- item` lines whose item changes; comments and everything else stay.
    let prefix = '  - ';
    const out = entry.map((line, i) => {
      if (i === 0) return line;
      const m = /^(\s*-\s+)(.*)$/.exec(line);
      if (!m) return line;
      prefix = m[1];
      const { value, comment } = splitComment(m[2].trim());
      const item = parseScalar(value);
      const renamed = renamedItem(item, from, to);
      return renamed === undefined ? line : `${m[1]}${yamlScalar(renamed)}${comment}`;
    });
    return [...out, ...extras.map((item) => `${prefix}${yamlScalar(item)}`)];
  }
  if (Array.isArray(newValue)) {
    // Flow list (possibly wrapped over several lines): one line again.
    const comment = entry.length === 1 ? inline.comment : '';
    return [`${head} [${newValue.map(yamlScalar).join(', ')}]${comment}`];
  }
  if (typeof newValue === 'string' && entry.length === 1) {
    // A string of tags: keep the quoting it was written with; a plain one stays plain when that reads back the same.
    const rendered = inline.value.startsWith('"')
      ? JSON.stringify(newValue)
      : inline.value.startsWith("'")
        ? `'${newValue.replace(/'/g, "''")}'`
        : /^\p{L}[\p{L}\p{N}_\-/, ]*$/u.test(newValue) && !/^(?:true|false|null)$/i.test(newValue)
          ? newValue
          : JSON.stringify(newValue);
    return [`${head} ${rendered}${inline.comment}`];
  }
  return undefined;
}

/**
 * The file text with the tag renamed in its `tags:` / `labels:` front matter, or
 * undefined when the front matter has nothing under `from` or cannot be edited
 * safely (unparseable block, an entry in a shape this does not handle, or a
 * result that does not parse back to the expected data).
 *
 * `labels:` is a synonym of `tags:` that Folio reads; a rename edits each key
 * that holds the tag IN PLACE, under the key that holds it, with its own style
 * (owner's rule: Folio never deletes or migrates an existing `labels:` key, and
 * never touches a key the rename does not change). The renamed items of an
 * entry are edited one by one.
 */
export function renameTagInFrontmatter(raw: string, from: string, to: string): string | undefined {
  const block = locateFrontmatter(raw);
  if (!block) return undefined;
  let original: Record<string, unknown>;
  try {
    original = structuredClone(matter(raw, {}).data) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(original, key);
  const expected: Record<string, unknown> = { ...original };
  const lines = [...block.lines];
  const edits: Array<{ range: [number, number]; replacement: string[] }> = [];

  for (const key of ['tags', 'labels'] as const) {
    if (!has(key)) continue;
    const next = renamedValue(original[key], from, to);
    if (next === undefined) continue;
    const range = entryRange(lines, key);
    if (!range) return undefined;
    const replacement = renderEntry(lines.slice(range[0], range[1]), next, from, to);
    if (!replacement) return undefined;
    expected[key] = next;
    edits.push({ range, replacement });
  }
  if (edits.length === 0) return undefined;

  edits.sort((a, b) => b.range[0] - a.range[0]);
  for (const { range, replacement } of edits) lines.splice(range[0], range[1] - range[0], ...replacement);
  const candidate = `${block.open}${block.eol}${lines.map((l) => `${l}${block.eol}`).join('')}${block.close}${block.eol}${raw.slice(block.end)}`;
  try {
    const check = matter(candidate, {});
    if (canonical(check.data) !== canonical(expected)) return undefined;
  } catch {
    return undefined;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Rename: the operation
// ---------------------------------------------------------------------------

export interface RenameTagOptions {
  space: string;
  from: string;
  to: string;
  /** The signed-in caller (cookie or PAT user). */
  user: User;
  /** Who the commit is attributed to. */
  actor: git.GitIdentity;
}

/** The normalized `from`/`to` of a request, or a 400. */
export function normalizeRenameTags(fromRaw: string, toRaw: string): { from: string; to: string } {
  const from = normalizeTag(fromRaw);
  const to = normalizeTag(toRaw);
  if (!from) throw badRequest('invalid tag');
  if (!to) throw badRequest('the new tag must contain a letter and must not look like a colour');
  if (from === to) throw badRequest('the new tag is the same as the old one');
  return { from, to };
}

export async function renameTag(options: RenameTagOptions): Promise<RenameTagResult> {
  const { space, user, actor } = options;
  if (!(await storage.spaceExists(space))) throw notFound('space');
  const { from, to } = normalizeRenameTags(options.from, options.to);

  return withSpaceLock(
    space,
    async () => {
      const candidates = await query<{ id: string }>(
        `SELECT DISTINCT p.id
           FROM page_tags t JOIN pages_index p ON p.id = t.page_id
          WHERE p.space_slug = $1 AND p.kind <> 'folder' AND (t.tag = $2 OR t.tag LIKE $3)
          ORDER BY p.id`,
        [space, from, `${escapeLike(from)}/%`],
      );
      const administers = await session.canAdministerSpace(user, space);
      const repoDir = storage.getRepoDir(space);
      const touched: string[] = [];
      let pagesChanged = 0;
      let pagesSkipped = 0;

      for (const { id } of candidates) {
        const entry = await storage.getEntry(id);
        if (!entry) continue;
        if (isAgentPath(entry.relPath) && !administers) continue; // does not exist for this caller
        const role = await session.effectivePageRole(user, entry);
        // A page the caller cannot open does not exist for them: it is neither changed nor counted.
        if (role === undefined) continue;
        if (!session.roleAtLeast(role, 'editor')) {
          pagesSkipped++;
          continue;
        }
        try {
          const changedFile = entry.kind === 'doc' ? ((await renamePageTag(entry, from, to)) ? entry.absPath : undefined) : await renameOwnPropertyTag(entry, from, to);
          if (changedFile) {
            pagesChanged++;
            touched.push(path.relative(repoDir, changedFile).split(path.sep).join('/'));
          }
        } catch (err) {
          // One page that cannot be written must not stop the rest of the rename; it is reported as skipped.
          // eslint-disable-next-line no-console
          console.error(`[tags] could not rename #${from} in ${space}/${entry.relPath}:`, err);
          pagesSkipped++;
        }
      }

      if (touched.length > 0 && (await git.isGitRepo(repoDir))) {
        try {
          const committed = await git.commitPaths(repoDir, touched, `docs: rename tag #${from} -> #${to}`, actor);
          // The commit is local; the next sync (debounced, like every edit) pushes it.
          if (committed) gitSync.noteActivity(space);
        } catch (err) {
          // The files are already rewritten: the debounced auto-commit will pick them up.
          // eslint-disable-next-line no-console
          console.error(`[tags] could not commit the rename of #${from} in ${space}:`, err);
          gitSync.noteActivity(space);
        }
      }
      return { pagesChanged, pagesSkipped };
    },
    { ttlMs: 120_000, waitMs: 15_000 },
  );
}

/**
 * Renames the tag in the own properties of a table / form (its front matter, next to the reserved keys — only
 * `tags:` / `labels:` lines change) or a board / file (its sidecar). Returns the file written, or undefined.
 */
async function renameOwnPropertyTag(entry: storage.PageIndexEntry, from: string, to: string): Promise<string | undefined> {
  const ref = { id: entry.id, space: entry.space, relPath: entry.relPath };
  if (entry.kind === 'table' || entry.kind === 'form') {
    let own: Record<string, unknown> = {};
    const { written } = await storage.rewriteTableFormFrontmatter(entry.id, (raw, fresh) => {
      const next = renameTagInFrontmatter(raw, from, to);
      if (next === undefined) return null;
      own = ownProperties(fresh.kind, matter(next, {}).data as Record<string, unknown>);
      return next;
    });
    if (!written) return undefined;
    await reindexSavedPage(ref, '', own);
    return entry.absPath;
  }
  if (entry.kind === 'artifact') {
    // The manifest's `tags:` (artifact.yaml is a plain mapping, edited like a sidecar). This runs under the space
    // lock already, so the page is re-indexed by a scoped scan rather than storage.rewriteArtifactPage (which locks).
    const text = await readManifestText(entry.absPath);
    if (text === null || !parseSidecar(text).parseable) return undefined;
    const renamed = renameTagInFrontmatter(wrapSidecar(text), from, to);
    if (renamed === undefined) return undefined;
    await writeManifestFile(entry.absPath, unwrapSidecar(renamed));
    await storage.scanPaths(entry.space, { files: [entry.relPath] });
    return path.join(entry.absPath, ARTIFACT_MANIFEST_FILE);
  }
  if (!usesSidecar(entry.kind)) return undefined;
  const root = storage.getSpaceDir(entry.space);
  const text = await readSidecarText(root, entry.relPath);
  if (text === null || !parseSidecar(text).parseable) return undefined;
  const renamed = renameTagInFrontmatter(wrapSidecar(text), from, to);
  if (renamed === undefined) return undefined;
  const next = unwrapSidecar(renamed);
  await putSidecarText(root, entry.relPath, next);
  await query('UPDATE pages_index SET updated_at = $2 WHERE id = $1', [entry.id, new Date().toISOString()]);
  await storage.reindexSidecarProperties(entry, parseSidecar(next).data);
  return path.join(root, ...sidecarRelPath(entry.relPath).split('/'));
}

/** Renames the tag in one page's body and front matter. True when the page changed. */
async function renamePageTag(entry: storage.PageIndexEntry, from: string, to: string): Promise<boolean> {
  const raw = await fs.readFile(entry.absPath, 'utf8').catch(() => undefined);
  if (raw === undefined) return false;
  let fileBody: string;
  try {
    fileBody = matter(raw, {}).content;
  } catch {
    return false; // a front matter block YAML refuses: left alone
  }
  const currentBody = collab.isDocLive(entry.id) ? (collab.getLiveText(entry.id) ?? fileBody) : fileBody;

  const nextBody = renameTagInBody(currentBody, from, to);
  const nextRaw = renameTagInFrontmatter(raw, from, to);
  if (nextBody.renamed === 0 && nextRaw === undefined) return false;

  // Front matter first (outside the collaborative text; the body write below merges with the file as it is then).
  if (nextRaw !== undefined) await storage.writeFileAtomic(entry.absPath, nextRaw);
  if (nextBody.renamed > 0) {
    await collab.editDocBody(entry.id, nextBody.body);
    await collab.flushDoc(entry.id);
  } else {
    // Only the front matter changed: rebuild the page's index rows and stamp the change.
    await query('UPDATE pages_index SET updated_at = $2 WHERE id = $1', [entry.id, new Date().toISOString()]);
    await reindexSavedPage({ id: entry.id, space: entry.space, relPath: entry.relPath }, currentBody, matter(nextRaw!, {}).data as Record<string, unknown>);
  }
  return true;
}
