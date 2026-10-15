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
  const masked = maskRanges(body, codeRanges(parseMarkdownAst(body)));
  if (maskCache.size >= MASK_CACHE_SIZE) maskCache.delete(maskCache.keys().next().value as string);
  maskCache.set(body, masked);
  return masked;
}
