/**
 * Page metadata parser for the page index (index v2, Obsidian brief wave 1b) —
 * pure, no database. ONE mdast parse of a page body (markdownAst.ts: remark-parse
 * + GFM + underline, positions on; front matter already removed by the caller)
 * yields:
 *
 *  - HEADINGS: level, label (shared/inlineText), slug (shared/headingSlug, with
 *    the outline's duplicate suffixes `-2`, `-3`), line, position.
 *  - BLOCK IDS: a `^id` (letters, digits, `-`) ending a paragraph or list-item
 *    paragraph (after a space, or right after a `]]`), or standing alone on its
 *    own line below a table/quote — the target of `#^id`.
 *  - TAGS: `#tag` / `#a/b` in prose, after whitespace or at the start of a line;
 *    letters, digits, `_`, `-`, `/`; at least one letter (`#123` is not a tag);
 *    a hex colour (`#fff`, `#a1b2c3`: hex digits, 3/4/6/8 long, with a digit or
 *    one repeated letter) is not a tag; never inside code, links, autolinks,
 *    HTML or after a backslash. Front matter `tags:` and `labels:` (a list or a
 *    comma/space separated string) are tags with source 'frontmatter'. Tags are
 *    lowercased, without the `#`, hierarchy kept.
 *    A `%%comment%%` (Obsidian) is not content - hidden in the reading view, left out of
 *    exports and search - so a tag, a block id or a link inside one is not indexed either
 *    (the comment is found with the shared scanner, shared/ofm/scan.ts, over this tree's code).
 *  - LINKS of every syntax: `[text](href)` md, `![alt](src)` image, `[[…]]` /
 *    `![[…]]` wikilink / embed (wikilinks.ts), HTML `<a href>` / `<img src>`,
 *    and reference-style `[text][label]` with its `[label]: path` definition
 *    (one row per use). Each carries its fragment (`#heading` -> heading,
 *    `#^id` -> block, with the key it is matched by), display text, line and
 *    context (the trimmed source line, at most 300 characters). Autolinks
 *    (`<https://…>`, bare URLs) and same-page `#fragment` links are not
 *    recorded; neither is anything inside code.
 *
 * Lines are 1-based within the body as indexed (the text after the front
 * matter block) — the text the editor shows.
 */
import type { Definition, Heading, Html, Nodes, Paragraph, PhrasingContent, Root, Text } from 'mdast';
import type { LinkFragmentKind, LinkSyntax } from '../../shared/contracts.js';
import { createSlugDeduper, headingAnchorSource } from '../../shared/headingSlug.js';
import { phrasingToPlainText } from '../../shared/inlineText.js';
import { matchBlockIdAtEnd } from '../../shared/ofm/blockId.js';
import { scanOfm } from '../../shared/ofm/scan.js';
import { findTags, normalizeTag } from '../../shared/ofm/tags.js';
import { fragmentInfo } from '../../shared/ofm/wikilink.js';
import { codeRanges, maskRanges, parseMarkdownAst } from '../markdownAst.js';
import { findWikilinks } from '../wikilinks.js';

export interface ParsedHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  slug: string;
  line: number;
  /** 0-based order of the heading in the page. */
  position: number;
}

export interface ParsedBlock {
  blockId: string;
  line: number;
}

export interface ParsedTag {
  tag: string;
  source: 'body' | 'frontmatter';
  line: number | null;
}

export interface ParsedLink {
  syntax: LinkSyntax;
  /** The target as written: no `#fragment`, no `?query` (the whole URL for an external link); trimmed. */
  linkPath: string;
  fragment: string | null;
  fragmentKind: LinkFragmentKind | null;
  /** What the fragment is matched by: a heading slug, or a lowercased block id. */
  fragmentKey: string | null;
  displayText: string | null;
  line: number;
  context: string;
}

export interface ParsedPageMeta {
  headings: ParsedHeading[];
  blocks: ParsedBlock[];
  tags: ParsedTag[];
  links: ParsedLink[];
}

export const CONTEXT_MAX_CHARS = 300;

