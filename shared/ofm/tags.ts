/**
 * `#tag` / `#a/b` — the ONE tag rule (Obsidian vault compatibility, wave 2).
 *
 * The server's page index (server/indexV2/parse.ts), the reading view's chips,
 * the live editor's decorations and the OFM scanner (scan.ts) all ask this
 * file what is a tag, so a `#x` the index counts is a chip on screen and the
 * other way round:
 *  - letters, digits, marks, `_`, `-` and `/` (nesting); at least one letter,
 *    so `#123` is not a tag;
 *  - a hex colour (`#fff`, `#a1b2c3`: hex digits, 3/4/6/8 long, with a digit
 *    or one repeated letter) is not a tag;
 *  - the `#` must stand at the start of a line or after whitespace (`a#b`, a
 *    URL fragment and `[[Note#Heading]]` are not tags);
 *  - never inside code, links, autolinks, HTML or after a backslash — those
 *    are exclusions of WHERE the rule runs (the caller masks them), not of the
 *    rule itself.
 * Tags are lowercased, without the `#`, hierarchy kept.
 */

const TAG_RE = /#([\p{L}\p{N}\p{M}_\-/]+)/gu;
const HEX_COLOUR_RE = /^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** A tag as indexed: lowercased, no `#`, no surrounding or doubled `/`; null when it is not a tag (no letter; a hex colour). */
export function normalizeTag(raw: string): string | null {
  const tag = raw.replace(/^#+/, '').trim().replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!tag || !/\p{L}/u.test(tag)) return null;
  if (HEX_COLOUR_RE.test(tag) && (/\d/.test(tag) || /^(.)\1*$/.test(tag))) return null;
  return tag;
}

export interface TagMatch {
  /** Offset of the `#` in the scanned text. */
  index: number;
  /** Length of `#tag` as written. */
  length: number;
  /** Normalized tag (see normalizeTag). */
  tag: string;
}

/**
 * The tags of `source`, a stretch of prose. `before` is the character that
 * stands right before `source[0]` in the document (undefined: the start of the
 * document), so a tag at the very start of a text node is judged by its real
 * neighbour.
 */
export function findTags(source: string, before?: string): TagMatch[] {
  if (!source.includes('#')) return [];
  const out: TagMatch[] = [];
  const re = new RegExp(TAG_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const prev = m.index === 0 ? before : source[m.index - 1];
    if (prev !== undefined && !/\s/.test(prev)) continue;
    const tag = normalizeTag(m[1]);
    if (!tag) continue;
    out.push({ index: m.index, length: m[0].length, tag });
  }
  return out;
}
