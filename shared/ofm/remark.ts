/**
 * `remarkOfm` — Obsidian-flavoured markdown on the mdast (Obsidian vault
 * compatibility, wave 2). The ONE unified plugin behind READING and EXPORT:
 * the web pipeline (web/src/markdown/pipeline.ts) runs it in `reading` mode
 * and gets nodes that carry render hints (`data.hName` / `hProperties`, the way
 * `++underline++` does); the PDF and DOCX exports
 * (server/export/print.ts, docx.ts) run it in `export` mode and get plain
 * mdast — text, quotes, code — so every construct has a printable fallback and
 * the export code needs no knowledge of Obsidian.
 *
 * What it does, in this order, on the tree remark-parse built (the page source
 * is `file.value`; files are never changed):
 *  1. finds the inline constructs in the source (scan.ts) outside code, raw
 *     HTML and — for tags — links, and replaces each source range in the tree
 *     (tree.ts): `%%comment%%` is removed; `[[wikilink]]` becomes a link node
 *     (`.folio-wikilink`) whose target the web resolves through the page
 *     metadata; `![[img.png|300]]` an image with a width, `![[file.pdf]]` a link,
 *     `![[Note]]` an embed placeholder (a block when it stands alone);
 *     `#tag` a chip; `$tex$` / `$$tex$$` a formula node (KaTeX in the browser,
 *     the TeX itself in exports);
 *  2. turns block quotes that open with `[!type]` into callouts (callout.ts):
 *     any type and case, fold sign, title, nested; GitHub's five alerts are
 *     the same thing;
 *  3. finds `^block-id` at the end of a paragraph: hidden, and the block gets
 *     the anchor `^block-id`.
 * It must run right after remark-parse/GFM and before anything that splits
 * text (remark-breaks), because it relies on the parser's node positions.
 */
import type { Blockquote, Nodes, Paragraph, PhrasingContent, Root, RootContent, Text } from 'mdast';
import { matchBlockIdAtEnd } from './blockId.js';
import { calloutKind, capitalizeType, matchCalloutMarker } from './callout.js';
import { scanOfm, type OfmToken, type WikilinkToken } from './scan.js';
import { SourceLines, placeRange, rangesOf, withRange } from './tree.js';
import { baseNameOf, embedTargetKind, noteNameOf, parseImageEmbedAlias, wikilinkDefaultLabel } from './wikilink.js';

export interface RemarkOfmOptions {
  /** `reading`: nodes with render hints for the web. `export`: plain mdast with text fallbacks. */
  mode: 'reading' | 'export';
  /** The visible name of a callout of this type (the web passes its translations); default: the type, capitalized. */
  calloutLabel?: (type: string) => string;
}

type N = Nodes;
type AnyRecord = Record<string, unknown>;

const CODE_TYPES = new Set(['code', 'inlineCode', 'html', 'yaml', 'definition']);
const LINK_TYPES = new Set(['link', 'linkReference', 'image', 'imageReference']);

// ---------------------------------------------------------------------------
// node builders
// ---------------------------------------------------------------------------

const text = (value: string): Text => ({ type: 'text', value });

/** A node mdast-util-to-hast draws as `<hName ...hProperties>` around `children`. */
function hinted(type: string, hName: string, hProperties: AnyRecord, children: PhrasingContent[], extra: AnyRecord = {}): N {
  return { type, children, data: { hName, hProperties }, ...extra } as unknown as N;
}

const EXTERNAL_RE = /^[a-z][a-z0-9+.-]*:/i;

