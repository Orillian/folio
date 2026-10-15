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
import { parseMarkdownAst } from './markdownAst.js';

export function docIndexText(body: string): string {
  return stripStatusDirectives(stripOfmComments(body, parseMarkdownAst));
}
