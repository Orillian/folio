/**
 * The OFM scanner — Obsidian-flavoured inline constructs found in SOURCE text
 * (Obsidian vault compatibility, wave 2). ONE declaration of "what is a
 * comment, a wikilink, an embed, a tag, a formula and where does it start and
 * end", used by everything that reads them:
 *   - the reading view and the exports (remark.ts runs the scanner on the
 *     page source and applies the tokens to the mdast);
 *   - the live editor (web/src/editor/live-decorations.ts scans the document
 *     and decorates the ranges, no file change);
 *   - the plain-text extractor of the search index (plainText.ts).
 *
 * The caller says where the constructs may NOT start — `exclude`: code, inline
 * code, raw HTML (taken from its own parse: mdast in the web pipeline and the
 * server, the Lezer tree in the editor) and `noTags`: links and images, where
 * a `#x` is link text. Everything else is decided here:
 *
 *  - `%%comment%%` — inline or block, may span lines; an unclosed `%%` is just
 *    text (Obsidian would hide the rest of the note; Folio degrades to text);
 *  - `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`, `[[Note#^block]]`,
 *    `![[embed]]` — wikilink.ts;
 *  - `#tag`, `#a/b` — tags.ts;
 *  - `$inline$` and `$$display$$` — an inline formula opens before a
 *    non-blank, closes after a non-blank and never before a digit, so prose
 *    like "costs $5 and $6" stays prose; it cannot span lines; a display
 *    formula may, but not across a blank line.
 * A backslash escapes the character after it (`\$`, `\[[x]]`, `\%%`, `\#x`).
 * Tokens never overlap: the one that starts first wins, a comment before a
 * formula before a link before a tag.
 */
import { findTags } from './tags.js';
import { wikilinkParts, wikilinkRegExp } from './wikilink.js';

export type Range = readonly [number, number];

export interface CommentToken {
  kind: 'comment';
  from: number;
  to: number;
}
export interface WikilinkToken {
  kind: 'wikilink';
  from: number;
  to: number;
  /** `![[...]]`. */
  embed: boolean;
  /** The link path as written (trimmed; '' for `[[#Heading]]`), the fragment without `#`, the alias — see wikilinkParts. */
  path: string;
  fragment: string | null;
  alias: string | null;
}
export interface TagToken {
  kind: 'tag';
  from: number;
  to: number;
  /** Normalized (lowercase, no `#`). */
  tag: string;
}
export interface MathToken {
  kind: 'math';
  from: number;
  to: number;
  /** The TeX between the dollars, as written (display: trimmed). */
  tex: string;
  display: boolean;
}
export type OfmToken = CommentToken | WikilinkToken | TagToken | MathToken;

export interface ScanOptions {
  /** Ranges no construct may start in or contain a delimiter of: code, inline code, raw HTML. */
  exclude?: readonly Range[];
  /** Ranges where only tags are off: links, images, autolinks. */
  noTags?: readonly Range[];
  /** The character right before `text[0]` in its document; undefined = the start of the document. */
  before?: string;
}

const MASK = '\u0001';
const MAX_INLINE_MATH = 2000;
const MAX_DISPLAY_MATH = 20000;

/** True when `text[i]` is preceded by an odd number of backslashes. */
export function isEscapedAt(text: string, i: number): boolean {
  let n = 0;
  for (let k = i - 1; k >= 0 && text[k] === '\\'; k--) n++;
  return n % 2 === 1;
}

/** A copy of `text` of the same length with every character in `ranges` replaced by a mask character (line breaks kept). */
export function maskText(text: string, ranges: readonly Range[]): string {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (const [from, to] of sorted) {
    const start = Math.max(from, cursor);
    const end = Math.min(to, text.length);
    if (end <= start) continue;
    out += text.slice(cursor, start) + text.slice(start, end).replace(/[^\n\r]/g, MASK);
    cursor = end;
  }
  return out + text.slice(cursor);
}

function indexOfUnescaped(text: string, needle: string, from: number): number {
  for (let i = text.indexOf(needle, from); i !== -1; i = text.indexOf(needle, i + 1)) {
    if (!isEscapedAt(text, i)) return i;
  }
  return -1;
}

function findComments(masked: string): CommentToken[] {
  const out: CommentToken[] = [];
  let i = 0;
  for (;;) {
    const open = indexOfUnescaped(masked, '%%', i);
    if (open === -1) break;
    const close = indexOfUnescaped(masked, '%%', open + 2);
    if (close === -1) break;
    out.push({ kind: 'comment', from: open, to: close + 2 });
    i = close + 2;
  }
  return out;
}

