/**
 * What the markdown renderer needs to know when it draws a page of a PUBLIC SITE
 * (a published space, read by anonymous visitors — see shared/contracts.ts "Public
 * sites"). Plain functions and strings only, on purpose: markdown/ must not import
 * from app/ (see index.tsx's comment on the app/ <-> markdown/ edge), so the app
 * side (app/public/publicSite.ts) builds this and the single URL helper that
 * keeps path mode (`/public/<slug>/p/<id>`) and host mode (`/p/<id>`) from
 * diverging stays over there.
 *
 * Images and uploaded files need nothing here: without a share token they already
 * resolve to `/files/<space>/<path>`, which the server serves for a public space
 * without a session.
 */
export interface MarkdownPublicSite {
  /** The published space's slug. */
  space: string;
  /** The in-app URL of one page of this site. */
  pageUrl: (pageId: string) => string;
  /** The in-app URL of the site's home. */
  homeUrl: string;
  /** A relative `.md` link (path from the space root, already resolved against the page) to a page id — GET /api/public/spaces/:slug/resolve. Rejects when there is no such page. */
  resolvePath: (path: string) => Promise<string>;
  /** The instance's own absolute URL (PUBLIC_URL). Links written as `<instance>/s/<slug>/p/<id>` match through it even when the site is reached on another host, and links to other spaces are sent there. */
  instanceUrl?: string;
}
