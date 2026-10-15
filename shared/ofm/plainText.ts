/**
 * The plain-text fallback of OFM for the search index (Obsidian vault
 * compatibility, wave 2). `pages_index.plain_text` is what full-text search
 * reads and what a snippet shows: a `%%comment%%` is not content (hidden in
 * Reading, stripped from exports), everything else — wikilink brackets, `#tag`
 * words, formulas — stays, so that a search for a note's name finds the pages
 * that link to it and a search for a tag finds the pages that carry it.
 *
 * Code is a different story: a `%%` in a fenced block or a code span is code,
 * so comments are found with the code ranges of the page's own parse.
 */
import type { Root } from 'mdast';
import { scanOfm } from './scan.js';
import { rangesOf } from './tree.js';

const CODE_TYPES = new Set(['code', 'inlineCode', 'html', 'yaml', 'definition']);

/** `text` without its `%%comments%%`. `parse` is the mdast of `text` (only called when a comment can be there at all). */
export function stripOfmComments(text: string, parse: (text: string) => Root): string {
  if (!text.includes('%%')) return text;
  const tokens = scanOfm(text, { exclude: rangesOf(parse(text), CODE_TYPES) });
  let out = '';
  let cursor = 0;
  for (const token of tokens) {
    if (token.kind !== 'comment') continue;
    out += text.slice(cursor, token.from);
    cursor = token.to;
  }
  return out + text.slice(cursor);
}
