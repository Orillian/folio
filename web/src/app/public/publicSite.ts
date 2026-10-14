/**
 * Public sites (published spaces) — the client-side URL model. A published space is
 * read by anonymous visitors in one of two ways, served by the same SPA:
 *
 *   path mode  `/public/<slug>`, `/public/<slug>/p/<id>`  — on the instance's own host
 *   host mode  `/`, `/p/<id>`                             — on a subdomain / custom domain,
 *                                                            where index.html carries
 *                                                            `<meta name="folio-public-site" content="<slug>">`
 *
 * Every link the site draws — tree rows, search hits, breadcrumbs, links inside markdown —
 * goes through `publicPageUrl` / `publicHomeUrl`, so the two modes cannot diverge.
 * Pure functions, no React and no network: the routing, the views and the markdown adapter
 * all import from here.
 */
import { PUBLIC_SITE_PATH_PREFIX, type PublicSiteInfo } from '@shared/contracts';

/** The part of PublicSiteInfo that decides where links point. */
export type PublicSiteRef = Pick<PublicSiteInfo, 'space' | 'mode'>;

/** Name of the meta tag the server writes into index.html when the SPA is served on a site's own host. */
export const PUBLIC_SITE_META_NAME = 'folio-public-site';

/** The slug of the site served on this host, from the boot meta tag; null on the instance's main host. */
export function readHostSiteSlug(doc: Document = document): string | null {
  const content = doc.querySelector(`meta[name="${PUBLIC_SITE_META_NAME}"]`)?.getAttribute('content')?.trim();
  return content ? content : null;
}

/** The URL prefix every page of the site lives under: `/public/<slug>` in path mode, nothing in host mode. */
export function publicBasePath(site: PublicSiteRef): string {
  return site.mode === 'host' ? '' : `${PUBLIC_SITE_PATH_PREFIX}/${encodeURIComponent(site.space)}`;
}

/** The site's home. */
export function publicHomeUrl(site: PublicSiteRef): string {
  return publicBasePath(site) || '/';
}

/** One page of the site. */
export function publicPageUrl(site: PublicSiteRef, pageId: string): string {
  return `${publicBasePath(site)}/p/${encodeURIComponent(pageId)}`;
}

/** `/files/<space>/<path>` — an uploaded file or a pdf/office page's bytes; the server serves it to anonymous visitors of a public space. */
export function publicFileUrl(space: string, path: string): string {
  return `/files/${encodeURIComponent(space)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The same page inside the app, for the footer's "Sign in" link. `signin=1` tells the app not to bounce an
 * anonymous visitor straight back to the public site (auth/AuthProvider.tsx) — without it a public space
 * could never reach its own login screen through this link.
 */
export function appPageUrl(site: Pick<PublicSiteInfo, 'space' | 'instanceUrl'>, pageId?: string | null): string {
  const base = site.instanceUrl.replace(/\/+$/, '');
  const page = pageId ? `/p/${encodeURIComponent(pageId)}` : '';
  return `${base}/s/${encodeURIComponent(site.space)}${page}?signin=1`;
}

/** Query-key prefix of everything the public site caches, so one invalidation can drop the lot. */
export const PUBLIC_SITE_QUERY_KEY = 'public-site';

/** Cache key of a site's info; shared by the route loader and the anonymous-visitor probe in AuthProvider. */
export function publicSiteInfoKey(mode: PublicSiteInfo['mode'], slug: string): readonly string[] {
  return [PUBLIC_SITE_QUERY_KEY, 'info', mode, slug];
}

/** Where an anonymous visitor of an internal app URL should land instead, when the space is public: `/s/<slug>[/p/<id>]` → the site's page or home. Null for any other path. */
export function publicUrlForAppPath(pathname: string): { space: string; pageId: string | null } | null {
  const match = /^\/s\/([^/]+)(?:\/p\/([^/]+))?(?:\/.*)?$/.exec(pathname);
  if (!match) return null;
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return { space: decode(match[1]), pageId: match[2] ? decode(match[2]) : null };
}