const CODE_ALIAS_RE = /^(`+)([^`](?:[\s\S]*[^`])?)\1$/;

/** The label of a wikilink: an alias that is one code span (`[[Note|`code`]]`) is drawn as code, like the page text around it. */
function labelNodes(label: string, isAlias: boolean): PhrasingContent[] {
  const code = isAlias ? CODE_ALIAS_RE.exec(label) : null;
  return code ? [{ type: 'inlineCode', value: code[2].trim() }] : [text(label)];
}

/** `[[Note]]`, `[[Note|alias]]`, `![[Note]]` ... in reading mode. */
function readingWikilink(token: WikilinkToken): N {
  const label = token.alias ?? wikilinkDefaultLabel(token.path, token.fragment);
  if (token.path && EXTERNAL_RE.test(token.path)) {
    return { type: 'link', url: token.path, children: [text(token.alias ?? token.path)] } as N;
  }
  if (token.embed) {
    const kind = embedTargetKind(token.path);
    if (kind === 'image') {
      const size = parseImageEmbedAlias(token.alias);
      const props: AnyRecord = {};
      if (size.width !== undefined) props.width = size.width;
      if (size.height !== undefined) props.height = size.height;
      return { type: 'image', url: token.path, alt: size.alt || baseNameOf(token.path), ...(Object.keys(props).length ? { data: { hProperties: props } } : {}) } as N;
    }
    if (kind === 'file') {
      return { type: 'link', url: token.path, children: [text(token.alias ?? baseNameOf(token.path))] } as N;
    }
  }
  const props: AnyRecord = { href: '#', className: ['folio-wikilink'], dataWikilink: token.path };
  if (token.fragment !== null) props.dataWikilinkFragment = token.fragment;
  if (token.embed) props.dataWikilinkEmbed = 'true';
  return hinted('ofmWikilink', 'a', props, labelNodes(label, token.alias !== null), { embed: token.embed });
}

/** The words an export prints for a wikilink or an embed. */
function exportWikilink(token: WikilinkToken): N {
  const label = token.alias ?? wikilinkDefaultLabel(token.path, token.fragment);
  if (token.path && EXTERNAL_RE.test(token.path)) return { type: 'link', url: token.path, children: [text(token.alias ?? token.path)] } as N;
  if (!token.embed) return text(token.alias !== null ? label.replace(CODE_ALIAS_RE, '$2') : label);
  const kind = embedTargetKind(token.path);
  if (kind === 'image') return text(`[image: ${baseNameOf(token.path)}]`);
  if (kind === 'file') return text(`[file: ${baseNameOf(token.path)}]`);
  return text(`[embedded: ${wikilinkDefaultLabel(token.path ? noteNameOf(token.path) : '', token.fragment)}]`);
}

function readingNodeFor(token: OfmToken, source: string): N | null {
  switch (token.kind) {
    case 'comment':
      return null;
    case 'wikilink':
      return readingWikilink(token);
    case 'tag':
      return hinted('ofmTag', 'a', { href: '#', className: ['folio-tag'], dataFolioTag: token.tag }, [text(source.slice(token.from, token.to))]);
    case 'math':
      return hinted(
        'ofmMath',
        'span',
        { className: token.display ? ['folio-math', 'folio-math-display'] : ['folio-math'], dataMath: token.tex },
        [text(token.display ? `$$${token.tex}$$` : `$${token.tex}$`)],
        { display: token.display },
      );
  }
}

function exportNodeFor(token: OfmToken, source: string): N | null | undefined {
  switch (token.kind) {
    case 'comment':
      return null;
    case 'wikilink':
      return exportWikilink(token);
    case 'tag':
      return undefined; // `#tag` stays as the text it is
    case 'math':
      return { type: 'inlineCode', value: source.slice(token.from, token.to) } as N;
  }
}

// ---------------------------------------------------------------------------
// tree walking (no unist helpers on the server)
// ---------------------------------------------------------------------------

type Visitor = (node: N, parent: (N & { children: N[] }) | null, index: number) => void;

function walk(node: N, visit: Visitor, parent: (N & { children: N[] }) | null = null, index = 0): void {
  visit(node, parent, index);
  const kids = (node as { children?: N[] }).children;
  if (!kids) return;
  // Visitors may remove or insert siblings: re-read the live array by index.
  for (let i = 0; i < kids.length; i++) {
    const before = kids.length;
    walk(kids[i], visit, node as N & { children: N[] }, i);
    if (kids.length < before) i -= before - kids.length;
  }
}

function dataOf(node: N): AnyRecord {
  return ((node as { data?: AnyRecord }).data ??= {});
}

// ---------------------------------------------------------------------------
// block constructs
// ---------------------------------------------------------------------------

/** Moves the title of a callout (the rest of its first line, possibly with inline markup) out of the first paragraph. */
function takeTitle(paragraph: Paragraph, afterMarker: string): PhrasingContent[] {
  const kids = paragraph.children;
  const title: PhrasingContent[] = [];
  const head = afterMarker.replace(/^[ \t\u00a0]+/, '');
  const nl = head.indexOf('\n');
  if (nl !== -1) {
    if (nl > 0) title.push(text(head.slice(0, nl)));
    const rest = head.slice(nl + 1);
    paragraph.children = [...(rest ? [text(rest)] : []), ...kids.slice(1)];
    return title;
  }
  if (head) title.push(text(head));
  for (let k = 1; k < kids.length; k++) {
    const node = kids[k];
    if (node.type === 'break') {
      paragraph.children = kids.slice(k + 1);
      return title;
    }
    if (node.type === 'text' && node.value.includes('\n')) {
      const at = node.value.indexOf('\n');
      if (at > 0) title.push(text(node.value.slice(0, at)));
      const rest = node.value.slice(at + 1);
      paragraph.children = [...(rest ? [text(rest)] : []), ...kids.slice(k + 1)];
      return title;
    }
    title.push(node);
  }
  paragraph.children = [];
  return title;
}

