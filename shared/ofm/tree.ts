/**
 * Editing an mdast by SOURCE RANGES — the engine that turns OFM tokens (found
 * in the page source, scan.ts) into nodes of a tree remark-parse has already
 * built (Obsidian vault compatibility, wave 2).
 *
 * Why not a micromark extension, or a pass over `text` nodes: a formula such as
 * `$a*b*c$` is split by the parser into text, emphasis and text; `\{` inside it
 * has lost its backslash by the time it is a `text` value; a comment may run
 * through several paragraphs. A token is a range of the SOURCE, so it is
 * replaced as one: `placeRange` finds the children of the lowest node that
 * covers the range, drops the ones the range swallows, trims the text at its
 * two ends (alignText maps source offsets to text-value offsets, skipping the
 * `> ` of a quote, the indentation of a list continuation, escapes and
 * character references) and puts the new nodes in. A range that cuts through
 * the inside of a non-text node (it begins in an emphasis and ends outside it)
 * is refused and the source stays visible as text — degrade, never break.
 *
 * Plain TS over mdast types; no unist helpers (the server ships without dev
 * dependencies).
 */
import type { Nodes, Parent, Root, Text } from 'mdast';
import { decodeString } from 'micromark-util-decode-string';

type AnyNode = Nodes & { position?: { start: Point; end: Point } };
interface Point {
  line: number;
  column: number;
  offset?: number;
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const ENTITY_RE = /^&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/;

/** Value index -> source offset of the character, for a text node. `map[value.length]` is the offset right after the last character. */
export function alignText(source: string, value: string, start: number, end: number): Int32Array | null {
  const map = new Int32Array(value.length + 1);
  let s = start;
  let v = 0;
  while (v < value.length) {
    if (s >= end) return null;
    const sc = source[s];
    const vc = value[v];
    // A character reference first: `&amp;` in the source is `&` in the value, and the `&` alone would also "match".
    if (sc === '&') {
      const entity = ENTITY_RE.exec(source.slice(s, s + 40));
      if (entity) {
        const decoded = decodeString(entity[0]);
        if (decoded !== entity[0] && value.startsWith(decoded, v)) {
          for (let k = 0; k < decoded.length; k++) map[v + k] = s;
          v += decoded.length;
          s += entity[0].length;
          continue;
        }
      }
    }
    // A backslash before ASCII punctuation is always an escape: two backslashes in the source are ONE in the value.
    if (sc === '\\' && s + 1 < end && ASCII_PUNCT.test(source[s + 1])) {
      if (source[s + 1] !== vc) return null;
      map[v++] = s + 1;
      s += 2;
      continue;
    }
    if (sc === vc) {
      map[v++] = s++;
      continue;
    }
    // What the parser dropped between two characters of the value: a quote's `>`, the indentation of a continuation line, blanks before a line break.
    if (sc === ' ' || sc === '\t' || sc === '>' || sc === '\r') {
      s++;
      continue;
    }
    return null;
  }
  map[value.length] = s;
  return map;
}

/** First value index whose source offset is >= `offset` (value.length when none). */
function indexAtOffset(map: Int32Array, offset: number): number {
  let lo = 0;
  let hi = map.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid] >= offset) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Line/column of source offsets, from a table of line starts. */
export class SourceLines {
  private readonly starts: number[] = [0];
  constructor(source: string) {
    for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) this.starts.push(i + 1);
  }
  point(offset: number): Point {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - this.starts[lo] + 1, offset };
  }
}

function startOf(node: AnyNode): number | undefined {
  return node.position?.start.offset;
}
function endOf(node: AnyNode): number | undefined {
  return node.position?.end.offset;
}

function textPiece(value: string, from: number, to: number, lines: SourceLines): Text {
  return { type: 'text', value, position: { start: lines.point(from), end: lines.point(to) } };
}

/** A node that has been given the source range it stands for, so later ranges can still be placed around it. */
export function withRange<T extends Nodes>(node: T, from: number, to: number, lines: SourceLines): T {
  (node as AnyNode).position = { start: lines.point(from), end: lines.point(to) };
  return node;
}

export interface PlaceOptions {
  /** Comments may cut through containers: the parts of a paragraph a comment covers are removed, the rest stays. */
  clip?: boolean;
}

interface Context {
  source: string;
  lines: SourceLines;
  from: number;
  to: number;
  nodes: Nodes[];
  clip: boolean;
}

function hasChildren(node: Nodes): node is Nodes & Parent {
  return 'children' in node && Array.isArray((node as Parent).children);
}

