/**
 * The text a document contributes to full-text search (`pages_index.plain_text`
 * and the `tsv` built from it). Two things in a body are not content:
 *
 *  - a `:status[Done]{color=green}` tag is searched (and shown in a snippet) as
 *    its label — the attributes are not words anyone looks for;
 *  - a `%%comment%%` (Obsidian) is hidden in the reading view and left out of
 *    exports, so it must not be findable either. A `%%` inside code is code
 *    (the comment scan runs over the page's own parse).
 *
 * Everything else stays on purpose: wikilink brackets (a search for a note's
 * name finds the pages that link to it), `#tag` words, formulas. A body without
 * either construct comes out byte-identical.
 */
import { stripOfmComments } from '../shared/ofm/plainText.js';
import { stripStatusDirectives } from '../shared/status.js';
import { parseMarkdownAstAsync, parseMarkdownAstChunked } from './markdownAst.js';

export function docIndexText(body: string): string {
  return stripStatusDirectives(stripOfmComments(body, parseMarkdownAstChunked));
}

/** docIndexText that yields to the event loop while it parses a big body with comments (the scan's upsert). */
export async function docIndexTextAsync(body: string): Promise<string> {
  if (!body.includes('%%')) return stripStatusDirectives(body);
  const tree = await parseMarkdownAstAsync(body);
  return stripStatusDirectives(stripOfmComments(body, () => tree));
}
