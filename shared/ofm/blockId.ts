/**
 * `^block-id` — the ONE block-id rule (Obsidian vault compatibility, wave 2).
 *
 * A block id is `^` + letters, digits and `-`, ending a paragraph (after a
 * space, at the start of the line, or right after a `]]`: `![[img.png]]^id`),
 * or standing alone as the last paragraph below a structural block (a table, a
 * quote, a list). The page index (server/indexV2/parse.ts) records it as the
 * target of `#^id`, the reading view hides it and puts an anchor on the block,
 * the live editor dims it.
 */

export const BLOCK_ID_RE = /(?:^|\s|\]\])\^([A-Za-z0-9-]+)[ \t]*$/;

export interface BlockIdMatch {
  /** The id as written, without the `^`. */
  id: string;
  /** Offset of the `^` in the text. */
  index: number;
}

/** The block id at the very end of `text` (the last text of a paragraph), or null. */
export function matchBlockIdAtEnd(text: string): BlockIdMatch | null {
  const m = BLOCK_ID_RE.exec(text);
  if (!m) return null;
  return { id: m[1], index: m.index + m[0].indexOf('^') };
}
