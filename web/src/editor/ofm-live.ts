/**
 * Obsidian Flavored Markdown in the live editor (Obsidian vault compatibility,
 * wave 2): `%%comments%%`, `[[wikilinks]]` and `![[embeds]]`, `#tags`,
 * `$formulas$` and `^block-ids`, shown as DECORATIONS over the unchanged text.
 *
 * This file declares no grammar. What is a comment, a wikilink, a tag or a
 * formula, and where each starts and ends, is `shared/ofm/scan.ts` — the same
 * scanner the reading view and the exports run, so the two views recognise
 * exactly the same text. The editor's part is only to say WHERE the scanner may
 * not look (code, raw HTML: and, for tags, links) from its own Lezer tree, and
 * to turn the returned tokens into styling.
 *
 * Nothing here ever hides a character: brackets, `%%`, `#` and `$` stay in the
 * text, merely dimmed or coloured, in live mode and in source mode alike. A
 * folded bracket would need the caret guards of link-guard.ts, and a formula or
 * a comment is exactly the text an author wants to see as typed.
 */
import type { Tree } from '@lezer/common';
import { matchBlockIdAtEnd } from '@shared/ofm/blockId';
import { scanOfm, type OfmToken, type Range, type WikilinkToken } from '@shared/ofm/scan';
import { splitWikilinkInner } from '@shared/ofm/wikilink';
import type { DocText, InlineSpec, Span } from './live-decorations';

/** Lezer nodes the scanner must not start a construct in (code, inline code, raw HTML). */
const EXCLUDED_NODES = new Set([
  'FencedCode',
  'CodeBlock',
  'InlineCode',
  'HTMLBlock',
  'HTMLTag',
  'CommentBlock',
  'ProcessingInstructionBlock',
]);

/** Lezer nodes where a `#x` is link text or a destination, not a tag. */
const NO_TAG_NODES = new Set(['Link', 'Image', 'URL', 'Autolink', 'LinkReference']);

/** Lezer nodes that carry the text of one paragraph (a task item has a `Task` instead of a `Paragraph`). */
const PARAGRAPH_NODES = new Set(['Paragraph', 'Task']);

interface OfmAnalysis {
  /** Every token of the document, in order, none overlapping another. */
  tokens: readonly OfmToken[];
  /** The `^id` of every paragraph that ends in a block id. */
  blockIds: readonly Span[];
  /** Ranges of the wikilink/embed tokens (sorted, disjoint). */
  wikilinks: readonly Span[];
  /** Ranges of comments and formulas (sorted, disjoint): text that must stay exactly as typed. */
  opaque: readonly Span[];
}

const NOTHING: OfmAnalysis = { tokens: [], blockIds: [], wikilinks: [], opaque: [] };

// Scrolling asks for decorations again on an unchanged document, and the scan
// is a whole-document one (a `%%` far above the viewport decides which `%%`
// opens and which closes), so the result is kept per syntax tree.
const analyses = new WeakMap<Tree, { doc: DocText; analysis: OfmAnalysis }>();

function analyse(doc: DocText, tree: Tree): OfmAnalysis {
  const cached = analyses.get(tree);
  if (cached && cached.doc === doc) return cached.analysis;
  const analysis = analyseUncached(doc, tree);
  analyses.set(tree, { doc, analysis });
  return analysis;
}

