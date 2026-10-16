/**
 * The ONE markdown parse the server's link handling agrees on (index v2,
 * Obsidian brief wave 1b): remark-parse + GFM + `++underline++`, positions on —
 * the same processor the web's outline uses. The page index
 * (server/indexV2/parse.ts) reads headings, blocks, tags and links from this
 * tree, and the rename/move rewriters (links.ts, wikilinks.ts) take their
 * "what is code" answer from it too (codeRanges/maskCode), so a link that the
 * index does not see — inside a fenced, indented or inline code span — is also
 * never rewritten.
 */
import type { Nodes, Root } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { remarkUnderline } from '../shared/underline.js';

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkUnderline);

/** The mdast of a page body (front matter already removed). */
export function parseMarkdownAst(body: string): Root {
  return processor.parse(body) as Root;
}

// ---------------------------------------------------------------------------
// Big documents: a linear, chunked parse (16.10.2026)
// ---------------------------------------------------------------------------
//
// micromark is not linear on every construct: a GFM table of 200 KB takes ~15 s
// to parse, 1.5 MB minutes (≈ quadratic); a long list, a long block quote and a
// paragraph with thousands of links grow faster than their size too. The boot
// scan parses every document again after an INDEX_META_VERSION bump, and on
// 15.10.2026 one such document blocked the event loop for 339 s — the health
// check timed out and the proxy answered 503 for minutes.
//
// So the readers that need only what the index needs (headings, tags, links,
// block ids, code ranges) parse a big body in CHUNKS of about PARSE_CHUNK_CHARS,
// cut only at the start of a line that begins at column 0 (never inside a fenced
// code block, an HTML comment or a <pre>/<script>/<style>/<textarea> block,
// never before a setext underline), preferring a line after a blank one. Each
// chunk is parsed on its own and its positions shifted back to the body's, so
// offsets and lines are the body's. What changes is only structure the index
// does not read: a table cut in two continues as a paragraph (its cells' links
// and tags are found the same), one long paragraph may become two. Reference
// definitions (`[label]: url`) are given to every chunk, so `[text][label]` still
// resolves across a cut. parseMarkdownAstAsync yields to the event loop between
// chunks, so a request is never stuck behind one big document.

/** Target chunk size (characters): ~100 ms of parsing in the worst construct measured (a GFM table). */
export const PARSE_CHUNK_CHARS = 16_000;
/** Bodies up to this size are parsed in one piece, exactly as before. */
export const PARSE_CHUNK_THRESHOLD = 32_000;

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const RAW_HTML_OPEN_RE = /^ {0,3}<(pre|script|style|textarea)(?:\s|>|$)/i;
const SETEXT_RE = /^(?:=+|-+)[ \t]*$/;
const DEFINITION_RE = /^ {0,3}\[(?:[^\]\\\n]|\\.)+\]:/;
const DEFINITIONS_MAX_CHARS = 64_000;

/** Where a big body is cut: [start, end) offsets covering it, in order; one piece when it is small or has no safe cut. */
export function parseChunks(body: string, max = PARSE_CHUNK_CHARS): Array<[number, number]> {
  if (body.length <= Math.max(max, PARSE_CHUNK_THRESHOLD)) return [[0, body.length]];
  const out: Array<[number, number]> = [];
  let chunkStart = 0;
  let fence: { ch: string; len: number } | null = null;
  let htmlComment = false;
  let rawHtml: string | null = null;
  let prevBlank = false;
  let pos = 0;
  while (pos < body.length) {
    const nl = body.indexOf('\n', pos);
    const end = nl === -1 ? body.length : nl;
    const line = body.slice(pos, end).replace(/\r$/, '');
    const blank = line.trim() === '';
    if (!fence && !htmlComment && !rawHtml && !blank && pos > chunkStart) {
      const size = pos - chunkStart;
      const col0 = line[0] !== ' ' && line[0] !== '\t';
      if (col0 && !SETEXT_RE.test(line) && ((prevBlank && size >= max / 2) || size >= max)) {
        out.push([chunkStart, pos]);
        chunkStart = pos;
      }
    }
    // State after this line. Fences are recognised under block-quote markers too (`> ```).
    const inner = line.replace(/^(?: {0,3}>[ \t]?)+/, '');
    if (fence) {
      const m = FENCE_RE.exec(inner);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && inner.slice(inner.indexOf(m[1]) + m[1].length).trim() === '') fence = null;
    } else if (htmlComment) {
      if (line.includes('-->')) htmlComment = false;
    } else if (rawHtml) {
      if (line.toLowerCase().includes(`</${rawHtml}`)) rawHtml = null;
    } else {
      const f = FENCE_RE.exec(inner);
      if (f) fence = { ch: f[1][0], len: f[1].length };
      else {
        const open = line.lastIndexOf('<!--');
        if (open !== -1 && line.indexOf('-->', open + 4) === -1) htmlComment = true;
        const raw = RAW_HTML_OPEN_RE.exec(line);
        if (raw && !line.toLowerCase().includes(`</${raw[1].toLowerCase()}`)) rawHtml = raw[1].toLowerCase();
      }
    }
    prevBlank = blank;
    pos = nl === -1 ? body.length : nl + 1;
  }
  out.push([chunkStart, body.length]);
  return out;
}

