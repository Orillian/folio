/**
 * Public sites, SEO (14.10.2026): robots.txt, sitemaps, the per-page <head>
 * (publicSiteMeta.ts → pageMeta.renderIndexHtml), the site stylesheet and
 * assets routes, and the public demo override. Real PG, real files, the real
 * route registrations through fastify inject.
 *
 * Fixture:
 *   acme   public, subdomain "acme" (canonical = https://acme.sites.example.com):
 *          index.md (home), guide.md (front matter title/description/image),
 *          hidden.md (restricted), draft.md (`unlisted: true`),
 *          .folio/site.json + site.css + assets/icon.svg, og.png
 *   plain  public, no host (canonical = the /public/<slug> path form)
 *   closed public, indexing off
 *   priv   private
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PublicSiteInfo, User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as pageAccess from './pageAccess.js';
import { renderIndexHtml } from './pageMeta.js';
import { registerPublicSeoRoutes } from './publicSeo.js';
import { resolvePublicSiteHead } from './publicSiteMeta.js';
import { registerPublicSiteRoutes, updatePublicSettings } from './publicSiteRoutes.js';
import { invalidatePublicSiteCache } from './publicSites.js';
import * as storage from './storage.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>Folio</title>
  </head>
  <body><div id="root"></div></body>
</html>
`;
const ORIGIN = 'https://folio.example.com';
const SITE_HOST = 'acme.sites.example.com';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  registerPublicSiteRoutes(app);
  registerPublicSeoRoutes(app);
  await app.ready();
  return app;
}

describe('public sites — SEO (real PG)', () => {
  const savedEnv = { url: process.env.PUBLIC_URL, sites: process.env.PUBLIC_SITES_DOMAIN, demo: process.env.FOLIO_DEMO_MODE };
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let admin: User;
  let acme: string;
  let plain: string;
  let closed: string;
  let priv: string;
  let guide: storage.PageIndexEntry;
  let hidden: storage.PageIndexEntry;
  let draft: storage.PageIndexEntry;

  async function doc(space: string, title: string, frontMatter = ''): Promise<storage.PageIndexEntry> {
    const meta = await storage.createPage({ space, parentPath: '', title, kind: 'doc' });
    await storage.writeDocBody(meta.id, `# ${title}\n\nThe ${title.toLowerCase()} text about zebrafish.\n`);
    const entry = await storage.requireEntry(meta.id);
    if (frontMatter) {
      const raw = await fs.readFile(entry.absPath, 'utf8');
      await fs.writeFile(entry.absPath, raw.replace(/^---\n/, `---\n${frontMatter}`));
    }
    return entry;
  }
  const get = (url: string, host = 'folio.example.com', headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: { host, ...headers } });
  const head = async (host: string, pathname: string) => {
    const resolved = await resolvePublicSiteHead(host, pathname, `https://${host}`);
    return { status: resolved?.status, html: renderIndexHtml(SHELL, `https://${host}`, pathname, resolved?.site) };
  };

  beforeAll(async () => {
    process.env.PUBLIC_URL = ORIGIN;
    process.env.PUBLIC_SITES_DOMAIN = 'sites.example.com';
    delete process.env.FOLIO_DEMO_MODE;
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    admin = await authStore.createUser({ email: `seo-admin-${stamp}@example.com`, name: 'SEO Admin', passwordHash: 'x', isAdmin: true });
    acme = (await storage.createSpace(`Acme ${stamp}`, admin.id)).slug;
    plain = (await storage.createSpace(`Plain ${stamp}`, admin.id)).slug;
    closed = (await storage.createSpace(`Closed ${stamp}`, admin.id)).slug;
    priv = (await storage.createSpace(`Priv ${stamp}`, admin.id)).slug;
    for (const space of [acme, plain, closed, priv]) await authStore.setMembership(space, admin.id, 'admin');

    guide = await doc(acme, 'Guide', 'title: Guide Title\ndescription: "All about <zebrafish> & friends"\nimage: /a/abc/cover.png\n');
    hidden = await doc(acme, 'Hidden');
    draft = await doc(acme, 'Draft', 'unlisted: true\n');
    await pageAccess.setAccess(admin, hidden, 'restricted', []);

    const folio = path.join(storage.getSpaceDir(acme), '.folio');
    await fs.mkdir(path.join(folio, 'assets'), { recursive: true });
    await fs.writeFile(path.join(folio, 'site.json'), JSON.stringify({ v: 1, title: 'Acme Docs', description: 'The Acme handbook.', lang: 'uk', favicon: 'icon.svg', ogImage: 'og.png' }));
    await fs.writeFile(path.join(folio, 'site.css'), '@import url(https://evil.test/x.css);\n.hero { background: url(assets/og.png) }\n');
    await fs.writeFile(path.join(folio, 'assets', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
    await fs.writeFile(path.join(folio, 'assets', 'og.png'), PNG);

    for (const space of [acme, plain, closed]) await authStore.setSpaceVisibility(space, 'public');
    await updatePublicSettings(admin, acme, { subdomain: 'acme', domain: null, allowDownload: false, allowAssistant: false }, ORIGIN);
    await updatePublicSettings(admin, closed, { subdomain: null, domain: null, allowDownload: false, allowAssistant: false, indexing: false }, ORIGIN);
    invalidatePublicSiteCache();
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    for (const space of [acme, plain, closed, priv]) await deleteTestSpace(space).catch(() => {});
    await teardownSchema();
    for (const [key, value] of [['PUBLIC_URL', savedEnv.url], ['PUBLIC_SITES_DOMAIN', savedEnv.sites], ['FOLIO_DEMO_MODE', savedEnv.demo]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('robots.txt: the main host keeps the app out and lists path-mode sitemaps; a site host lists its own; indexing off disallows', async () => {
    const main = await get('/robots.txt');
    expect(main.statusCode).toBe(200);
    expect(main.headers['content-type']).toMatch(/^text\/plain/);
    for (const line of ['User-agent: *', 'Disallow: /s/', 'Disallow: /share/', 'Disallow: /api/', 'Allow: /public/', 'Allow: /api/public/']) expect(main.body).toContain(line);
    expect(main.body).toContain(`Sitemap: ${ORIGIN}/public/${plain}/sitemap.xml`);
    expect(main.body).not.toContain(`/public/${acme}/sitemap.xml`); // canonical on its subdomain
    expect(main.body).toContain(`Disallow: /public/${closed}$`);
    expect(main.body).toContain(`Disallow: /public/${closed}/`);

    const site = await get('/robots.txt', SITE_HOST);
    expect(site.body).toContain(`Sitemap: https://${SITE_HOST}/sitemap.xml`);
    expect(site.body).not.toMatch(/^Disallow: \/$/m);
  });

  it('sitemaps: public pages only (no restricted, no unlisted), canonical locs with lastmod; indexing off is a 404', async () => {
    const res = await get('/sitemap.xml', SITE_HOST);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/xml/);
    expect(res.body).toContain(`<loc>https://${SITE_HOST}/</loc>`);
    expect(res.body).toContain(`<loc>https://${SITE_HOST}/p/${guide.id}</loc>`);
    expect(res.body).not.toContain(hidden.id);
    expect(res.body).not.toContain(draft.id);
    expect(res.body).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}T[^<]+<\/lastmod>/);

    const pathSitemap = await get(`/public/${plain}/sitemap.xml`);
    expect(pathSitemap.statusCode).toBe(200);
    expect(pathSitemap.body).toContain(`<loc>${ORIGIN}/public/${plain}</loc>`);
    const index = await get('/sitemap.xml');
    expect(index.body).toContain(`<loc>${ORIGIN}/public/${plain}/sitemap.xml</loc>`);
    expect(index.body).not.toContain(acme);
    expect((await get(`/public/${closed}/sitemap.xml`)).statusCode).toBe(404);
    expect((await get(`/public/${priv}/sitemap.xml`)).statusCode).toBe(404);
  });

  it('per-page <head>: title · site title, front matter description and image, canonical, lang, favicon, the site marker', async () => {
    const { status, html } = await head(SITE_HOST, `/p/${guide.id}`);
    expect(status).toBe(200);
    expect(html).toContain('<title>Guide Title · Acme Docs</title>');
    expect(html).toContain('<meta name="description" content="All about &lt;zebrafish&gt; &amp; friends" />');
    expect(html).toContain('<meta property="og:site_name" content="Acme Docs" />');
    expect(html).toContain(`<meta property="og:image" content="https://${SITE_HOST}/a/abc/cover.png" />`);
    expect(html).toContain(`<link rel="canonical" href="https://${SITE_HOST}/p/${guide.id}" />`);
    expect(html).toContain(`<meta property="og:url" content="https://${SITE_HOST}/p/${guide.id}" />`);
    expect(html).toContain('<html lang="uk">');
    expect(html).toMatch(new RegExp(`<link rel="icon" type="image/svg\\+xml" href="/api/public/spaces/${acme}/site-assets/icon.svg\\?v=[0-9a-f]+" />`));
    expect(html).toContain(`<meta name="folio-public-site" content="${acme}" />`);
    expect(html).not.toContain('noindex');

    // The home page: the site title alone, the site description, the site og image, canonical = the root.
    const home = await head(SITE_HOST, '/');
    expect(home.html).toContain('<title>Acme Docs</title>');
    expect(home.html).toContain('<meta name="description" content="The Acme handbook." />');
    expect(home.html).toMatch(new RegExp(`og:image" content="https://${SITE_HOST}/api/public/spaces/${acme}/site-assets/og.png\\?v=`));
    expect(home.html).toContain(`<link rel="canonical" href="https://${SITE_HOST}/" />`);

    // The path form of the same page points at the canonical host.
    const viaPath = await head('folio.example.com', `/public/${acme}/p/${guide.id}`);
    expect(viaPath.html).toContain(`<link rel="canonical" href="https://${SITE_HOST}/p/${guide.id}" />`);
    expect(viaPath.html).not.toContain('folio-public-site');
  });

  it('noindex for an unlisted page and an unindexed site; 404 for an unknown, restricted or private page', async () => {
    expect((await head(SITE_HOST, `/p/${draft.id}`)).html).toContain('<meta name="robots" content="noindex" />');
    const closedHome = await head('folio.example.com', `/public/${closed}`);
    expect(closedHome.status).toBe(200);
    expect(closedHome.html).toContain('<meta name="robots" content="noindex" />');

    for (const pathname of ['/p/doc-000000000000000000000000', `/p/${hidden.id}`]) {
      const missing = await head(SITE_HOST, pathname);
      expect(missing.status, pathname).toBe(404);
      expect(missing.html).not.toContain('rel="canonical"');
    }
    expect((await head('folio.example.com', `/public/${acme}/nope`)).status).toBe(404);
    expect((await resolvePublicSiteHead('folio.example.com', `/public/${priv}`, ORIGIN))?.status).toBe(404);
    expect(await resolvePublicSiteHead('folio.example.com', '/s/whatever', ORIGIN)).toBeUndefined();
  });

  it('site.css and site-assets: sanitized css with ETag/nosniff/304, assets with immutable caching and the SVG sandbox, both 404 unless public', async () => {
    const info = (await get(`/api/public/spaces/${acme}`)).json<PublicSiteInfo>();
    expect(info).toMatchObject({ title: 'Acme Docs', lang: 'uk', canonicalBase: `https://${SITE_HOST}`, indexing: true, logoUrl: null });
    expect(info.faviconUrl).toMatch(new RegExp(`^/api/public/spaces/${acme}/site-assets/icon.svg\\?v=`));
    expect(info.cssUrl).toMatch(new RegExp(`^/api/public/spaces/${acme}/site.css\\?v=[0-9a-f]{12}$`));

    const css = await get(info.cssUrl!);
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.headers['x-content-type-options']).toBe('nosniff');
    expect(css.headers['cache-control']).toBe('public, max-age=300');
    expect(css.body).not.toMatch(/import|evil/);
    expect(css.body).toMatch(new RegExp(`url\\("/api/public/spaces/${acme}/site-assets/og.png\\?v=[0-9a-f]+"\\)`));
    expect((await get(info.cssUrl!, 'folio.example.com', { 'if-none-match': String(css.headers.etag) })).statusCode).toBe(304);

    const icon = await get(info.faviconUrl!);
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['content-type']).toBe('image/svg+xml');
    expect(icon.headers['content-security-policy']).toContain('sandbox');
    expect(icon.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await get(`/api/public/spaces/${acme}/site-assets/og.png`)).headers['cache-control']).toBe('public, max-age=300');
    expect((await get(`/api/public/spaces/${acme}/site-assets/missing.png`)).statusCode).toBe(404);

    await fs.mkdir(path.join(storage.getSpaceDir(priv), '.folio'), { recursive: true });
    await fs.writeFile(path.join(storage.getSpaceDir(priv), '.folio', 'site.css'), 'body{}');
    expect((await get(`/api/public/spaces/${priv}/site.css`)).statusCode).toBe(404);
    expect((await get(`/api/public/spaces/${plain}/site.css`)).statusCode).toBe(404); // public, but no site.css

    // primaryHost 'path' pins the canonical address to the /public form.
    await updatePublicSettings(admin, acme, { subdomain: 'acme', domain: null, allowDownload: false, allowAssistant: false, primaryHost: 'path' }, ORIGIN);
    expect((await get(`/api/public/spaces/${acme}`)).json<PublicSiteInfo>().canonicalBase).toBe(`${ORIGIN}/public/${acme}`);
    await updatePublicSettings(admin, acme, { subdomain: 'acme', domain: null, allowDownload: false, allowAssistant: false, primaryHost: 'auto' }, ORIGIN);
  });

  it('the public demo never lets a site be indexed: noindex, Disallow, no sitemap, indexing false', async () => {
    process.env.FOLIO_DEMO_MODE = '1';
    try {
      expect((await get('/robots.txt', SITE_HOST)).body).toBe('User-agent: *\nDisallow: /\n');
      const main = (await get('/robots.txt')).body;
      expect(main).toMatch(/^Disallow: \/public\/$/m);
      expect(main).not.toContain('Sitemap:');
      expect((await get('/sitemap.xml', SITE_HOST)).statusCode).toBe(404);
      expect((await get('/sitemap.xml')).statusCode).toBe(404);
      expect((await get(`/public/${plain}/sitemap.xml`)).statusCode).toBe(404);
      expect((await get(`/api/public/spaces/${acme}`)).json<PublicSiteInfo>().indexing).toBe(false);
      expect((await head(SITE_HOST, `/p/${guide.id}`)).html).toContain('<meta name="robots" content="noindex" />');
    } finally {
      delete process.env.FOLIO_DEMO_MODE;
    }
  });
});
