/**
 * Embedded notes (wave 2, Obsidian vault compatibility): what `![[Note]]`,
 * `![[Note#Heading]]` and `![[Note#^block]]` show in the reading view.
 * `buildEmbed` returns the markdown of the whole page, of one heading section
 * or of one block, cut out of the page body BYTE FOR BYTE (the client renders it
 * through the same pipeline as the page that embeds it). Authorization is the
 * route's job (server/routes.ts, publicSiteRoutes.ts); this only reads content.
 *
 * Fragments are resolved exactly the way the page index resolves them
 * (server/indexV2/parse.ts): headings by the outline's duplicate-aware slug
 * (`shared/headingSlug`, so `#my-heading`, `#My Heading` and `#my-heading-2`
 * all work), blocks by the lowercased `^id`.
 *
 *  - heading: the heading line and everything under it up to (not including)
 *    the next heading of the same or a smaller depth, or the end of the page;
 *  - block: the paragraph that ends with the id — except that a paragraph that
 *    opens a list item gives the WHOLE list item (children included), and an id
 *    standing alone below a structural block gives that block (table, quote,
 *    list, code ...). The ` ^id` token itself is left out of the text.
 */
import type { Blockquote, Heading, ListItem, Nodes, Paragraph, Root, Text } from 'mdast';
import { EMBED_MAX_DEPTH, type EmbedPayload } from '../shared/contracts.js';
import { createSlugDeduper, headingAnchorSource } from '../shared/headingSlug.js';
import { matchBlockIdAtEnd } from '../shared/ofm/blockId.js';
import { matchCalloutMarker } from '../shared/ofm/callout.js';
import { fragmentInfo } from '../shared/ofm/wikilink.js';
import { badRequest, notFound } from './errors.js';
import { parseMarkdownAst } from './markdownAst.js';
import { buildPageDoc } from './pageDoc.js';
import type { PageIndexEntry } from './storage.js';

/** `?depth=` -> 1..EMBED_MAX_DEPTH (absent = 1); anything else is a 400. */
export function parseEmbedDepth(raw: string | undefined | null): number {
  const text = (raw ?? '').trim();
  if (!text) return 1;
  if (!/^\d+$/.test(text)) throw badRequest(`depth must be an integer from 1 to ${EMBED_MAX_DEPTH}`);
  const depth = Number(text);
  if (depth < 1) throw badRequest(`depth must be an integer from 1 to ${EMBED_MAX_DEPTH}`);
  if (depth > EMBED_MAX_DEPTH) throw badRequest('embed depth limit exceeded');
  return depth;
}

// ---------------------------------------------------------------------------
// Source slicing
// ---------------------------------------------------------------------------

interface Located {
  start: number;
  end: number;
  column: number;
}

function locate(node: Nodes): Located | null {
  const start = node.position?.start;
  const end = node.position?.end;
  if (!start || !end || start.offset === undefined || end.offset === undefined) return null;
  return { start: start.offset, end: end.offset, column: start.column };
}

function lineStartOf(body: string, offset: number): number {
  return offset <= 0 ? 0 : body.lastIndexOf('\n', offset - 1) + 1;
}

/**
 * `text` without the range [from, to): the blanks before `from` go too, and when
 * the range was a line of its own the line break before it goes as well (no
 * blank line is left behind inside a list item).
 */
function cutRange(text: string, from: number, to: number): string {
  let start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(start, Math.min(to, text.length));
  while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
  let stop = end;
  while (stop < text.length && (text[stop] === ' ' || text[stop] === '\t')) stop++;
  const lineBreakAfter = stop >= text.length || text[stop] === '\n' || text[stop] === '\r';
  if (start > 0 && text[start - 1] === '\n' && lineBreakAfter) {
    start--;
    if (start > 0 && text[start - 1] === '\r') start--;
  }
  return text.slice(0, start) + text.slice(stop);
}

/**
 * Takes the continuation lines of a block that sat inside a quote or an indented
 * list back to the left edge: `quoteDepth` quote markers off, or up to
 * `indent` blanks (the column the block started at). A one-line block is
 * returned as it is.
 */
function dedentContinuation(text: string, indent: number, quoteDepth: number): string {
  if (!text.includes('\n')) return text;
  const quoteRe = quoteDepth > 0 ? new RegExp(`^(?:[ \\t]*>[ \\t]?){1,${quoteDepth}}`) : null;
  return text
    .split('\n')
    .map((line, i) => {
      if (i === 0) return line;
      if (quoteRe) return line.replace(quoteRe, '');
      let k = 0;
      while (k < indent && (line[k] === ' ' || line[k] === '\t')) k++;
      return line.slice(k);
    })
    .join('\n');
}

/** The source of `node`, with `removal` (an absolute [from, to) range of the body) cut out. */
function sourceOf(body: string, node: Nodes, ancestors: readonly Nodes[], removal?: readonly [number, number]): string {
  const at = locate(node);
  if (!at) return '';
  let text = body.slice(at.start, at.end);
  if (removal) text = cutRange(text, removal[0] - at.start, removal[1] - at.start);
  const quoteDepth = ancestors.filter((a) => a.type === 'blockquote').length;
  return dedentContinuation(text, at.column - 1, quoteDepth).trimEnd();
}

// ---------------------------------------------------------------------------
// Heading sections
// ---------------------------------------------------------------------------

interface HeadingSpot {
  depth: number;
  slug: string;
  /** Offset of the start of the line the heading is on. */
  lineStart: number;
}

