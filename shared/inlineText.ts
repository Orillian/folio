/**
 * Plain text of inline markdown — what a heading SAYS once its markup is gone.
 *
 * The outline panel, the page title and anything else that shows a heading as
 * a label needs the words, not the syntax: `## ==SELECTED=={.green} Growth`
 * is "SELECTED Growth", `:status[Ongoing]{color=green}` is "Ongoing", a link
 * is its text. The owner, 13.10.2026: the outline listed
 * `==SELECTED=={.green} Grow…`.
 *
 * It reads the mdast the rest of the app already parses (remark-parse + GFM +
 * `++underline++`), so emphasis, strike, underline, links, code, escapes and
 * character references are resolved by the parser and not by regular
 * expressions. Two forms are not remark syntax and are resolved here with the
 * same shared pieces the renderers use:
 *  - `==text==` / `==text=={.token}` and the legacy `<mark>…</mark>` pair,
 *    through `splitHighlightMarkers` / `groupLegacyMarkupSpans` (the DOCX
 *    export does exactly this), so flanking and nesting match the reading view;
 *  - `:status[Label]{color=…}`, through `DECODED_STATUS_RE`, on the flattened
 *    text — so a label with markup of its own (`:status[**Go**]`) works too.
 *
 * Plain TS, no DOM: importable from `web` and `server` alike.
 */
import type { Heading, PhrasingContent, Root, Text } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import {
  groupLegacyMarkupSpans,
  isHighlightGroup,
  splitHighlightMarkers,
  type HighlightItem,
  type HighlightTextAdapter,
} from './highlight.js';
import { DECODED_STATUS_RE, cleanStatusLabel } from './status.js';
import { remarkUnderline } from './underline.js';

export interface PlainTextOptions {
  /** What a hard line break becomes. A space by default; a callout preview wants a real newline. */
  breakText?: string;
  /** Collapse runs of whitespace (newlines included) into one space and trim. On by default. */
  collapse?: boolean;
}

const textAdapter: HighlightTextAdapter<PhrasingContent> = {
  getText: (node) => (node.type === 'text' ? node.value : undefined),
  makeText: (value) => ({ type: 'text', value }) as Text,
};

/** Inline HTML that only styles its content: the tag goes, the words stay. Any other tag is kept as typed (`List<T>`). */
const STYLE_TAG = /^<\/?(?:ins|u|mark|b|i|em|strong|s|del|strike|span|sub|sup|small|kbd|abbr|a)(?:\s[^>]*)?>$/i;
const BREAK_TAG = /^<br\s*\/?>$/i;
const MARK_OPEN = /^<mark(?:\s[^>]*)?>$/i;
const MARK_CLOSE = /^<\/mark\s*>$/i;

function markTag(node: PhrasingContent): 'open' | 'close' | undefined {
  if (node.type !== 'html') return undefined;
  const value = node.value.trim();
  if (MARK_OPEN.test(value)) return 'open';
  if (MARK_CLOSE.test(value)) return 'close';
  return undefined;
}

function textOfItems(items: readonly HighlightItem<PhrasingContent>[], breakText: string): string {
  return items
    .map((item) => (isHighlightGroup(item) ? textOfItems(item.children, breakText) : textOfNode(item, breakText)))
    .join('');
}

function textOfNodes(nodes: readonly PhrasingContent[], breakText: string): string {
  return textOfItems(splitHighlightMarkers(groupLegacyMarkupSpans(nodes, markTag), textAdapter), breakText);
}

function textOfNode(node: PhrasingContent, breakText: string): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return node.value;
    case 'break':
      return breakText;
    case 'image':
      return node.alt ?? '';
    case 'html': {
      const value = node.value.trim();
      if (BREAK_TAG.test(value)) return breakText;
      return STYLE_TAG.test(value) ? '' : node.value;
    }
    case 'footnoteReference':
      return '';
    default:
      return 'children' in node ? textOfNodes(node.children as PhrasingContent[], breakText) : '';
  }
}

/** Plain text of a run of sibling inline nodes (a heading's, a paragraph's, a list item's children). */
export function phrasingToPlainText(nodes: readonly PhrasingContent[], options: PlainTextOptions = {}): string {
  const { breakText = ' ', collapse = true } = options;
  let text = textOfNodes(nodes, breakText).replace(DECODED_STATUS_RE, (whole, label: string) => cleanStatusLabel(label) || whole);
  if (collapse) text = text.replace(/\s+/g, ' ').trim();
  return text;
}

let parser: ReturnType<typeof makeParser> | undefined;
function makeParser() {
  return unified().use(remarkParse).use(remarkGfm).use(remarkUnderline);
}

/** Characters that can start any inline markup; a line without one is already plain. */
const MAY_HAVE_MARKUP = /[\\*_~=+`[\]<>&:!]/;

/**
 * Plain text of one line of inline markdown — the text of an ATX heading, as
 * the server holds it. Parsed as the heading it is (`# ` + text), so a title
 * like `1. Intro` is a heading and not a list. Text with no markup characters
 * is returned as it is, trimmed, so the common case is a no-op.
 */
export function inlineMarkdownToPlainText(markdown: string): string {
  const line = markdown.trim();
  if (!MAY_HAVE_MARKUP.test(line) || line.includes('\n')) return line;
  const tree = (parser ??= makeParser().freeze()).parse(`# ${line}`) as Root;
  const heading = tree.children.length === 1 ? tree.children[0] : undefined;
  if (!heading || heading.type !== 'heading') return line;
  return phrasingToPlainText((heading as Heading).children) || line;
}