/** The reference definitions of `body` (lines `[label]: url`), joined — given to every chunk; '' when none or too many. */
function definitionLines(body: string): string {
  if (!body.includes(']:')) return '';
  const lines: string[] = [];
  let size = 0;
  for (const line of body.split('\n')) {
    if (!DEFINITION_RE.test(line)) continue;
    size += line.length + 1;
    if (size > DEFINITIONS_MAX_CHARS) return '';
    lines.push(line.replace(/\r$/, ''));
  }
  return lines.join('\n');
}

/** Shifts every position under `node` by `offset` characters and `lines` lines (a chunk starts at a line start). */
function shiftPositions(node: Nodes, offset: number, lines: number): void {
  const p = node.position;
  if (p) {
    p.start = { line: p.start.line + lines, column: p.start.column, offset: (p.start.offset ?? 0) + offset };
    p.end = { line: p.end.line + lines, column: p.end.column, offset: (p.end.offset ?? 0) + offset };
  }
  if ('children' in node) for (const child of node.children as Nodes[]) shiftPositions(child, offset, lines);
}

function countLines(body: string, from: number, to: number): number {
  let n = 0;
  for (let i = body.indexOf('\n', from); i !== -1 && i < to; i = body.indexOf('\n', i + 1)) n++;
  return n;
}

function* chunkTrees(body: string): Generator<Root, void, unknown> {
  const chunks = parseChunks(body);
  const defs = chunks.length > 1 ? definitionLines(body) : '';
  let line = 0;
  let lineAt = 0;
  for (const [start, end] of chunks) {
    const text = body.slice(start, end);
    const tree = processor.parse(defs ? `${text}\n\n${defs}\n` : text) as Root;
    // The definitions appended for the chunk are not the chunk's: drop them (they start past its end).
    if (defs) tree.children = tree.children.filter((c) => (c.position?.start.offset ?? 0) < text.length);
    line += countLines(body, lineAt, start);
    lineAt = start;
    for (const child of tree.children) shiftPositions(child, start, line);
    yield tree;
  }
}

function mergeTrees(body: string, trees: Root[]): Root {
  const children = trees.flatMap((t) => t.children);
  const lastLine = countLines(body, 0, body.length) + 1;
  const lastCol = body.length - (body.lastIndexOf('\n') + 1) + 1;
  return { type: 'root', children, position: { start: { line: 1, column: 1, offset: 0 }, end: { line: lastLine, column: lastCol, offset: body.length } } };
}

/** parseMarkdownAst for what the index reads, linear in the size of the body (see above); small bodies are parsed whole. */
export function parseMarkdownAstChunked(body: string): Root {
  if (body.length <= PARSE_CHUNK_THRESHOLD) return parseMarkdownAst(body);
  return mergeTrees(body, [...chunkTrees(body)]);
}

/** A macrotask turn: lets timers, I/O and pending requests run. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A cooperative loop's checkpoint: `await tick()` yields to the event loop once `budgetMs` of synchronous work has
 * passed since the last yield (and is free otherwise) — for loops over thousands of rows or documents.
 */
export function timeSlicer(budgetMs = 25): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < budgetMs) return;
    await yieldToEventLoop();
    since = performance.now();
  };
}

/** parseMarkdownAstChunked that yields to the event loop between chunks — for the scan and the save path. */
export async function parseMarkdownAstAsync(body: string): Promise<Root> {
  if (body.length <= PARSE_CHUNK_THRESHOLD) return parseMarkdownAst(body);
  const trees: Root[] = [];
  for (const tree of chunkTrees(body)) {
    trees.push(tree);
    await yieldToEventLoop();
  }
  return mergeTrees(body, trees);
}

/** [start, end) source offsets of every code node of `tree`: fenced and indented blocks, inline code spans. */
export function codeRanges(tree: Root): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const walk = (node: Nodes): void => {
    if (node.type === 'code' || node.type === 'inlineCode') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) out.push([start, end]);
      return;
    }
    if ('children' in node) for (const child of node.children as Nodes[]) walk(child);
  };
  walk(tree);
  return out;
}

export const CODE_MASK_CHAR = '\u0001';

/** A copy of `body` of the same length with every character in `ranges` blanked (newlines kept), so offsets found in the copy splice into the original. */
export function maskRanges(body: string, ranges: ReadonlyArray<readonly [number, number]>): string {
  if (ranges.length === 0) return body;
  const chars = body.split('');
  for (const [from, to] of ranges) {
    for (let i = from; i < to && i < chars.length; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = CODE_MASK_CHAR;
  }
  return chars.join('');
}

/** Could `body` hold a code node at all? A fence or span needs a backtick or `~~~`, an indented block a line that starts with a tab or four spaces. */
function mayHoldCode(body: string): boolean {
  return body.includes('`') || body.includes('~~~') || /^(?: {4}|\t)/m.test(body);
}

/** The last bodies masked: a rename of a directory runs both rewriters once per moved page over the same source text. */
const maskCache = new Map<string, string>();
const MASK_CACHE_SIZE = 32;

/**
 * `body` with its code blanked (see maskRanges): what the link regexes of the
 * rewriters run on. The same length as `body`; the SAME string when there is no
 * code.
 */
export function maskCode(body: string): string {
  if (!mayHoldCode(body)) return body;
  const cached = maskCache.get(body);
  if (cached !== undefined) return cached;
  const masked = maskRanges(body, codeRanges(parseMarkdownAstChunked(body)));
  if (maskCache.size >= MASK_CACHE_SIZE) maskCache.delete(maskCache.keys().next().value as string);
  maskCache.set(body, masked);
  return masked;
}