/** Splits one text child around [from, to): the pieces that stay, and where they end up relative to the inserted nodes. */
function trimText(node: Text, ctx: Context): { before: Text | null; after: Text | null } | null {
  const start = startOf(node);
  const end = endOf(node);
  if (start === undefined || end === undefined) return null;
  const map = alignText(ctx.source, node.value, start, end);
  if (!map) return null;
  const a = ctx.from <= start ? 0 : indexAtOffset(map, ctx.from);
  const b = ctx.to >= end ? node.value.length : indexAtOffset(map, ctx.to);
  const before = a > 0 ? textPiece(node.value.slice(0, a), start, map[a], ctx.lines) : null;
  const after = b < node.value.length ? textPiece(node.value.slice(b), map[b], end, ctx.lines) : null;
  return { before, after };
}

function place(parent: Nodes & Parent, ctx: Context): boolean {
  const kids = parent.children as AnyNode[];
  let first = -1;
  let last = -1;
  for (let i = 0; i < kids.length; i++) {
    const s = startOf(kids[i]);
    const e = endOf(kids[i]);
    if (s === undefined || e === undefined) continue;
    if (e <= ctx.from) continue;
    if (s >= ctx.to) break;
    if (first === -1) first = i;
    last = i;
  }
  if (first === -1) return false;

  if (first === last) {
    const child = kids[first];
    const s = startOf(child)!;
    const e = endOf(child)!;
    if (child.type === 'text') {
      const trimmed = trimText(child, ctx);
      if (!trimmed) return false;
      const replacement: Nodes[] = [];
      if (trimmed.before) replacement.push(trimmed.before);
      replacement.push(...ctx.nodes);
      if (trimmed.after) replacement.push(trimmed.after);
      kids.splice(first, 1, ...(replacement as AnyNode[]));
      return true;
    }
    if (s <= ctx.from && ctx.to <= e && hasChildren(child)) {
      if (place(child, ctx)) {
        if (ctx.clip && hasChildren(child) && child.children.length === 0) kids.splice(first, 1);
        return true;
      }
      return false;
    }
    if (ctx.from <= s && e <= ctx.to) {
      kids.splice(first, 1, ...(ctx.nodes as AnyNode[]));
      return true;
    }
    return false;
  }

  // Several children are touched: the ones inside the range go; the two at the ends may be cut.
  const touched = kids.slice(first, last + 1);
  for (let i = 0; i < touched.length; i++) {
    const child = touched[i];
    const s = startOf(child)!;
    const e = endOf(child)!;
    const inside = ctx.from <= s && e <= ctx.to;
    if (inside) continue;
    const isEnd = i === 0 || i === touched.length - 1;
    if (!isEnd) return false;
    if (child.type === 'text') continue;
    if (ctx.clip && hasChildren(child)) continue;
    return false;
  }

  const head: AnyNode[] = [];
  const tail: AnyNode[] = [];
  for (let i = 0; i < touched.length; i++) {
    const child = touched[i];
    const s = startOf(child)!;
    const e = endOf(child)!;
    if (ctx.from <= s && e <= ctx.to) continue;
    const side = i === 0 ? head : tail;
    if (child.type === 'text') {
      const trimmed = trimText(child, ctx);
      if (!trimmed) return false;
      const keep = i === 0 ? trimmed.before : trimmed.after;
      if (keep) side.push(keep);
    } else if (hasChildren(child)) {
      place(child, { ...ctx, nodes: [] });
      if (child.children.length > 0) side.push(child);
    }
  }
  kids.splice(first, last - first + 1, ...head, ...(ctx.nodes as AnyNode[]), ...tail);
  return true;
}

/**
 * Replaces the source range [from, to) of `root` by `nodes` (none: removes it).
 * Returns false, leaving the tree as it was, when the range does not fit the
 * tree's shape.
 */
export function placeRange(root: Root, source: string, lines: SourceLines, from: number, to: number, nodes: Nodes[], options: PlaceOptions = {}): boolean {
  return place(root, { source, lines, from, to, nodes, clip: options.clip === true });
}

/** [start, end) of every node of `types` in the tree — the zones a scan must leave alone. */
export function rangesOf(root: Nodes, types: ReadonlySet<string>, out: Array<[number, number]> = []): Array<[number, number]> {
  const walk = (node: Nodes): void => {
    if (types.has(node.type)) {
      const s = startOf(node as AnyNode);
      const e = endOf(node as AnyNode);
      if (s !== undefined && e !== undefined) out.push([s, e]);
      return;
    }
    if (hasChildren(node)) for (const child of node.children as Nodes[]) walk(child);
  };
  walk(root);
  return out;
}
