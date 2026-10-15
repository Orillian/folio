/**
 * GitHub-style heading slug: lowercase, strip punctuation (keeping Unicode
 * letters/numbers so Cyrillic headings get readable native slugs rather
 * than being transliterated — matches how GitHub itself anchors non-Latin
 * headings, and this app treats GitHub-renderable fidelity as a hard
 * requirement), spaces collapse to a single hyphen.
 *
 * The rule itself lives in shared/headingSlug.ts since wave 2 of the Obsidian
 * work: the server's page index (which `[[Note#Heading]]` is resolved against)
 * and this reading view now run the very same function.
 */
export { slugifyHeading as slugify } from '@shared/headingSlug';
