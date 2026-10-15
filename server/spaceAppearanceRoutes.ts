/**
 * Space appearance (14.10.2026) — the admin HTTP surface of the `.folio/`
 * folder (server/spaceAppearance.ts). Registered in the protected scope.
 * Every route: admin of the SPACE ITSELF (requireSpaceRole 'admin', like
 * export-settings — these files are repository content, which an instance
 * admin without a membership does not write), cookie session only (a PAT
 * does not change settings), refused for the shared demo login on writes.
 *
 *   GET    /api/spaces/:space/appearance                  → SpaceAppearanceResponse
 *   PUT    /api/spaces/:space/appearance                  body PutAppearanceBody → SpaceAppearanceResponse (409 + current state)
 *   POST   /api/spaces/:space/appearance/assets?name=&replace=1   raw body (the file's Content-Type) or multipart `file` → 201 SiteAssetInfo
 *   DELETE /api/spaces/:space/appearance/assets/:name     → 204
 *
 * The anonymous side (site.css, site-assets, robots, sitemaps, the per-page
 * <head>) lives in publicSiteRoutes.ts / publicSeo.ts / publicSiteMeta.ts.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { putAppearanceBodySchema, SITE_ASSET_MAX_BYTES } from '../shared/contracts.js';
import { recordAudit } from './audit.js';
import * as session from './auth/session.js';
import { assertNotDemoAccount } from './demo.js';
import { badRequest } from './errors.js';
import type { GitIdentity } from './git.js';
import { AppearanceConflictError, deleteAsset, readAppearance, uploadAsset, writeAppearance } from './spaceAppearance.js';
import { parseBody, queryString } from './validate.js';

function actorOf(request: FastifyRequest): GitIdentity {
  return { name: request.authUser!.name, email: request.authUser!.email };
}

async function guard(request: FastifyRequest, write: boolean): Promise<string> {
  const { space } = request.params as { space: string };
  if (write) assertNotDemoAccount(request.authUser!, 'Editing site settings');
  session.requireCookieAuth(request);
  await session.requireSpaceRole(request, space, 'admin');
  if (write) session.requireWriteScope(request);
  return space;
}

/** Raw upload bodies: images and fonts as a Buffer, capped one byte over the asset limit (the store answers 413 itself). */
const RAW_ASSET_TYPES = /^(?:image\/|font\/|application\/(?:x-)?font|application\/octet-stream)/i;

export function registerSpaceAppearanceRoutes(app: FastifyInstance): void {
  app.get('/api/spaces/:space/appearance', async (request) => {
    const space = await guard(request, false);
    return readAppearance(space);
  });

  app.put('/api/spaces/:space/appearance', async (request, reply) => {
    const space = await guard(request, true);
    const body = parseBody(putAppearanceBodySchema, request.body);
    try {
      const state = await writeAppearance(space, actorOf(request), body.changes);
      recordAudit(request.authUser!.id, 'space.appearance', space, { files: body.changes.map((c) => c.file) });
      return state;
    } catch (err) {
      if (err instanceof AppearanceConflictError) return reply.status(409).send({ error: err.message, ...err.current });
      throw err;
    }
  });

  // Encapsulated so the raw image/font body parser applies to the upload route only.
  void app.register(async (scope) => {
    scope.addContentTypeParser(RAW_ASSET_TYPES, { parseAs: 'buffer', bodyLimit: SITE_ASSET_MAX_BYTES + 1 }, (_request, body, done) => done(null, body));

    scope.post('/api/spaces/:space/appearance/assets', async (request, reply) => {
      const space = await guard(request, true);
      const query = request.query as Record<string, unknown>;
      let name = queryString(query, 'name').trim();
      const replace = ['1', 'true', 'yes'].includes(queryString(query, 'replace').toLowerCase());
      let bytes: Buffer;
      if (request.isMultipart()) {
        const file = await request.file({ limits: { fileSize: SITE_ASSET_MAX_BYTES + 1 } });
        if (!file) throw badRequest('no file uploaded (expected multipart field "file")');
        bytes = await file.toBuffer();
        if (file.file.truncated || bytes.length > SITE_ASSET_MAX_BYTES) bytes = Buffer.alloc(SITE_ASSET_MAX_BYTES + 1);
        if (!name) name = file.filename;
      } else if (Buffer.isBuffer(request.body)) {
        bytes = request.body;
      } else {
        throw badRequest('send the file as the request body with its Content-Type, or as multipart field "file"');
      }
      if (!name) throw badRequest('name is required');
      const info = await uploadAsset(space, actorOf(request), name, bytes, replace);
      recordAudit(request.authUser!.id, 'space.appearance', space, { files: [`assets/${name}`], action: replace ? 'replace' : 'add' });
      reply.status(201);
      return info;
    });
  });

  app.delete('/api/spaces/:space/appearance/assets/:name', async (request, reply) => {
    const space = await guard(request, true);
    const { name } = request.params as { name: string };
    await deleteAsset(space, actorOf(request), name);
    recordAudit(request.authUser!.id, 'space.appearance', space, { files: [`assets/${name}`], action: 'remove' });
    return reply.status(204).send();
  });
}