/** The trimmed line, cut at CONTEXT_MAX_CHARS characters without splitting a surrogate pair. */
export function contextOf(lines: readonly string[], line: number): string {
  const text = (lines[line - 1] ?? '').trim();
  if (text.length <= CONTEXT_MAX_CHARS) return text;
  return Array.from(text).slice(0, CONTEXT_MAX_CHARS).join('');
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

// The fragment rules (`#heading` by slug, `#^id` by block) are shared/ofm/wikilink.ts' fragmentInfo — the reading view resolves the same way.
export { fragmentInfo };

/** `href` -> path part / fragment; null when the link has no path (a same-page `#x` or `?q` link). */
function splitHref(href: string): { linkPath: string; fragment: string | null } | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('/')) return { linkPath: trimmed, fragment: null };
  const hashIdx = trimmed.indexOf('#');
  let pathPart = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? null : trimmed.slice(hashIdx + 1);
  const qIdx = pathPart.indexOf('?');
  if (qIdx !== -1) pathPart = pathPart.slice(0, qIdx);
  // A `#x` / `?q` alone points into this very page: no backlink, no row (as before).
  if (!pathPart) return null;
  return { linkPath: pathPart, fragment };
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

// The tag rule itself (what is a tag, how it is normalized) is shared/ofm/tags.ts — the reading view's chips and the editor use it too.
export { normalizeTag };

