/**
 * Heading anchors — the slug rules of the web outline and reading view
 * (web/src/markdown/slugify.ts, headings.ts' createSlugDeduper and
 * headingAnchorSource), here in shared/ so the server's page index
 * (server/indexV2) computes exactly the ids the reading view assigns: a
 * `[x](page.md#some-heading)` link and a `[[page#Some heading]]` wikilink are
 * resolved against these slugs. web/ keeps its own copy for now (index v2,
 * wave 1b, is server-only); both sides are pinned by tests to the same
 * examples, and wave 2 can switch the web to import this file.
 *
 * Plain TS over mdast types, no DOM and no unist helpers (the server ships
 * without devDependencies).
 */
import type { Heading, Nodes } from 'mdast';

/**
 * GitHub-style heading slug: lowercase, strip punctuation (Unicode letters and
 * numbers are kept, so a Cyrillic heading gets a native slug), whitespace runs
 * become one hyphen.
 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

/** A slug generator deduped against every slug it has already produced: 1st occurrence bare, 2nd `-2`, 3rd `-3`, ... (the outline's convention). */
export function createSlugDeduper(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text: string): string => {
    const base = slugifyHeading(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  };
}

/**
 * The text a heading's slug is made from: prose and inline code exactly as the
 * parser hands them over, with no highlight/status handling (the label does
 * that; the anchor stays what GitHub makes of the raw line).
 */
export function headingAnchorSource(node: Heading): string {
  let text = '';
  const walk = (n: Nodes): void => {
    if (n.type === 'text' || n.type === 'inlineCode') text += n.value;
    if ('children' in n) for (const child of n.children as Nodes[]) walk(child);
  };
  walk(node);
  return text;
}