function trimTitle(title: PhrasingContent[]): PhrasingContent[] {
  const last = title[title.length - 1];
  if (last && last.type === 'text') {
    const value = last.value.replace(/[ \t]+$/, '');
    if (value) title[title.length - 1] = text(value);
    else title.pop();
  }
  return title;
}

function applyCallout(quote: Blockquote, options: RemarkOfmOptions): void {
  const paragraph = quote.children[0];
  if (!paragraph || paragraph.type !== 'paragraph') return;
  const first = paragraph.children[0];
  if (!first || first.type !== 'text') return;
  const marker = matchCalloutMarker(first.value);
  if (!marker) return;

  const title = trimTitle(takeTitle(paragraph, first.value.slice(marker.length)));
  if (paragraph.children.length === 0) quote.children.shift();

  const kind = calloutKind(marker.type);
  const label = options.calloutLabel ? options.calloutLabel(marker.type) : capitalizeType(marker.type);

  if (options.mode === 'export') {
    quote.children.unshift({ type: 'paragraph', children: [{ type: 'strong', children: title.length ? title : [text(label)] }] } as Paragraph);
    return;
  }

  const foldable = marker.fold !== null;
  const props: AnyRecord = { className: ['md-alert', `md-alert-${kind}`], dataAlert: kind, dataCallout: marker.type };
  if (title.length === 0 && !foldable) props.dataAlertLabel = label;
  if (marker.fold === '+') props.open = true;
  const data = dataOf(quote);
  data.hName = foldable ? 'details' : 'div';
  data.hProperties = props;
  if (title.length > 0 || foldable) {
    quote.children.unshift(
      hinted('ofmCalloutTitle', foldable ? 'summary' : 'div', { className: ['md-alert-title'] }, title.length ? title : [text(label)]) as unknown as RootContent as Blockquote['children'][number],
    );
  }
}

/**
 * A comment taken out of a paragraph leaves the line break that stood next to it
 * ("text\n%% note %%" is "text\n"): trim what is left at the two ends, and drop a
 * paragraph that held nothing else.
 */
function tidyParagraph(node: Paragraph, parent: (N & { children: N[] }) | null, index: number): void {
  const kids = node.children;
  while (kids.length > 0 && kids[0].type === 'text') {
    const value = kids[0].value.replace(/^\s+/, '');
    if (value) {
      kids[0].value = value;
      break;
    }
    kids.shift();
  }
  while (kids.length > 0 && kids[kids.length - 1].type === 'text') {
    const last = kids[kids.length - 1] as Text;
    const value = last.value.replace(/\s+$/, '');
    if (value) {
      last.value = value;
      break;
    }
    kids.pop();
  }
  if (kids.length === 0 && parent) parent.children.splice(index, 1);
}

/** `^id` at the end of a paragraph: hidden; the block (or the one above, for an id on its own line) gets the anchor `^id`. */
function applyBlockId(node: Paragraph, parent: (N & { children: N[] }) | null, index: number, options: RemarkOfmOptions): void {
  const last = node.children[node.children.length - 1];
  if (!last || last.type !== 'text') return;
  const match = matchBlockIdAtEnd(last.value);
  if (!match) return;
  const kept = last.value.slice(0, match.index).replace(/[ \t]+$/, '');
  if (kept) last.value = kept;
  else node.children.pop();

  const alone = node.children.length === 0;
  if (options.mode === 'reading' && parent) {
    // A tight list item loses its paragraph when drawn: the anchor goes on the item. An id on a line of its own belongs to the block above.
    const holder = alone ? parent.children[index - 1] : parent.type === 'listItem' ? parent : node;
    if (holder) {
      const props = (dataOf(holder).hProperties as AnyRecord | undefined) ?? {};
      props.id = `^${match.id}`;
      dataOf(holder).hProperties = props;
    }
  }
  if (alone && parent) parent.children.splice(index, 1);
}

/** Paragraphs made by splitting around an inline embed: their end is not the end of the author's paragraph (no block id there). */
const splitParagraphs = new WeakSet<N>();

