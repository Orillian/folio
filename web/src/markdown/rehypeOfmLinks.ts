/**
 * Rehype plugin: gives the OFM nodes remarkOfm made (shared/ofm/remark.ts)
 * their final shape in the reading view (Obsidian vault compatibility,
 * wave 2) - what the page's metadata says about each wikilink, and whether a
 * tag chip may be clicked.
 *
 *  - `a.folio-wikilink` -> a link to the page (`data-folio-nav`, which the
 *    click handler of markdown/index.tsx routes in-app, with `#heading` or
 *    `#^block` after it), a link to the file when the target is not a note, a
 *    dashed "unresolved" link (a click offers to create the page), or - when
 *    nothing can resolve it here (a share link, a history preview) or the
 *    index has no row for it yet - its text.
 *  - `div.folio-embed` (an `![[Note]]` standing alone) -> a placeholder the
 *    component fills with the embedded note (`data-folio-embed` = page id), or
 *    the note's name when the embed cannot be loaded.
 *  - `a.folio-tag` -> a span unless clicking a tag does something here.
 *
 * Runs AFTER rehypeFolioPageLinks (that plugin rewrites any `/s/<space>/p/<id>`
 * href into a title link; a wikilink must keep the words the author wrote) and
 * BEFORE rehypeRelativeLinks (which turns a file link into `/files/<space>/...`).
 */
import { visit } from 'unist-util-visit';
import type { Element, Root } from 'hast';
import { noteNameOf } from '@shared/ofm/wikilink';
import { fragmentHash, type WikilinkContext } from './wikilinks';

export interface OfmLinksOptions {
  space: string;
  wikilinks: WikilinkContext;
  /** The in-app URL of one page; the public site passes its own. */
  pageUrl: (pageId: string) => string;
  /** False where an embedded note cannot be fetched (a share link). */
  embeds: boolean;
  /** False where clicking a `#tag` has nowhere to go (a share link, a public site). */
  tagsClickable: boolean;
}

function classes(node: Element): string[] {
  const value = node.properties.className;
  return Array.isArray(value) ? value.map(String) : [];
}

function addClass(node: Element, name: string): void {
  node.properties.className = [...classes(node), name];
}

/** The element as plain text: the words stay, the click goes. */
function asText(node: Element, tagName: 'span' | 'div', extraClass: string): void {
  node.tagName = tagName;
  delete node.properties.href;
  addClass(node, extraClass);
}

export function rehypeOfmLinks({ wikilinks, pageUrl, embeds, tagsClickable }: OfmLinksOptions) {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      const cls = classes(node);

      if (node.tagName === 'a' && cls.includes('folio-tag')) {
        if (!tagsClickable) asText(node, 'span', 'folio-tag--static');
        return;
      }

      const isLink = node.tagName === 'a' && cls.includes('folio-wikilink');
      const isEmbed = node.tagName === 'div' && cls.includes('folio-embed');
      if (!isLink && !isEmbed) return;

      const path = String(node.properties.dataWikilink ?? '');
      const fragment = node.properties.dataWikilinkFragment === undefined ? null : String(node.properties.dataWikilinkFragment);
      const embed = isEmbed || node.properties.dataWikilinkEmbed === 'true';
      const staticTag = isEmbed ? 'div' : 'span';

      if (isLink && path === '') {
        // `[[#Heading]]`: this very page.
        const hash = fragmentHash(fragment);
        if (hash) node.properties.dataWikilinkSelf = hash;
        else asText(node, 'span', 'folio-wikilink--static');
        return;
      }
      if (isEmbed && !embeds) {
        asText(node, staticTag, 'folio-embed--static');
        return;
      }
      if (wikilinks.status === 'unavailable') {
        asText(node, staticTag, isEmbed ? 'folio-embed--static' : 'folio-wikilink--static');
        return;
      }
      if (wikilinks.status === 'pending') {
        node.properties.dataWikilinkState = 'pending';
        if (isEmbed) asText(node, 'div', 'folio-embed--static');
        return;
      }

      const resolution = wikilinks.resolve({ path, fragment, embed });
      if (!resolution) {
        asText(node, staticTag, isEmbed ? 'folio-embed--static' : 'folio-wikilink--static');
        return;
      }
      if (resolution.state === 'page') {
        node.properties.dataWikilinkState = 'page';
        if (isEmbed) {
          node.properties.dataFolioEmbed = resolution.pageId;
          if (fragment !== null) node.properties.dataEmbedFragment = fragment;
          node.properties.dataEmbedLabel = noteNameOf(path);
          return;
        }
        const url = `${pageUrl(resolution.pageId)}${fragmentHash(fragment)}`;
        node.properties.href = url;
        node.properties.dataFolioNav = url;
        return;
      }
      if (resolution.state === 'asset') {
        if (isEmbed) {
          asText(node, 'div', 'folio-embed--static');
          return;
        }
        // A link to a file: rehypeRelativeLinks (next) turns the path into `/files/<space>/...`.
        node.properties.href = path;
        addClass(node, 'folio-wikilink--file');
        return;
      }
      node.properties.dataWikilinkState = 'unresolved';
      addClass(node, isEmbed ? 'folio-embed--unresolved' : 'folio-wikilink--unresolved');
    });
  };
}
