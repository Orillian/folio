import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { remarkUnderline } from '@shared/underline';
import { phrasingToPlainText } from '@shared/inlineText';
import { visit } from 'unist-util-visit';
import type { Root, Heading as MdHeading } from 'mdast';
import { createSlugDeduper, headingAnchorSource } from '@shared/headingSlug';
import { stripFrontmatter } from './frontmatter';

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface HeadingInfo {
  level: HeadingLevel;
  /** What the heading says, markup resolved (`==x=={.green}`, `:status[x]`, `**x**`, links, escapes): the label the outline shows. */
  text: string;
  slug: string;
}

/**
 * rehype-sanitize's default schema treats `id` as a DOM-clobbering risk and
 * unconditionally prefixes every one it sees with this string (a deliberate
 * security default folioSanitizeSchema doesn't override — see pipeline.ts).
 * `HeadingInfo.slug` stays the clean, semantic value everywhere it's used
 * for display/dedup/comparison; anything that needs to find the actual
 * rendered element (the outline panel's scrollIntoView/IntersectionObserver)
 * must look up `HEADING_ID_PREFIX + slug`, not the bare slug.
 */
export const HEADING_ID_PREFIX = 'user-content-';

// The deduped slug generator (1st occurrence bare, 2nd `-2`, 3rd `-3` ...) is shared/headingSlug.ts' — the server's page index uses it too.
export { createSlugDeduper };

/**
 * Parses `markdown` (just enough to find heading nodes — code fence
 * content, mermaid included, is never parsed as markdown text, so this
 * doesn't need the rendering pipeline's mermaid-fence pre-split) and
 * returns every heading in document order with a deduped slug.
 *
 * The rendering pipeline's rehypeAssignHeadingIds (pipeline.ts) consumes
 * this exact array, in order, via a shared cursor rather than recomputing
 * slugs itself — the outline panel calls this directly on the page's raw
 * markdown, and the two would silently drift apart (different heading ids
 * than what the TOC links to) if each ran its own independent dedupe.
 *
 * Strips a leading frontmatter block first (see frontmatter.ts) — otherwise
 * a `key: value` line immediately above the closing `---` parses as a
 * setext h2 underline, and a fake "icon: ..." heading would show up in the
 * outline panel for any page with an icon/cover set.
 */
export function extractHeadings(rawMarkdown: string): HeadingInfo[] {
  return parseHeadings(stripFrontmatter(rawMarkdown)).map(({ level, text, slug }) => ({ level, text, slug }));
}

/** A heading of a parsed document: `extractHeadings`' entry plus the offset it starts at in the text that was parsed. */
export interface ParsedHeading extends HeadingInfo {
  offset: number | undefined;
}

/**
 * Every heading of `markdown` (frontmatter already stripped) with its label,
 * its deduped slug and its offset. The ONE place headings are read, so the
 * outline, the rendered ids and the editor's scroll-to-heading cannot drift.
 */
export function parseHeadings(markdown: string): ParsedHeading[] {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkUnderline).parse(markdown) as Root;
  const dedupe = createSlugDeduper();
  const headings: ParsedHeading[] = [];

  visit(tree, 'heading', (node: MdHeading) => {
    headings.push({
      level: node.depth as HeadingLevel,
      text: phrasingToPlainText(node.children),
      slug: dedupe(headingAnchorSource(node)),
      offset: node.position?.start?.offset,
    });
  });

  return headings;
}
