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
 */
import * as matterNS from 'gray-matter';

// Same CJS interop fallback as storage.ts.
const matter = (typeof matterNS === 'function' ? matterNS : (matterNS as unknown as { default: typeof matterNS }).default) as typeof matterNS;

/** Folio's own front matter keys, in the order a freshly written block lists them. */
export const FOLIO_FRONTMATTER_KEYS = ['id', 'order', 'status', 'icon', 'cover'] as const;
type FolioKey = (typeof FOLIO_FRONTMATTER_KEYS)[number];
const FOLIO_KEY_SET: ReadonlySet<string> = new Set(FOLIO_FRONTMATTER_KEYS);

/**
 * The values Folio wants in the block. `order`/`status`/`icon`/`cover`:
 * a value sets the key, undefined removes it. `id`: a string sets it, null
 * removes it, undefined leaves whatever the file has (a light-footprint space
 * never adds an id, but keeps one the file already carries).
 */
export interface FolioFrontmatter {
  id?: string | null;
  order?: number;
  status?: string;
  icon?: string;
  cover?: string;
}

/** The body as it reads back from the file: a trailing newline guaranteed (see storage.ts docFileBody). */
function withTrailingNewline(body: string): string {
  return body.endsWith('\n') ? body : `${body}\n`;
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
    if (/^---[ \t]*$/.test(line)) return { eol, open: first[1], close: line, lines, end: next };
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
  const ranges = new Map<FolioKey, Array<[number, number]>>();
  for (let i = 0; i < lines.length; i++) {
    const key = topLevelKey(lines[i]);
    if (!key || !FOLIO_KEY_SET.has(key)) continue;
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
    const list = ranges.get(key as FolioKey) ?? [];
    list.push([i, end]);
    ranges.set(key as FolioKey, list);
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
  const content = withTrailingNewline(body);
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
      if (!present) continue;
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