function frontmatterTags(frontmatter: Record<string, unknown> | null | undefined): string[] {
  if (!frontmatter) return [];
  const out: string[] = [];
  for (const key of ['tags', 'labels']) {
    const value = frontmatter[key];
    const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
    for (const item of items) {
      if (typeof item !== 'string' && typeof item !== 'number') continue;
      const tag = normalizeTag(String(item));
      if (tag) out.push(tag);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML links
// ---------------------------------------------------------------------------

const HTML_LINK_RE = /<(a|img)\b[^>]*?\s(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>/gi;
const HTML_ALT_RE = /\salt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

/** 1-based line of a source offset, by binary search over the offsets where lines start. */
function lineLocator(body: string): (offset: number) => number {
  const starts = [0];
  for (let i = body.indexOf('\n'); i !== -1; i = body.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

export function parsePageMeta(body: string, frontmatter?: Record<string, unknown> | null): ParsedPageMeta {
  const tree: Root = parseMarkdownAst(body);
  const lines = body.split('\n').map((l) => l.replace(/\r$/, ''));
  const lineAt = lineLocator(body);
  const headings: ParsedHeading[] = [];
  const blocks: ParsedBlock[] = [];
  const tags: ParsedTag[] = [];
  const links: ParsedLink[] = [];
  const dedupe = createSlugDeduper();

  const definitions = new Map<string, Definition>();
  const collectDefinitions = (node: Nodes): void => {
    if (node.type === 'definition') definitions.set(node.identifier, node);
    if ('children' in node) for (const child of node.children as Nodes[]) collectDefinitions(child);
  };
  collectDefinitions(tree);

  // `%%comments%%`: [from, to) of each, outside code.
  const commentRanges: Array<[number, number]> = body.includes('%%')
    ? scanOfm(body, { exclude: codeRanges(tree) }).flatMap((t) => (t.kind === 'comment' ? [[t.from, t.to] as [number, number]] : []))
    : [];
  const inComment = (offset: number | undefined): boolean => offset !== undefined && commentRanges.some(([from, to]) => offset >= from && offset < to);

  const pushLink = (syntax: LinkSyntax, href: string, displayText: string | null, line: number, offset?: number): void => {
    if (inComment(offset)) return;
    const split = splitHref(href);
    if (!split) return;
    const frag = fragmentInfo(split.fragment);
    links.push({
      syntax,
      linkPath: split.linkPath,
      fragment: frag?.fragment ?? null,
      fragmentKind: frag?.kind ?? null,
      fragmentKey: frag?.key ?? null,
      displayText: displayText && displayText.trim() ? displayText.trim() : null,
      line,
      context: contextOf(lines, line),
    });
  };

  const textTags = (node: Text): void => {
    const start = node.position?.start;
    const end = node.position?.end;
    if (!start || !end || start.offset === undefined || end.offset === undefined) return;
    // The SOURCE of the text node (escapes and character references included), so `\#x` and `&#35;x` are not tags.
    const source = body.slice(start.offset, end.offset);
    if (!source.includes('#')) return;
    for (const match of findTags(source, body[start.offset - 1])) {
      if (inComment(start.offset + match.index)) continue;
      tags.push({ tag: match.tag, source: 'body', line: lineAt(start.offset + match.index) });
    }
  };

  const htmlLinks = (node: Html): void => {
    const start = node.position?.start;
    if (!start || start.offset === undefined) return;
    const re = new RegExp(HTML_LINK_RE);
    let m: RegExpExecArray | null;
    while ((m = re.exec(node.value)) !== null) {
      const tagName = m[1].toLowerCase();
      const attr = m[2].toLowerCase();
      if ((tagName === 'a') !== (attr === 'href')) continue; // `<a src>` / `<img href>` are no links
      const href = m[3] ?? m[4] ?? m[5] ?? '';
      let display: string | null = null;
      if (tagName === 'img') {
        const alt = HTML_ALT_RE.exec(m[0]);
        display = alt ? (alt[1] ?? alt[2] ?? alt[3] ?? null) : null;
      } else {
        const close = node.value.toLowerCase().indexOf('</a>', m.index + m[0].length);
        if (close !== -1) display = node.value.slice(m.index + m[0].length, close).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');
      }
      let line = start.line;
      for (let i = node.value.indexOf('\n'); i !== -1 && i < m.index; i = node.value.indexOf('\n', i + 1)) line++;
      pushLink('html', href, display, line, start.offset + m.index);
    }
  };

  const blockId = (node: Paragraph): void => {
    const last = node.children[node.children.length - 1];
    if (!last || last.type !== 'text') return;
    const start = last.position?.start;
    const end = last.position?.end;
    if (!start || !end || start.offset === undefined || end.offset === undefined) return;
    const m = matchBlockIdAtEnd(body.slice(start.offset, end.offset));
    if (m && !inComment(start.offset + m.index)) blocks.push({ blockId: m.id, line: end.line });
  };

  const walk = (node: Nodes, inLink: boolean): void => {
    switch (node.type) {
      case 'code':
      case 'inlineCode':
      case 'definition':
        return;
      case 'heading': {
        const h = node as Heading;
        headings.push({
          level: h.depth as ParsedHeading['level'],
          text: phrasingToPlainText(h.children),
          slug: dedupe(headingAnchorSource(h)),
          line: h.position?.start.line ?? 0,
          position: headings.length,
        });
        break;
      }
      case 'paragraph':
        blockId(node);
        break;
      case 'text':
        if (!inLink) textTags(node);
        return;
      case 'html':
        htmlLinks(node);
        return;
      case 'link': {
        const offset = node.position?.start.offset;
        // `<https://…>` and bare URLs are autolinks: external text, not a link anyone wrote as one.
        if (offset !== undefined && body[offset] === '[') pushLink('md', node.url, phrasingToPlainText(node.children as PhrasingContent[]), node.position?.start.line ?? 0, offset);
        for (const child of node.children) walk(child, true);
        return;
      }
      case 'image':
        pushLink('image', node.url, node.alt ?? null, node.position?.start.line ?? 0, node.position?.start.offset);
        return;
      case 'linkReference': {
        const def = definitions.get(node.identifier);
        if (def) pushLink('reference', def.url, phrasingToPlainText(node.children as PhrasingContent[]), node.position?.start.line ?? 0, node.position?.start.offset);
        for (const child of node.children) walk(child, true);
        return;
      }
      case 'imageReference': {
        const def = definitions.get(node.identifier);
        if (def) pushLink('reference', def.url, node.alt ?? null, node.position?.start.line ?? 0, node.position?.start.offset);
        return;
      }
      default:
        break;
    }
    if ('children' in node) for (const child of node.children as Nodes[]) walk(child, inLink);
  };
  walk(tree, false);

  // Wikilinks are not mdast syntax: found in the text with this same tree's code blanked.
  if (body.includes('[[')) {
    const masked = maskRanges(body, [...codeRanges(tree), ...commentRanges]);
    for (const ref of findWikilinks(body, masked)) {
      if (!ref.path || /^[a-z][a-z0-9+.-]*:/i.test(ref.path)) continue; // `[[#Heading]]` is this page; a URL is no note
      const barIdx = ref.rest.search(/\\?\|/);
      const fragPart = barIdx === -1 ? ref.rest : ref.rest.slice(0, barIdx);
      const alias = barIdx === -1 ? null : ref.rest.slice(barIdx).replace(/^\\?\|/, '');
      const frag = fragmentInfo(fragPart.startsWith('#') ? fragPart.slice(1) : null);
      const line = lineAt(ref.start);
      links.push({
        syntax: ref.embed ? 'embed' : 'wikilink',
        linkPath: ref.path,
        fragment: frag?.fragment ?? null,
        fragmentKind: frag?.kind ?? null,
        fragmentKey: frag?.key ?? null,
        displayText: alias && alias.trim() ? alias.trim() : null,
        line,
        context: contextOf(lines, line),
      });
    }
    links.sort((a, b) => a.line - b.line);
  }

  const seenTags = new Set<string>();
  for (const tag of frontmatterTags(frontmatter)) {
    if (seenTags.has(tag)) continue;
    seenTags.add(tag);
    tags.push({ tag, source: 'frontmatter', line: null });
  }

  return { headings, blocks, tags, links };
}
