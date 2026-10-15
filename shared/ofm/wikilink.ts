/**
 * Wikilinks and embeds — `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`,
 * `[[Note#^block]]`, `![[img.png|300]]`, `![[Note#Heading]]` — the ONE grammar
 * (Obsidian vault compatibility, wave 2). The rename/move rewriter and the
 * page index (server/wikilinks.ts, server/indexV2/parse.ts), the OFM scanner
 * (scan.ts) and through it the reading view, the live editor and the exports
 * all split a wikilink with the functions below, so none of them can read
 * `[[a#b|c]]` differently.
 *
 * Resolution (which page `Note` is) is NOT here: it is the server's index
 * (server/wikilinks.ts), and the reading view asks it through the page
 * metadata.
 */
import { slugifyHeading } from '../headingSlug.js';
import type { LinkFragmentKind } from '../contracts.js';

/** `[[x]](url)` is a markdown link whose text is `[x]`, not a wikilink. A fresh RegExp per use (it is global and stateful). */
export function wikilinkRegExp(): RegExp {
  return new RegExp(/(!?)\[\[([^\[\]\r\n]+)\]\](?!\()/gd);
}

export interface WikilinkInner {
  /** The text before `#` / `|`, untrimmed (the rewriter restores the whitespace around the path). */
  pathRaw: string;
  /** `#heading` / `#^block` with its `#`, or ''. */
  fragmentPart: string;
  /** `|alias` / `\|alias` (the escaped pipe of a table cell) with its bar, or ''. */
  aliasPart: string;
}

/** Splits what stands between `[[` and `]]`. */
export function splitWikilinkInner(inner: string): WikilinkInner {
  const bar = inner.indexOf('|');
  let left = bar === -1 ? inner : inner.slice(0, bar);
  let aliasPart = bar === -1 ? '' : inner.slice(bar);
  if (left.endsWith('\\')) {
    // `[[Note\|alias]]` — the pipe is escaped for a table cell; the backslash stays with the alias part.
    left = left.slice(0, -1);
    aliasPart = `\\${aliasPart}`;
  }
  const hash = left.indexOf('#');
  return {
    pathRaw: hash === -1 ? left : left.slice(0, hash),
    fragmentPart: hash === -1 ? '' : left.slice(hash),
    aliasPart,
  };
}

export interface WikilinkParts {
  /** The link path as written, trimmed. May be empty (`[[#Heading]]`: this very page). */
  path: string;
  /** The fragment as written, without `#`, trimmed; null when none. */
  fragment: string | null;
  /** The alias (or, for an image embed, the size/alt part) as written, trimmed; null when none. */
  alias: string | null;
}

export function wikilinkParts(inner: string): WikilinkParts {
  const { pathRaw, fragmentPart, aliasPart } = splitWikilinkInner(inner);
  const fragment = fragmentPart.slice(1).trim();
  const alias = aliasPart.replace(/^\\?\|/, '').trim();
  return { path: pathRaw.trim(), fragment: fragment || null, alias: alias || null };
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

function safeDecode(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * A fragment as written (without the leading `#`) -> what it is and the key it
 * is matched by. `^id` is a block; anything else a heading, keyed by its slug
 * (Obsidian's nested `#H1#H2` names the last heading). Null for an empty one.
 */
export function fragmentInfo(fragment: string | null): { fragment: string; kind: LinkFragmentKind; key: string } | null {
  if (fragment === null) return null;
  const trimmed = fragment.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('^')) {
    const id = trimmed.slice(1).trim();
    return id ? { fragment: trimmed, kind: 'block', key: id.toLowerCase() } : null;
  }
  const last = safeDecode(trimmed).split('#').filter((s) => s.trim()).pop() ?? '';
  const key = slugifyHeading(last);
  return key ? { fragment: trimmed, kind: 'heading', key } : null;
}

// ---------------------------------------------------------------------------
// Embeds
// ---------------------------------------------------------------------------

/** Extensions Folio draws as an <img> (the web's `resolveAssetSrc` knows the same set). */
export const IMAGE_EMBED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif']);

export function extensionOf(linkPath: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(linkPath);
  return m ? m[1].toLowerCase() : '';
}

export type EmbedTargetKind = 'image' | 'file' | 'note';

/** What `![[path]]` embeds: an image, another file (pdf, audio, video ...: a link), or a note (no extension or `.md`). */
export function embedTargetKind(linkPath: string): EmbedTargetKind {
  const ext = extensionOf(linkPath);
  if (ext === '' || ext === 'md') return 'note';
  return IMAGE_EMBED_EXTENSIONS.has(ext) ? 'image' : 'file';
}

export interface ImageEmbedSize {
  alt: string;
  width?: number;
  height?: number;
}

/**
 * The part after `|` of an image embed: `300`, `300x200`, `alt text`, or
 * `alt text|300` (the size is the last segment when it looks like one).
 */
export function parseImageEmbedAlias(alias: string | null): ImageEmbedSize {
  if (!alias) return { alt: '' };
  const segments = alias.split('|').map((s) => s.trim());
  const last = segments[segments.length - 1];
  const size = /^(\d{1,5})(?:x(\d{1,5}))?$/.exec(last);
  if (!size) return { alt: segments.join(' | ') };
  return {
    alt: segments.slice(0, -1).join(' | '),
    width: Number(size[1]),
    ...(size[2] ? { height: Number(size[2]) } : {}),
  };
}

/** The last segment of a link path (`folder/img.png` -> `img.png`). */
export function baseNameOf(linkPath: string): string {
  return linkPath.slice(linkPath.lastIndexOf('/') + 1);
}

/** The file name of a link path without folders and `.md` — what `[[folder/Note]]` is called when it has no alias. */
export function noteNameOf(linkPath: string): string {
  return baseNameOf(linkPath).replace(/\.md$/i, '');
}

/** What a wikilink shows when it has no alias: `Note`, `Note > Heading`, `Note > ^block`; a same-page `[[#Heading]]` shows just `Heading`. */
export function wikilinkDefaultLabel(path: string, fragment: string | null): string {
  const frag = fragment ? safeDecode(fragment) : null;
  if (!path) return frag ?? '';
  return frag ? `${path} > ${frag}` : path;
}
