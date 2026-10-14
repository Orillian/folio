/**
 * Rehype plugin: rewrites an `<a href>` that points at another Folio page by
 * its full app URL (see folioLinks.ts's three shapes) into an in-app page
 * link — the page's TITLE (and icon, if it has one), navigating client-side
 * on click, same look as a `[[page]]`-picked relative link.
 *
 * Runs BEFORE rehypeRelativeLinks in pipeline.ts: a Folio URL is absolute
 * (or root-relative) and would otherwise be caught by that plugin's own
 * external-link / already-app-absolute early returns and left untouched —
 * exactly the "naked URL" bug this exists to fix. Once THIS plugin has
 * rewritten a resolved link's href to a root-relative app path,
 * rehypeRelativeLinks' `href.startsWith('/')` branch is a deliberate no-op
 * on it; an UNresolved one is left with its original href and falls through
 * to that plugin's ordinary external-link handling (target=_blank etc.) —
 * which is exactly the "show the URL until the title resolves" fallback.
 *
 * Title resolution is async (folioLinkIndex.ts) and this transform is not,
 * so a first pass over freshly-seen refs can only ever kick the fetch off
 * and leave the anchor as authored; index.tsx re-renders (bumping a
 * "links version" state, via `onFolioLinkSettled`) once it lands, same
 * pattern as `mentionsVersion` for `@handles`.
 */
import { visit } from 'unist-util-visit';
import type { Root, Element, ElementContent } from 'hast';
import { folioLinkNavPath, parseFolioLink, type FolioLinkRef } from './folioLinks';
import type { MarkdownPublicSite } from './publicSite';
import { ensureFolioLinkResolved, folioLinkFailed, resolvedFolioLink, type ResolvedFolioLink } from './folioLinkIndex';

export interface FolioPageLinksOptions {
  /** `window.location.origin` in the browser; undefined in a non-browser context (SSR, most tests) — an absolute URL then simply never matches (see parseFolioLink), only root-relative ones can. */
  origin?: string;
  /**
   * Set only on the public /share/:token route (round 8's shape, same as
   * relativeLinks.ts's own `shareToken`) — an anonymous guest has no
   * session, so both endpoints folioLinkIndex.ts calls would just 401.
   * Skips resolution entirely rather than spending a guaranteed-failing
   * fetch per link; the anchor is simply left as authored, degrading to
   * the plain URL exactly like any other unresolved link.
   */
  shareToken?: string;
  /**
   * Set when rendering a page of a public site (anonymous visitors). Same reason as
   * `shareToken` for skipping the title resolution (both endpoints need a session),
   * but links to the site's OWN pages are rewritten to the site's URL for that page
   * (path or host mode — the caller's `pageUrl`), keeping the authored label; links
   * to other spaces stay as they are (sent to the instance when the site is on
   * another host, where a root-relative `/s/...` would not exist).
   */
  publicSite?: Pick<MarkdownPublicSite, 'space' | 'pageUrl' | 'homeUrl' | 'instanceUrl'>;
  /** Defaults to folioLinkIndex.ts's module cache — injectable so tests can exercise "already resolved" / "known to have failed" without touching that (session-wide, singleton) cache. */
  resolve?: (ref: FolioLinkRef) => ResolvedFolioLink | undefined;
  hasFailed?: (ref: FolioLinkRef) => boolean;
  ensureResolve?: (ref: FolioLinkRef) => void;
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Points an anchor at an in-app URL: the click handler (markdown/index.tsx) navigates client-side on `data-folio-nav`. */
function pointAt(node: Element, url: string): void {
  node.properties.href = url;
  node.properties.dataFolioNav = url;
}

/** Public-site flavour of the rewrite — see FolioPageLinksOptions.publicSite. */
function rewritePublicSiteLink(
  node: Element,
  href: string,
  origin: string | undefined,
  site: NonNullable<FolioPageLinksOptions['publicSite']>,
): void {
  const instanceOrigin = originOf(site.instanceUrl);
  // A link may name the page on this very origin or on the instance's (the site can be served from a subdomain / custom domain).
  const ref = parseFolioLink(href, origin) ?? (instanceOrigin && instanceOrigin !== origin ? parseFolioLink(href, instanceOrigin) : null);
  if (!ref) return;
  if (ref.space === site.space && ref.kind === 'page') {
    pointAt(node, site.pageUrl(ref.id));
    return;
  }
  if (ref.space === site.space && ref.kind === 'space') {
    pointAt(node, site.homeUrl);
    return;
  }
  // Another space (or a folder listing, which has no public URL): the app on the
  // instance decides what an anonymous visitor may see there. On a site served from
  // another host the root-relative route would not exist, so point at the instance.
  if (instanceOrigin && instanceOrigin !== origin) {
    node.properties.href = `${instanceOrigin}${folioLinkNavPath(ref)}`;
    node.properties.target = '_blank';
    node.properties.rel = ['noopener', 'noreferrer'];
  }
}

export function rehypeFolioPageLinks({
  origin,
  shareToken,
  publicSite,
  resolve = resolvedFolioLink,
  hasFailed = folioLinkFailed,
  ensureResolve = ensureFolioLinkResolved,
}: FolioPageLinksOptions) {
  return (tree: Root) => {
    if (shareToken) return;
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'a') return;
      const href = node.properties.href;
      if (typeof href !== 'string' || !href) return;

      if (publicSite) {
        rewritePublicSiteLink(node, href, origin, publicSite);
        return;
      }

      const ref = parseFolioLink(href, origin);
      if (!ref) return;

      const entry = resolve(ref);
      if (entry) {
        node.properties.href = entry.navPath;
        node.properties.dataFolioNav = entry.navPath;
        const children: ElementContent[] = entry.icon
          ? [{ type: 'text', value: `${entry.icon} ${entry.title}` }]
          : [{ type: 'text', value: entry.title }];
        node.children = children;
        return;
      }

      if (!hasFailed(ref)) ensureResolve(ref);
      // Unresolved (pending or given up) — leave the anchor untouched, see
      // this module's own doc comment above.
    });
  };
}