function findMath(masked: string, text: string): MathToken[] {
  const out: MathToken[] = [];
  let i = 0;
  while (i < masked.length) {
    const open = masked.indexOf('$', i);
    if (open === -1) break;
    if (isEscapedAt(masked, open)) {
      i = open + 1;
      continue;
    }
    if (masked[open + 1] === '$') {
      const close = indexOfUnescaped(masked, '$$', open + 2);
      const content = close === -1 ? '' : masked.slice(open + 2, close);
      if (close === -1 || !content.trim() || content.length > MAX_DISPLAY_MATH || /\n[ \t]*\n/.test(content) || content.includes(MASK)) {
        i = open + 2;
        continue;
      }
      out.push({ kind: 'math', from: open, to: close + 2, tex: text.slice(open + 2, close).trim(), display: true });
      i = close + 2;
      continue;
    }
    const next = masked[open + 1];
    if (next === undefined || /\s/.test(next)) {
      i = open + 1;
      continue;
    }
    let lineEnd = masked.indexOf('\n', open + 1);
    if (lineEnd === -1) lineEnd = masked.length;
    // The first unescaped `$` after the opening one decides: it either closes the formula or this `$` was not an opening (so "$5 and $6" stays prose).
    let close = -1;
    for (let j = masked.indexOf('$', open + 1); j !== -1 && j < lineEnd; j = masked.indexOf('$', j + 1)) {
      if (isEscapedAt(masked, j)) continue;
      if (!/\s/.test(masked[j - 1]) && !/\d/.test(masked[j + 1] ?? '')) close = j;
      break;
    }
    const content = close === -1 ? '' : masked.slice(open + 1, close);
    if (close === -1 || content.length > MAX_INLINE_MATH || content.includes(MASK)) {
      i = open + 1;
      continue;
    }
    out.push({ kind: 'math', from: open, to: close + 1, tex: text.slice(open + 1, close), display: false });
    i = close + 1;
  }
  return out;
}

function findWikilinks(masked: string, text: string): WikilinkToken[] {
  const out: WikilinkToken[] = [];
  if (!masked.includes('[[')) return out;
  const re = wikilinkRegExp();
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const open = m.index + m[1].length;
    // Inline code is masked: allowed in the ALIAS (`[[Functions#hasTag|`hasTag`]]`), never in the path or fragment.
    const bar = m[2].indexOf('|');
    if ((bar === -1 ? m[2] : m[2].slice(0, bar)).includes(MASK) || isEscapedAt(masked, open)) continue;
    const embed = m[1] === '!' && !isEscapedAt(masked, m.index);
    const inner = text.slice(m.indices![2][0], m.indices![2][1]);
    const parts = wikilinkParts(inner);
    out.push({ kind: 'wikilink', from: embed ? m.index : open, to: m.index + m[0].length, embed, ...parts });
  }
  return out;
}

function inRanges(ranges: readonly Range[], pos: number): boolean {
  for (const [from, to] of ranges) if (pos >= from && pos < to) return true;
  return false;
}

const PRIORITY: Record<OfmToken['kind'], number> = { comment: 0, math: 1, wikilink: 2, tag: 3 };

/** The OFM tokens of `text`, in order, none overlapping another. */
export function scanOfm(text: string, options: ScanOptions = {}): OfmToken[] {
  if (!/\[\[|%%|\$|#/.test(text)) return [];
  const masked = maskText(text, options.exclude ?? []);
  const noTags = options.noTags ?? [];

  const candidates: OfmToken[] = [];
  if (masked.includes('%%')) candidates.push(...findComments(masked));
  if (masked.includes('$')) candidates.push(...findMath(masked, text));
  candidates.push(...findWikilinks(masked, text));
  if (masked.includes('#')) {
    for (const tag of findTags(masked, options.before)) {
      if (inRanges(noTags, tag.index)) continue;
      candidates.push({ kind: 'tag', from: tag.index, to: tag.index + tag.length, tag: tag.tag });
    }
  }

  candidates.sort((a, b) => a.from - b.from || PRIORITY[a.kind] - PRIORITY[b.kind]);
  const out: OfmToken[] = [];
  let end = -1;
  for (const token of candidates) {
    if (token.from < end) continue;
    out.push(token);
    end = token.to;
  }
  return out;
}