function analyseUncached(doc: DocText, tree: Tree): OfmAnalysis {
  const text = doc.sliceString(0, doc.length);
  if (!/\[\[|%%|\$|#|\^/.test(text)) return NOTHING;

  const exclude: Range[] = [];
  const noTags: Range[] = [];
  const paragraphs: Span[] = [];
  tree.iterate({
    enter: (node) => {
      const name = node.name;
      if (EXCLUDED_NODES.has(name)) {
        exclude.push([node.from, node.to]);
        return false;
      }
      if (NO_TAG_NODES.has(name)) noTags.push([node.from, node.to]);
      else if (PARAGRAPH_NODES.has(name)) paragraphs.push({ from: node.from, to: node.to });
      return true;
    },
  });

  const tokens = scanOfm(text, { exclude, noTags });
  const wikilinks: Span[] = [];
  const opaque: Span[] = [];
  for (const token of tokens) {
    if (token.kind === 'wikilink') wikilinks.push({ from: token.from, to: token.to });
    else if (token.kind === 'comment' || token.kind === 'math') opaque.push({ from: token.from, to: token.to });
  }

  const blockIds: Span[] = [];
  for (const paragraph of paragraphs) {
    const id = blockIdOf(doc, paragraph);
    if (id && !ofmClaims(tokens, id.from, id.to)) blockIds.push(id);
  }
  return { tokens, blockIds, wikilinks, opaque };
}

/** The `^id` that ends the paragraph's LAST line, as an absolute range, or null. */
function blockIdOf(doc: DocText, paragraph: Span): Span | null {
  const line = doc.lineAt(paragraph.to);
  let from = Math.max(line.from, paragraph.from);
  const to = Math.min(line.to, paragraph.to);
  if (to <= from) return null;
  let text = doc.sliceString(from, to);
  if (from > paragraph.from) {
    // A later line of a quoted or indented paragraph starts with its `>` marks / indentation, which are not paragraph text.
    const prefix = /^[ \t]*(?:>[ \t]*)*/.exec(text)?.[0].length ?? 0;
    text = text.slice(prefix);
    from += prefix;
  }
  const match = matchBlockIdAtEnd(text);
  if (!match) return null;
  const idFrom = from + match.index;
  return { from: idFrom, to: idFrom + 1 + match.id.length };
}

/**
 * True when [from, to] overlaps one of `spans` (sorted by position, disjoint)
 * without enclosing it from both sides. A range that encloses a span from both
 * sides is a bigger construct with the span inside (`[a [[b]] c](url)`); every
 * other overlap means both claim the same text.
 */
export function ofmClaims(spans: readonly Span[], from: number, to: number): boolean {
  for (let i = firstEndingAfter(spans, from); i < spans.length && spans[i].from < to; i++) {
    if (!(from < spans[i].from && to > spans[i].to)) return true;
  }
  return false;
}

/** True when [from, to] lies wholly inside one of `spans` (sorted, disjoint). */
export function ofmContains(spans: readonly Span[], from: number, to: number): boolean {
  const span = spans[firstEndingAfter(spans, from)];
  return span !== undefined && span.from <= from && to <= span.to;
}

/** Index of the first span that ends after `pos` (spans.length when none). */
function firstEndingAfter(spans: readonly Span[], pos: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].to <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** What the generic Markdown rules (link folding, emphasis folding ...) must leave alone. */
export interface OfmOwned {
  /** Wikilink and embed tokens of the document: Lezer reads `[[Note]]` as a shortcut-reference link, which the generic link rule must not fold. */
  wikilinks: readonly Span[];
  /** Comments and formulas of the document: nothing may be folded away inside them, whatever the Markdown tree makes of their `*` and `_`. */
  opaque: readonly Span[];
}

/** The same ranges `computeOfmSpecs` returns, for code that has no visible ranges at hand (the caret guards in link-guard.ts). */
export function ofmOwned(doc: DocText, tree: Tree): OfmOwned {
  const { wikilinks, opaque } = analyse(doc, tree);
  return { wikilinks, opaque };
}

/**
 * True when the Markdown node [from, to] belongs to an OFM token and must not
 * be decorated or folded as Markdown: it IS (part of) a wikilink — a node that
 * merely encloses one, `[a [[b]] c](url)`, does not count — or it sits wholly
 * inside a comment or a formula.
 */
export function ofmOwns(owned: OfmOwned, from: number, to: number): boolean {
  return ofmClaims(owned.wikilinks, from, to) || ofmContains(owned.opaque, from, to);
}

export interface OfmLive extends OfmOwned {
  specs: InlineSpec[];
}

export interface OfmLiveOptions {
  doc: DocText;
  tree: Tree;
  /** The ranges to decorate (the visible ones); the scan itself always covers the whole document. */
  ranges: readonly Span[];
  /** Live and source mode decorate OFM identically — kept in the signature so callers pass one options object. */
  live?: boolean;
}

export function computeOfmSpecs({ doc, tree, ranges }: OfmLiveOptions): OfmLive {
  const { tokens, blockIds, wikilinks, opaque } = analyse(doc, tree);
  const specs: InlineSpec[] = [];
  if (tokens.length === 0 && blockIds.length === 0) return { specs, wikilinks, opaque };

  const visible = (from: number, to: number) => ranges.some((range) => from <= range.to && to >= range.from);
  const mark = (from: number, to: number, cls: string) => {
    if (to > from) specs.push({ kind: 'mark', from, to, cls });
  };

  for (const token of tokens) {
    if (!visible(token.from, token.to)) continue;
    switch (token.kind) {
      case 'comment':
        mark(token.from, token.to, 'cm-md-comment');
        break;
      case 'tag':
        mark(token.from, token.to, 'cm-md-tag');
        break;
      case 'math':
        mark(token.from, token.to, token.display ? 'cm-md-math cm-md-math-display' : 'cm-md-math');
        break;
      case 'wikilink':
        wikilinkSpecs(token, doc.sliceString(token.from, token.to), mark);
        break;
    }
  }
  for (const id of blockIds) if (visible(id.from, id.to)) mark(id.from, id.to, 'cm-md-blockid');
  return { specs, wikilinks, opaque };
}

/**
 * `[[Note]]`, `[[Note|alias]]`, `![[img.png|300]]`: the brackets, `!` and the
 * part the reading view does not show are dimmed like any markdown marker; what
 * the reading view DOES show is coloured as a link. A link shows its alias when
 * it has one, otherwise the whole target; an embed shows what it embeds (the
 * target), and the `|300` size or alt text after it is syntax.
 */
function wikilinkSpecs(
  token: WikilinkToken,
  source: string,
  mark: (from: number, to: number, cls: string) => void,
): void {
  const open = token.embed ? 3 : 2;
  const innerFrom = token.from + open;
  const inner = source.slice(open, source.length - 2);
  mark(token.from, innerFrom, 'cm-md-marker');
  mark(token.to - 2, token.to, 'cm-md-marker');

  // `aliasPart` is `|alias` or, in a table cell, `\|alias`; it is empty without a bar.
  const { aliasPart } = splitWikilinkInner(inner);
  const targetEnd = inner.length - aliasPart.length;
  const bar = aliasPart.startsWith('\\|') ? 2 : aliasPart.startsWith('|') ? 1 : 0;

  let labelFrom: number;
  let labelTo: number;
  if (token.embed) {
    [labelFrom, labelTo] = trimmed(inner, 0, targetEnd);
    mark(innerFrom + targetEnd, token.to - 2, 'cm-md-marker');
  } else if (token.alias !== null && bar > 0) {
    [labelFrom, labelTo] = trimmed(inner, targetEnd + bar, inner.length);
    mark(innerFrom, innerFrom + targetEnd + bar, 'cm-md-marker');
  } else {
    [labelFrom, labelTo] = trimmed(inner, 0, inner.length);
  }
  mark(innerFrom + labelFrom, innerFrom + labelTo, token.embed ? 'cm-md-wikilink cm-md-embed' : 'cm-md-wikilink');
}

/** [from, to) of `text` narrowed past the blanks at both ends. */
function trimmed(text: string, from: number, to: number): [number, number] {
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  return [from, to];
}
