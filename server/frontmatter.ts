/**
 * Front matter merge for doc files (pure, no I/O).
 *
 * A Markdown file in a connected repository often carries front matter that
 * belongs to another tool — Docusaurus `sidebar_position`/`slug`, MkDocs/Hugo/
 * Jekyll `title`, `tags`, `description`, comments. Folio owns exactly five
 * top-level keys (FOLIO_FRONTMATTER_KEYS) and must never touch anything else.
 * mergeFrontmatter edits only the lines of those keys in the existing block's
 * TEXT, so every other key keeps its order, quoting, comments and list style.
 *
 * The line edit is checked by re-parsing the result: if the parsed data is not
 * exactly "the original data with Folio's keys updated", the block is
 * re-serialized from the parsed data instead (formatting and comments are lost
 * then, the data never is). A block that cannot be parsed at all is kept
 * verbatim — only a block made of nothing but Folio's own keys is rewritten.
 *
 * writeFrontmatterKeys (wave 3, the properties panel) is the same line editor
 * for ANY top-level key: set, add, remove — see its own comment.
 */
import * as matterNS from 'gray-matter';

// Same CJS interop fallback as storage.ts.
const matter = (typeof matterNS === 'function' ? matterNS : (matterNS as unknown as { default: typeof matterNS }).default) as typeof matterNS;

/** Folio's own front matter keys, in the order a freshly written block lists them. */
export const FOLIO_FRONTMATTER_KEYS = ['id', 'order', 'status', 'icon', 'cover'] as const;
export type FolioKey = (typeof FOLIO_FRONTMATTER_KEYS)[number];
const FOLIO_KEY_SET: ReadonlySet<string> = new Set(FOLIO_FRONTMATTER_KEYS);

/**
 * The values Folio wants in the block. `order`/`status`/`icon`/`cover`:
 * a value sets the key, undefined removes it — but only a value Folio itself
 * reads and could have written (folioCouldHaveWritten); another tool's
 * `status: deprecated` is kept. `id`: a string sets it, null removes it,
 * undefined leaves whatever the file has (a light-footprint space never adds
 * an id, but keeps one the file already carries).
 */
export interface FolioFrontmatter {
  id?: string | null;
  order?: number;
  status?: string;
  icon?: string;
  cover?: string;
}

/**
 * The body as written to the file: with a trailing newline, unless the file it
 * replaces ends without one — a file Folio did not write keeps its last byte
 * (storage.ts docFileBody compares bodies with the final newline aside). An
 * empty body stays empty: a block with nothing under it is not given a blank line.
 */
function fileContent(baseRaw: string | undefined, body: string): string {
  if (body === '' || body.endsWith('\n')) return body;
  return baseRaw && !baseRaw.endsWith('\n') ? body : `${body}\n`;
}

/** The line ending of the file being replaced, by its first line break. */
function eolOf(raw: string | undefined): '\n' | '\r\n' {
  const nl = raw ? raw.indexOf('\n') : -1;
  return nl > 0 && raw![nl - 1] === '\r' ? '\r\n' : '\n';
}

const toCrlf = (text: string): string => text.replace(/\r?\n/g, '\r\n');

/** Whether `raw` mixes CRLF and bare LF line breaks (LF front matter over a CRLF body, say). */
function hasMixedEol(raw: string | undefined): boolean {
  if (!raw) return false;
  const lf = (raw.match(/\n/g) ?? []).length;
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  return crlf > 0 && crlf < lf;
}

/** Lines without their breaks (a `\r` before `\n` is part of the break), and each line's break ('' for a last line without one). */
function splitLinesWithEol(text: string): { lines: string[]; eols: string[] } {
  const lines: string[] = [];
  const eols: string[] = [];
  const re = /\r?\n/g;
  let pos = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    lines.push(text.slice(pos, m.index));
    eols.push(m[0]);
    pos = m.index + m[0].length;
  }
  if (pos < text.length) {
    lines.push(text.slice(pos));
    eols.push('');
  }
  return { lines, eols };
}