/** Every heading in document order with the slug the index gives it (same walk as indexV2/parse.ts: one deduper, quotes and lists included). */
function collectHeadings(tree: Root, body: string): HeadingSpot[] {
  const dedupe = createSlugDeduper();
  const out: HeadingSpot[] = [];
  const walk = (node: Nodes): void => {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'definition') return;
    if (node.type === 'heading') {
      const heading = node as Heading;
      const slug = dedupe(headingAnchorSource(heading));
      const at = locate(heading);
      if (at) out.push({ depth: heading.depth, slug, lineStart: lineStartOf(body, at.start) });
      return;
    }
    if ('children' in node) for (const child of node.children as Nodes[]) walk(child);
  };
  walk(tree);
  return out;
}

function headingSection(tree: Root, body: string, slug: string): string | null {
  const headings = collectHeadings(tree, body);
  const index = headings.findIndex((h) => h.slug === slug);
  if (index === -1) return null;
  const { depth, lineStart } = headings[index];
  const next = headings.slice(index + 1).find((h) => h.depth <= depth);
  return body.slice(lineStart, next ? next.lineStart : body.length).trimEnd();
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

interface BlockHit {
  paragraph: Paragraph;
  /** From the root down to the paragraph's parent. */
  ancestors: Nodes[];
  /** Absolute [from, to) range of the `^id` token (the blanks around it are the cutter's job). */
  token: [number, number];
  /** The paragraph is nothing but the id. */
  alone: boolean;
}

/** The block id a paragraph ends with, found the way the index finds it (the last child is text, `matchBlockIdAtEnd` on its source). */
function blockIdOf(paragraph: Paragraph, body: string): { id: string; token: [number, number] } | null {
  const last = paragraph.children[paragraph.children.length - 1];
  if (!last || last.type !== 'text') return null;
  const at = locate(last as Text);
  if (!at) return null;
  const match = matchBlockIdAtEnd(body.slice(at.start, at.end));
  if (!match) return null;
  const from = at.start + match.index;
  return { id: match.id, token: [from, from + 1 + match.id.length] };
}

function findBlock(tree: Root, body: string, key: string): BlockHit | null {
  const found: { hit: BlockHit | null } = { hit: null };
  const walk = (node: Nodes, ancestors: Nodes[]): void => {
    if (found.hit) return;
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'definition') return;
    if (node.type === 'paragraph') {
      const carried = blockIdOf(node, body);
      if (carried && carried.id.toLowerCase() === key) {
        const at = locate(node);
        const alone = at !== null && body.slice(at.start, at.end).trim() === `^${carried.id}`;
        found.hit = { paragraph: node, ancestors, token: carried.token, alone };
      }
      return;
    }
    if ('children' in node) {
      const path = [...ancestors, node];
      for (const child of node.children as Nodes[]) walk(child, path);
    }
  };
  walk(tree, []);
  return found.hit;
}

/** A quote whose first paragraph opens with `[!type]`. */
function isCallout(quote: Blockquote): boolean {
  const first = quote.children[0];
  const lead = first && first.type === 'paragraph' ? first.children[0] : undefined;
  return lead !== undefined && lead.type === 'text' && matchCalloutMarker(lead.value) !== null;
}

function blockSection(tree: Root, body: string, key: string): string | null {
  const hit = findBlock(tree, body, key);
  if (!hit) return null;
  const parent = hit.ancestors[hit.ancestors.length - 1];
  const siblings = parent && 'children' in parent ? (parent.children as Nodes[]) : [];
  const position = siblings.indexOf(hit.paragraph);
  if (hit.alone) {
    // `^id` on a line of its own names the block right above it (a table, a quote, a list ...).
    const above = position > 0 ? siblings[position - 1] : undefined;
    return above ? sourceOf(body, above, hit.ancestors) : null;
  }
  // The id sits inside a callout (`> [!hint] text ^id`): Obsidian embeds the whole callout, marker and all - the
  // paragraph alone would show a raw `[!hint]`.
  for (let i = hit.ancestors.length - 1; i >= 0; i--) {
    const ancestor = hit.ancestors[i];
    if (ancestor.type === 'blockquote' && isCallout(ancestor)) return sourceOf(body, ancestor, hit.ancestors.slice(0, i), hit.token);
  }
  if (parent && parent.type === 'listItem' && position === 0) {
    // The id ends the text of a list item: the item with everything nested in it.
    return sourceOf(body, parent as ListItem, hit.ancestors.slice(0, -1), hit.token);
  }
  return sourceOf(body, hit.paragraph, hit.ancestors, hit.token);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The part of `body` a fragment names (`^id`, a heading slug, or the heading as
 * written), or the whole body for no fragment. Throws 404 `fragment not found`.
 */
export function sliceEmbedFragment(body: string, fragmentRaw: string | null): string {
  if (fragmentRaw === null || fragmentRaw.trim() === '') return body;
  const info = fragmentInfo(fragmentRaw);
  if (!info) throw notFound('fragment');
  const tree = parseMarkdownAst(body);
  const section = info.kind === 'block' ? blockSection(tree, body, info.key) : headingSection(tree, body, info.key);
  if (section === null) throw notFound('fragment');
  return section;
}

/** The payload of GET /api/pages/:id/embed (and its public twin) for a page the caller may read. Only documents embed. */
export async function buildEmbed(entry: PageIndexEntry, fragment: string | null): Promise<EmbedPayload> {
  if (entry.kind !== 'doc') throw badRequest('only documents can be embedded');
  const body = (await buildPageDoc(entry)).markdown ?? '';
  return {
    id: entry.id,
    space: entry.space,
    path: entry.relPath,
    title: entry.title,
    markdown: sliceEmbedFragment(body, fragment),
  };
}