function asEmbedBlock(node: N): N {
  const data = dataOf(node);
  data.hName = 'div';
  const { href: _href, ...rest } = data.hProperties as AnyRecord;
  data.hProperties = { ...rest, className: ['folio-embed'] };
  return node;
}

/** The text at the two ends of a piece around an embed is trimmed (the blank that stood next to the embed). */
function trimEnds(kids: PhrasingContent[]): PhrasingContent[] {
  const out = [...kids];
  const head = out[0];
  if (head && head.type === 'text') out[0] = text(head.value.replace(/^\s+/, ''));
  const tail = out[out.length - 1];
  if (tail && tail.type === 'text') out[out.length - 1] = text(tail.value.replace(/\s+$/, ''));
  return out.filter((c) => !(c.type === 'text' && c.value === ''));
}

/**
 * A paragraph holding nothing but one embed or one display formula becomes that block. A note embed in the middle
 * of a line (`see ![[Note#Heading]] here`) is a block too, as in Obsidian: the paragraph is split around it.
 */
function promoteBlock(node: Paragraph, parent: (N & { children: N[] }) | null, index: number): void {
  if (!parent) return;
  const kids = node.children.filter((c) => !(c.type === 'text' && c.value.trim() === ''));
  const isEmbed = (c: unknown): boolean => (c as { type: string }).type === 'ofmWikilink' && (c as { embed?: boolean }).embed === true;
  if (kids.length === 1) {
    const only = kids[0] as unknown as { type: string; embed?: boolean; display?: boolean };
    if (isEmbed(only)) {
      parent.children[index] = asEmbedBlock(only as unknown as N);
    } else if (only.type === 'ofmMath' && only.display) {
      dataOf(only as unknown as N).hName = 'div';
      parent.children[index] = only as unknown as N;
    }
    return;
  }
  if (!node.children.some(isEmbed)) return;
  const pieces: N[] = [];
  let run: PhrasingContent[] = [];
  const flush = (): void => {
    const trimmed = trimEnds(run);
    run = [];
    if (trimmed.length === 0) return;
    const piece: Paragraph = { type: 'paragraph', children: trimmed };
    splitParagraphs.add(piece as N);
    pieces.push(piece as N);
  };
  for (const child of node.children) {
    if (isEmbed(child)) {
      flush();
      pieces.push(asEmbedBlock(child as unknown as N));
    } else {
      run.push(child);
    }
  }
  flush();
  parent.children.splice(index, 1, ...pieces);
}

/** Export mode: a display formula standing alone is a code block, not a code span. */
function exportBlockMath(node: Paragraph, parent: (N & { children: N[] }) | null, index: number, displays: Map<N, string>): void {
  if (!parent || node.children.length !== 1) return;
  const tex = displays.get(node.children[0] as N);
  if (tex !== undefined) parent.children[index] = { type: 'code', lang: 'tex', value: tex } as N;
}

// ---------------------------------------------------------------------------
// the plugin
// ---------------------------------------------------------------------------

export function remarkOfm(options: RemarkOfmOptions) {
  return (tree: Root, file: { value: unknown }): void => {
    const source = String(file.value);
    const lines = new SourceLines(source);
    const displays = new Map<N, string>();

    // 1. inline constructs, by source range
    const tokens = scanOfm(source, {
      exclude: rangesOf(tree, CODE_TYPES),
      noTags: options.mode === 'export' ? undefined : rangesOf(tree, LINK_TYPES),
    });
    for (const token of tokens) {
      const built = options.mode === 'reading' ? readingNodeFor(token, source) : exportNodeFor(token, source);
      if (built === undefined) continue;
      const nodes = built === null ? [] : [withRange(built, token.from, token.to, lines)];
      if (options.mode === 'export' && token.kind === 'math' && token.display && built) displays.set(built, token.tex);
      placeRange(tree, source, lines, token.from, token.to, nodes, { clip: token.kind === 'comment' });
    }

    // 2.-3. blocks
    walk(tree, (node, parent, index) => {
      if (node.type === 'blockquote') applyCallout(node, options);
      else if (node.type === 'paragraph') {
        tidyParagraph(node, parent, index);
        if (parent && parent.children[index] !== node) return;
        if (splitParagraphs.has(node)) return;
        applyBlockId(node, parent, index, options);
        if (parent && parent.children[index] === node) {
          if (options.mode === 'reading') promoteBlock(node, parent, index);
          else exportBlockMath(node, parent, index, displays);
        }
      }
    });
  };
}