/** Above this many line pairs in the changed middle of a file, lines are paired by position instead of by an LCS. */
const MAX_EOL_LCS_CELLS = 2_000_000;

/**
 * `out` with every line break taken from the line of `baseRaw` it came from:
 * an unchanged line keeps its own `\n` or `\r\n`, a changed or new line takes
 * the break of the line it replaces (else of the line before it). So an edit of
 * one line of a file with mixed line endings is a one-line diff. A last line
 * without a break stays without one.
 */
export function keepLineEndings(baseRaw: string, out: string): string {
  const a = splitLinesWithEol(baseRaw);
  const b = splitLinesWithEol(out);
  const lfCount = a.eols.filter((e) => e === '\n').length;
  const crlfCount = a.eols.filter((e) => e === '\r\n').length;
  const dominant = crlfCount > lfCount ? '\r\n' : '\n';
  const na = a.lines.length;
  const nb = b.lines.length;

  // b line -> a line it is unchanged from (-1: changed or new)
  const match = new Int32Array(nb).fill(-1);
  let pre = 0;
  while (pre < na && pre < nb && a.lines[pre] === b.lines[pre]) {
    match[pre] = pre;
    pre++;
  }
  let suf = 0;
  while (suf < na - pre && suf < nb - pre && a.lines[na - 1 - suf] === b.lines[nb - 1 - suf]) {
    match[nb - 1 - suf] = na - 1 - suf;
    suf++;
  }
  const ma = na - pre - suf;
  const mb = nb - pre - suf;
  if (ma > 0 && mb > 0 && ma * mb <= MAX_EOL_LCS_CELLS) {
    // LCS of the changed middle.
    const w = mb + 1;
    const dp = new Uint32Array((ma + 1) * w);
    for (let i = ma - 1; i >= 0; i--) {
      for (let j = mb - 1; j >= 0; j--) {
        dp[i * w + j] = a.lines[pre + i] === b.lines[pre + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < ma && j < mb) {
      if (a.lines[pre + i] === b.lines[pre + j]) {
        match[pre + j] = pre + i;
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
      else j++;
    }
  }

  const aMatched = new Uint8Array(na);
  for (let j = 0; j < nb; j++) if (match[j] >= 0) aMatched[match[j]] = 1;
  let result = '';
  let nextA = 0; // the base line a changed line replaces
  for (let j = 0; j < nb; j++) {
    let eol: string;
    if (b.eols[j] === '') eol = '';
    else if (match[j] >= 0) {
      nextA = match[j] + 1;
      eol = a.eols[match[j]] || (nextA - 2 >= 0 ? a.eols[nextA - 2] || dominant : dominant);
    } else {
      const replaced = nextA < na && !aMatched[nextA] ? nextA : -1;
      eol = (replaced >= 0 ? a.eols[replaced] : '') || (nextA > 0 ? a.eols[nextA - 1] : '') || dominant;
      if (replaced >= 0) nextA++;
    }
    result += b.lines[j] + eol;
  }
  return result;
}

/** gray-matter caches parses by input and keeps a half-parsed entry when YAML throws; passing options bypasses that cache so a bad block throws every time. */
function parseFile(raw: string): { data: Record<string, unknown>; content: string } {
  const parsed = matter(raw, {});
  return { data: structuredClone(parsed.data) as Record<string, unknown>, content: parsed.content };
}

/** What Folio wants for `key`: { set } / { remove } / undefined (leave it). */
function intentFor(update: FolioFrontmatter, key: FolioKey): { set: unknown } | { remove: true } | undefined {
  const value = update[key];
  if (key === 'id') {
    if (value === undefined) return undefined;
    if (value === null) return { remove: true };
    return { set: value };
  }
  return value === undefined ? { remove: true } : { set: value };
}

/**
 * Whether `value` is something Folio reads back under `key` (storage.ts
 * validStatus / numericOrder / validStringField) and so could have written
 * itself. Folio reads nothing else there, so a save — which passes undefined
 * for a key it did not read — must not take such a value for "cleared": MkDocs'
 * `status: deprecated` vanished from files that were merely opened. A remove
 * of the id is always deliberate (a copy must never share its source's id).
 */
export function folioCouldHaveWritten(key: FolioKey, value: unknown): boolean {
  switch (key) {
    case 'status':
      return value === 'draft' || value === 'published' || value === 'archived';
    case 'order':
      return typeof value === 'number' && Number.isFinite(value);
    case 'icon':
    case 'cover':
      return typeof value === 'string' && value.trim() !== '';
    default:
      return true;
  }
}

function freshFile(update: FolioFrontmatter, content: string): string {
  const fm: Record<string, unknown> = {};
  for (const key of FOLIO_FRONTMATTER_KEYS) {
    const intent = intentFor(update, key);
    if (intent && 'set' in intent) fm[key] = intent.set;
  }
  if (Object.keys(fm).length === 0) return content;
  return matter.stringify(content, fm);
}

/** `key: value` as js-yaml writes it (possibly several lines, e.g. a folded long string). */
function renderEntry(key: string, value: unknown): string[] {
  const out = matter.stringify('', { [key]: value });
  const lines = out.split('\n');
  const close = lines.indexOf('---', 1);
  return lines.slice(1, close);
}

/** Canonical JSON for deep comparison: object keys sorted, Dates as ISO strings. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
    }
    return v;
  });
}

interface Block {
  eol: string;
  /** The opening `---` line, verbatim (without eol). */
  open: string;
  /** The closing `---` line, verbatim (without eol). */
  close: string;
  lines: string[];
  /** Offset in the raw text right after the opening line's eol. */
  openEnd: number;
  /** Offset in the raw text where the closing line starts. */
  closeStart: number;
  /** Offset in the raw text right after the closing line's eol. */
  end: number;
}

/** The leading `---` block of `raw`, or undefined when there is none (or it is never closed). */
function locateBlock(raw: string): Block | undefined | 'unterminated' {
  const first = /^(---[ \t]*)(\r?\n)/.exec(raw);
  if (!first) return undefined;
  const eol = first[2];
  const lines: string[] = [];
  let pos = first[0].length;
  while (pos <= raw.length) {
    const nl = raw.indexOf('\n', pos);
    const lineEnd = nl === -1 ? raw.length : nl;
    const line = raw.slice(pos, lineEnd).replace(/\r$/, '');
    const next = nl === -1 ? raw.length : nl + 1;
    if (/^---[ \t]*$/.test(line)) return { eol, open: first[1], close: line, lines, openEnd: first[0].length, closeStart: pos, end: next };
    lines.push(line);
    if (nl === -1) break;
    pos = next;
  }
  return 'unterminated';
}

const KEY_LINE_RE = /^(?:"([^"\\]*)"|'([^']*)'|([^\s#'"\-?:,[\]{}&*!|>%@`][^:#]*?|-[^\s:#][^:#]*?))[ \t]*:(?:[ \t]|$)/;

/** The top-level key a block line starts, if any (a column-0 `key:` line). */
function topLevelKey(line: string): string | undefined {
  const m = KEY_LINE_RE.exec(line);
  if (!m) return undefined;
  return m[1] ?? m[2] ?? m[3];
}

/** [start, end) line ranges of every top-level entry whose key is one of Folio's. */
function folioEntryRanges(lines: string[]): Map<FolioKey, Array<[number, number]>> {
  return entryRanges(lines, FOLIO_KEY_SET) as Map<FolioKey, Array<[number, number]>>;
}

/** [start, end) line ranges of every top-level entry whose key is in `keys`. */
function entryRanges(lines: string[], keys: ReadonlySet<string>): Map<string, Array<[number, number]>> {
  const ranges = new Map<string, Array<[number, number]>>();
  for (let i = 0; i < lines.length; i++) {
    const key = topLevelKey(lines[i]);
    if (!key || !keys.has(key)) continue;
    const inlineValue = lines[i].slice(lines[i].indexOf(':') + 1).trim();
    let end = i + 1;
    // Continuation: indented lines (block scalars, nested maps, wrapped scalars),
    // blank lines followed by more of them, and a column-0 `- item` list when the
    // key itself has no inline value.
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^[ \t]+\S/.test(line) || (inlineValue === '' && /^-(?:[ \t]|$)/.test(line))) {
        end = j + 1;
        continue;
      }
      if (line.trim() === '') continue;
      break;
    }
    const list = ranges.get(key) ?? [];
    list.push([i, end]);
    ranges.set(key, list);
    i = end - 1;
  }
  return ranges;
}

/**
 * A block that YAML refuses: rewritten only when it holds nothing but Folio's
 * own one-line keys (it is Folio's own block, hand-broken); otherwise kept
 * byte for byte and only the body is replaced. When the body already starts
 * with that very block (an unparseable file is indexed — and edited — as its
 * raw text), the body IS the whole file.
 */
function mergeUnparseable(raw: string, block: Block | 'unterminated', update: FolioFrontmatter, content: string): string {
  if (block !== 'unterminated') {
    const onlyFolio = block.lines.every((line) => {
      if (line.trim() === '' || line.trimStart().startsWith('#')) return true;
      const key = topLevelKey(line);
      return key !== undefined && FOLIO_KEY_SET.has(key);
    });
    if (onlyFolio) return freshFile(update, content);
  }
  const blockText = block === 'unterminated' ? raw : raw.slice(0, block.end);
  if (content.startsWith(blockText)) return content;
  return blockText + content;
}

/**
 * The file text for `body` with Folio's keys set per `update`, keeping every
 * other key of `baseRaw`'s leading block (the file as it is on disk now, or
 * the source of a copy). `baseRaw` undefined or without a block: a fresh
 * block with Folio's keys only — or no block at all when there is nothing
 * to write.
 */
export function mergeFrontmatter(baseRaw: string | undefined, update: FolioFrontmatter, body: string): string {
  // A CRLF file stays CRLF: the body arrives with "\n" only (a collab room never
  // holds "\r", see collab.ts normalizeEol), and writing it as is turned every
  // line of such a file into a change.
  // A file that mixes the two (LF front matter over a CRLF body, say) keeps each
  // line's own ending: an edit of one line is a one-line diff (keepLineEndings).
  if (hasMixedEol(baseRaw)) return keepLineEndings(baseRaw!, mergeBlock(baseRaw, update, fileContent(baseRaw, body)));
  const crlf = eolOf(baseRaw) === '\r\n';
  const content = fileContent(baseRaw, crlf ? toCrlf(body) : body);
  const merged = mergeBlock(baseRaw, update, content);
  return crlf ? toCrlf(merged) : merged;
}

function mergeBlock(baseRaw: string | undefined, update: FolioFrontmatter, content: string): string {
  const block = baseRaw === undefined ? undefined : locateBlock(baseRaw);
  if (block === undefined || baseRaw === undefined) return freshFile(update, content);

  let original: Record<string, unknown>;
  try {
    if (block === 'unterminated') throw new Error('unterminated front matter');
    original = parseFile(baseRaw).data;
  } catch {
    return mergeUnparseable(baseRaw, block, update, content);
  }

  // The data the result must parse back to: original keys in their order,
  // Folio's updated in place, new ones appended.
  const expected: Record<string, unknown> = { ...original };
  const lines = [...block.lines];
  const ranges = folioEntryRanges(lines);
  const edits: Array<{ range: [number, number]; replacement: string[] }> = [];
  const appended: string[] = [];
  let removedSomething = false;
  let consistent = true;

  for (const key of FOLIO_FRONTMATTER_KEYS) {
    const intent = intentFor(update, key);
    if (!intent) continue;
    const present = Object.prototype.hasOwnProperty.call(original, key);
    const found = ranges.get(key) ?? [];
    if (found.length !== (present ? 1 : 0)) consistent = false;
    if ('remove' in intent) {
      if (!present || !folioCouldHaveWritten(key, original[key])) continue;
      delete expected[key];
      if (found[0]) edits.push({ range: found[0], replacement: [] });
      removedSomething = true;
      continue;
    }
    expected[key] = intent.set;
    if (present && canonical(original[key]) === canonical(intent.set)) continue; // already right: the user's own spelling stays
    if (present && found[0]) edits.push({ range: found[0], replacement: renderEntry(key, intent.set) });
    else if (!present) appended.push(...renderEntry(key, intent.set));
  }

  if (consistent) {
    edits.sort((a, b) => b.range[0] - a.range[0]);
    for (const { range, replacement } of edits) lines.splice(range[0], range[1] - range[0], ...replacement);
    // Appended after the last non-blank line, so a trailing blank line stays trailing.
    let insertAt = lines.length;
    while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, ...appended);

    const candidate =
      removedSomething && lines.every((line) => line.trim() === '')
        ? content
        : `${block.open}${block.eol}${lines.map((line) => `${line}${block.eol}`).join('')}${block.close}${block.eol}${content}`;
    try {
      const check = parseFile(candidate);
      if (check.content === content && canonical(check.data) === canonical(expected)) return candidate;
    } catch {
      /* falls through to the data-preserving rewrite below */
    }
  }

  // eslint-disable-next-line no-console
  console.warn('[frontmatter] could not edit the block in place; rewriting it from its parsed data (comments and formatting are not kept)');
  if (Object.keys(expected).length === 0) return content;
  return matter.stringify(content, expected);
}

// ---------------------------------------------------------------------------
// Any key (wave 3): the properties panel
// ---------------------------------------------------------------------------

/** The leading block of a file that YAML refuses (or that is never closed): its keys cannot be edited. */
export class UnparseableFrontmatterError extends Error {
  constructor() {
    super('the front matter of this page cannot be parsed');
  }
}

/** What a file's leading block holds, for the properties panel. */
export interface FrontmatterBlockInfo {
  /** The block's raw text, delimiters and their line ends included; '' when the file has none. */
  text: string;
  /** The block as parsed ({} when there is none, or when it cannot be parsed). */
  data: Record<string, unknown>;
  parseable: boolean;
}

export function readFrontmatterBlock(raw: string): FrontmatterBlockInfo {
  const block = locateBlock(raw);
  if (block === undefined) return { text: '', data: {}, parseable: true };
  if (block === 'unterminated') return { text: raw, data: {}, parseable: false };
  try {
    return { text: raw.slice(0, block.end), data: parseFile(raw).data, parseable: true };
  } catch {
    return { text: raw.slice(0, block.end), data: {}, parseable: false };
  }
}

/** One key's change for writeFrontmatterKeys. `lines` replaces js-yaml's rendering of `set` (the caller's own spelling, e.g. an unquoted date). */
export type FrontmatterKeyEdit = { set: unknown; lines?: string[] } | { remove: true };

/** The parsed value of an entry's lines (what the block will hold for that key). Throws on lines YAML refuses. */
export function parsedEntry(key: string, lines: string[]): unknown {
  return parseFile(`---\n${lines.join('\n')}\n---\n`).data[key];
}

/** The entry as js-yaml writes it — `key:` alone for null, like Obsidian writes an empty property. */
export function renderFrontmatterEntry(key: string, value: unknown): string[] {
  if (value === null) {
    const [first] = renderEntry(key, null);
    return [first.replace(/:[ \t]*null$/, ':')];
  }
  return renderEntry(key, value);
}

/**
 * Sets and removes ANY top-level keys of the leading front matter block of
 * `raw` (the whole file), keeping every other byte of the file — the body, the
 * other keys with their order, quoting, comments and list style, the line
 * endings, the delimiters as written:
 *  - a key that is already the value asked for keeps its own spelling;
 *  - a changed key is rewritten IN PLACE (its lines replaced by js-yaml's
 *    rendering, or the caller's `lines`): lists in block style (`  - item`),
 *    strings quoted only when YAML needs it, null as `key:`;
 *  - a new key is appended after the block's last non-blank line;
 *  - a removed key loses its lines (continuations included); a block left
 *    with nothing in it (no key, no comment) goes away with its delimiters;
 *  - no block yet: one is created at the top of the file.
 * Like mergeFrontmatter, the edit is checked by re-parsing: the result must be
 * the original data with exactly these changes, and the body as it was. When
 * the line edit cannot guarantee that (a key written twice, a flow mapping
 * spanning the key), the block is re-serialized from the expected data —
 * comments and formatting of the block are lost then, never data or a body
 * byte. A block YAML refuses throws UnparseableFrontmatterError: nothing is
 * guessed about a block nobody can read. Returns `raw` itself when nothing
 * changes.
 */
export function writeFrontmatterKeys(raw: string, edits: ReadonlyMap<string, FrontmatterKeyEdit>): string {
  const out = writeKeys(raw, edits);
  // Mixed line endings: every line keeps its own (see keepLineEndings).
  return out !== raw && hasMixedEol(raw) ? keepLineEndings(raw, out) : out;
}

function writeKeys(raw: string, edits: ReadonlyMap<string, FrontmatterKeyEdit>): string {
  const block = locateBlock(raw);
  if (block === 'unterminated') throw new UnparseableFrontmatterError();

  const rendered = new Map<string, { lines: string[]; value: unknown }>();
  for (const [key, edit] of edits) {
    if (!('set' in edit)) continue;
    const lines = edit.lines ?? renderFrontmatterEntry(key, edit.set);
    rendered.set(key, { lines, value: parsedEntry(key, lines) });
  }

  if (block === undefined) {
    if (rendered.size === 0) return raw;
    const eol = eolOf(raw);
    const lines = [...rendered.values()].flatMap((r) => r.lines);
    return `---${eol}${lines.map((line) => `${line}${eol}`).join('')}---${eol}${raw}`;
  }

  let original: Record<string, unknown>;
  let originalContent: string;
  try {
    const parsed = parseFile(raw);
    original = parsed.data;
    originalContent = parsed.content;
  } catch {
    throw new UnparseableFrontmatterError();
  }

  const expected: Record<string, unknown> = { ...original };
  const lines = [...block.lines];
  const ranges = entryRanges(lines, new Set(edits.keys()));
  const replacements: Array<{ range: [number, number]; replacement: string[] }> = [];
  const appended: string[] = [];
  let consistent = true;
  let changed = false;

  for (const [key, edit] of edits) {
    const present = Object.prototype.hasOwnProperty.call(original, key);
    const found = ranges.get(key) ?? [];
    if (found.length !== (present ? 1 : 0)) consistent = false;
    if (!('set' in edit)) {
      if (!present) continue;
      delete expected[key];
      if (found[0]) replacements.push({ range: found[0], replacement: [] });
      changed = true;
      continue;
    }
    const r = rendered.get(key)!;
    expected[key] = r.value;
    if (present && canonical(original[key]) === canonical(r.value)) continue; // already right: the file's own spelling stays
    changed = true;
    if (present && found[0]) replacements.push({ range: found[0], replacement: r.lines });
    else if (!present) appended.push(...r.lines);
  }
  if (!changed) return raw;

  const head = raw.slice(0, block.openEnd);
  const tail = raw.slice(block.closeStart);
  const join = (out: string[]) => `${head}${out.map((line) => `${line}${block.eol}`).join('')}${tail}`;
  const verified = (candidate: string): boolean => {
    try {
      const check = parseFile(candidate);
      return check.content === originalContent && canonical(check.data) === canonical(expected);
    } catch {
      return false;
    }
  };

  if (consistent) {
    replacements.sort((a, b) => b.range[0] - a.range[0]);
    for (const { range, replacement } of replacements) lines.splice(range[0], range[1] - range[0], ...replacement);
    let insertAt = lines.length;
    while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, ...appended);

    if (Object.keys(expected).length === 0 && lines.every((line) => line.trim() === '')) {
      // Nothing left at all (a comment would keep the block): the block goes, the body stays byte for byte.
      const body = raw.slice(block.end);
      if (verified(body)) return body;
    }
    const candidate = join(lines);
    if (verified(candidate)) return candidate;
  }

  // eslint-disable-next-line no-console
  console.warn('[frontmatter] could not edit the block in place; rewriting it from its parsed data (comments and formatting are not kept)');
  const fallback = Object.keys(expected).length === 0 ? [] : renderData(expected);
  const candidate = join(fallback);
  if (!verified(candidate)) throw new Error('front matter rewrite does not round-trip');
  return candidate;
}

/** A whole mapping as js-yaml writes it, one array entry per line. */
function renderData(data: Record<string, unknown>): string[] {
  const out = matter.stringify('', data);
  const lines = out.split('\n');
  const close = lines.indexOf('---', 1);
  return lines.slice(1, close);
}

/**
 * Carries the top-level keys `keep` picks from the front matter of `prev`
 * (the file as it was) into `next` (the same file as a codec just rebuilt it),
 * when `next` does not have them — byte for byte, each entry's own lines
 * appended before `next`'s closing `---`. Used for `.table.md` / `.form.md`
 * files: the codecs (shared/tables, shared/forms) rebuild the block from
 * Folio's reserved keys only, so without this every table or form save would
 * drop the page's own properties. A key `next` already has wins (the codec's
 * value). Checked by re-parsing; when the line copy does not round-trip, the
 * values are written with js-yaml instead (the data is never lost). `prev`
 * without a readable block, or nothing to carry: `next` itself.
 */
export function carryFrontmatterKeys(next: string, prev: string | undefined, keep: (key: string) => boolean): string {
  if (!prev) return next;
  const prevBlock = locateBlock(prev);
  if (!prevBlock || prevBlock === 'unterminated') return next;
  let prevData: Record<string, unknown>;
  let nextParsed: { data: Record<string, unknown>; content: string };
  try {
    prevData = parseFile(prev).data;
    nextParsed = parseFile(next);
  } catch {
    return next;
  }
  const missing = Object.keys(prevData).filter((key) => keep(key) && !Object.prototype.hasOwnProperty.call(nextParsed.data, key));
  if (missing.length === 0) return next;
  const expected: Record<string, unknown> = { ...nextParsed.data };
  for (const key of missing) expected[key] = prevData[key];

  const nextBlock = locateBlock(next);
  if (nextBlock !== 'unterminated') {
    const ranges = entryRanges(prevBlock.lines, new Set(missing));
    const carried: string[] = [];
    let complete = true;
    for (const key of missing) {
      const found = ranges.get(key);
      if (!found || found.length !== 1) {
        complete = false;
        break;
      }
      carried.push(...prevBlock.lines.slice(found[0][0], found[0][1]));
    }
    if (complete) {
      let candidate: string;
      if (nextBlock) {
        const lines = [...nextBlock.lines];
        let insertAt = lines.length;
        while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt--;
        lines.splice(insertAt, 0, ...carried);
        candidate = `${next.slice(0, nextBlock.openEnd)}${lines.map((line) => `${line}${nextBlock.eol}`).join('')}${next.slice(nextBlock.closeStart)}`;
      } else {
        const eol = eolOf(next);
        candidate = `---${eol}${carried.map((line) => `${line}${eol}`).join('')}---${eol}${next}`;
      }
      try {
        const check = parseFile(candidate);
        if (check.content === nextParsed.content && canonical(check.data) === canonical(expected)) return candidate;
      } catch {
        /* js-yaml below */
      }
    }
  }
  return writeFrontmatterKeys(next, new Map(missing.map((key) => [key, { set: prevData[key] }])));
}
