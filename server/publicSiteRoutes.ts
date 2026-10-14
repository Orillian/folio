/**
 * Public sites (13.10.2026) — the HTTP surface. Two groups:
 *
 *  - `registerPublicSiteRoutes(app)`: ANONYMOUS read routes under /api/public/**,
 *    registered in the public scope (outside the session hook), next to
 *    registerPublicShareRoutes. Every handler answers 404 `space not found`
 *    unless the space's visibility is 'public', never reads `request.authUser`
 *    and only ever serves pages in the public set (publicSites.ts: no
 *    restricted page, no `.agent/**`, no `_templates/`). Unlike a share link,
 *    a public site is meant to be indexed, so no `X-Robots-Tag: noindex`.
 *  - `registerPublicSiteAdminRoutes(app)`: GET/PUT /api/spaces/:space/public-settings
 *    in the protected scope — a space admin or instance admin, cookie session only.
 *
 * Files (/files/<space>/...), the collab socket and the HTML shell have their
 * own public-site branches in fileAccess.ts, collab.ts and index.ts; they all
 * ask publicSites.ts what is public.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  updateSpacePublicSettingsBodySchema,
  type PublicPagePayload,
  type PublicSiteInfo,
  type SearchHit,
  type SpacePublicSettings,
  type SpacePublicSettingsResponse,
  type TreeNode,
  type User,
} from '../shared/contracts.js';
import { recordAudit } from './audit.js';
import * as session from './auth/session.js';
import { assertNotDemoAccount } from './demo.js';
import { forbidden, notFound } from './errors.js';
import { registerPublicSiteExportRoutes } from './export/routes.js';
import { buildPageDoc } from './pageDoc.js';
import {
  buildPublicSiteInfo,
  getPublicSpace,
  getSpacePublicSettings,
  isPublicPage,
  mainHost,
  publicReadablePageIds,
  publicSiteUrls,
  resolvePublicSiteByHost,
  setSpacePublicSettings,
  sitesDomain,
  type PublicSpace,
} from './publicSites.js';
import { searchPublicSpace } from './search.js';
import * as storage from './storage.js';
import { parseBody, queryString } from './validate.js';

/** Longest search query a public visitor can send; longer input is cut, not rejected. */
const MAX_PUBLIC_QUERY_LENGTH = 200;

function requestOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.hostname}`;
}

/** The published space named by `:slug`, or 404 `space not found` (private, instance-wide and unknown spaces are indistinguishable). */
async function requirePublicSpace(request: FastifyRequest): Promise<PublicSpace> {
  const { slug } = request.params as { slug: string };
  const site = await getPublicSpace(slug);
  if (!site) throw notFound('space');
  return site;
}

export function registerPublicSiteRoutes(app: FastifyInstance): void {
  // The site served at this request's Host (subdomain / custom domain) — what the SPA asks first when the HTML shell carries the folio-public-site marker.
  app.get('/api/public/site', async (request): Promise<PublicSiteInfo> => {
    const site = await resolvePublicSiteByHost(request.hostname);
    if (!site) throw notFound('a public site');
    return buildPublicSiteInfo(site, 'host', requestOrigin(request));
  });

  app.get('/api/public/spaces/:slug', async (request): Promise<PublicSiteInfo> => {
    const site = await requirePublicSpace(request);
    return buildPublicSiteInfo(site, 'path', requestOrigin(request));
  });

  app.get('/api/public/spaces/:slug/tree', async (request): Promise<{ tree: TreeNode[] }> => {
    const site = await requirePublicSpace(request);
    return { tree: await storage.getTree(site.slug, await publicReadablePageIds(site.slug)) };
  });

  app.get('/api/public/spaces/:slug/pages/:id', async (request): Promise<PublicPagePayload> => {
    const site = await requirePublicSpace(request);
    const { id } = request.params as { id: string };
    // A synthetic folder node ('dir:...') is not a page; storage.getEntry would 400 on it.
    const entry = id.startsWith('dir:') ? undefined : await storage.getEntry(id);
    // Same 404 for "no such page", "page of another space" and "not public" - nothing to probe.
    if (!entry || entry.space !== site.slug || !(await isPublicPage(entry))) throw notFound('page');
    return { page: await buildPageDoc(entry), spaceName: site.name };
  });

  // Relative .md links inside a page: space-relative path -> page id.
  app.get('/api/public/spaces/:slug/resolve', async (request): Promise<{ id: string }> => {
    const site = await requirePublicSpace(request);
    const resolved = await storage.resolve(site.slug, queryString(request.query, 'path'));
    if (!(await isPublicPage({ id: resolved.id, space: site.slug, relPath: resolved.path }))) throw notFound('page');
    return { id: resolved.id };
  });

  app.get('/api/public/spaces/:slug/search', async (request): Promise<{ hits: SearchHit[] }> => {
    const site = await requirePublicSpace(request);
    const q = queryString(request.query, 'q').trim().slice(0, MAX_PUBLIC_QUERY_LENGTH);
    return { hits: q ? await searchPublicSpace(q, site.slug) : [] };
  });

  // .../pages/:id/export.(md|pdf|docx) - opt-in per space, throttled per IP.
  registerPublicSiteExportRoutes(app);
}

// ---------------------------------------------------------------------------
// Admin: GET/PUT /api/spaces/:space/public-settings
// ---------------------------------------------------------------------------

async function requireSettingsAdmin(actor: User, space: string): Promise<void> {
  if (!(await storage.spaceExists(space))) throw notFound('space');
  if (!(await session.canAdministerSpace(actor, space))) throw forbidden('requires instance admin, or admin role in this space');
}

async function settingsResponse(space: string, originFallback: string): Promise<SpacePublicSettingsResponse> {
  const state = await getSpacePublicSettings(space);
  if (!state) throw notFound('space');
  return {
    visibility: state.visibility,
    settings: state.settings,
    urls: publicSiteUrls(space, state.settings, originFallback),
    sitesDomain: sitesDomain(),
    mainHost: mainHost(originFallback),
  };
}

export async function getPublicSettings(actor: User, space: string, originFallback: string): Promise<SpacePublicSettingsResponse> {
  await requireSettingsAdmin(actor, space);
  return settingsResponse(space, originFallback);
}

export async function updatePublicSettings(actor: User, space: string, settings: SpacePublicSettings, originFallback: string): Promise<SpacePublicSettingsResponse> {
  await requireSettingsAdmin(actor, space);
  await setSpacePublicSettings(space, settings, originFallback);
  recordAudit(actor.id, 'space.public_settings', space, {
    subdomain: settings.subdomain,
    domain: settings.domain,
    allowDownload: settings.allowDownload,
    allowAssistant: settings.allowAssistant,
  });
  return settingsResponse(space, originFallback);
}

/** Cookie session only (a PAT never administers access - same rule as every route in access/routes.ts). */
export function registerPublicSiteAdminRoutes(app: FastifyInstance): void {
  app.get('/api/spaces/:space/public-settings', async (request) => {
    session.requireCookieAuth(request);
    const { space } = request.params as { space: string };
    return getPublicSettings(request.authUser!, space, requestOrigin(request));
  });

  app.put('/api/spaces/:space/public-settings', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Publishing a space');
    session.requireCookieAuth(request);
    session.requireWriteScope(request);
    const { space } = request.params as { space: string };
    const body = parseBody(updateSpacePublicSettingsBodySchema, request.body);
    return updatePublicSettings(request.authUser!, space, body, requestOrigin(request));
  });
}
