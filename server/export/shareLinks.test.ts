/**
 * GET /api/share/:token/links — the file links of a shared page, so a guest's reading view and live editor resolve
 * `![[diagram.png]]` found in `attachments/` (real PG schema + real files, fastify inject).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PublicPageLinks } from '../../shared/contracts.js';
import * as authStore from '../auth/store.js';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import { HttpError } from '../errors.js';
import { registerFileRoutes } from '../fileAccess.js';
import { registerPublicShareRoutes } from '../routes.js';
import * as shares from '../shares.js';
import * as storage from '../storage.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  registerPublicShareRoutes(app);
  await registerFileRoutes(app);
  await app.ready();
  return app;
}

describe('share links route (real PG, fastify inject)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let space: string;
  let userId: string;
  let root: storage.PageIndexEntry;
  let other: storage.PageIndexEntry;

  async function makeToken(pageId = root.id): Promise<{ token: string; id: string }> {
    const link = await shares.createShareLink(pageId, userId, 'view', 'http://ignored.test', false);
    return { token: link.url.split('/share/')[1], id: link.id };
  }
  const get = (token: string, pageId?: string) =>
    app.inject({ method: 'GET', url: `/api/share/${token}/links${pageId ? `?page=${encodeURIComponent(pageId)}` : ''}` });

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const user = await authStore.createUser({ email: `share-links-${Date.now()}@test.local`, name: 'Share Links', passwordHash: 'x', isAdmin: false });
    userId = user.id;
    const created = await storage.createSpace(`Share Links ${Date.now()}`, userId);
    space = created.slug;

    // The files exist before the pages are indexed, so the index can resolve the names.
    const dir = path.join(storage.getSpaceDir(space), 'attachments');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'diagram.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.writeFile(path.join(dir, 'unrelated.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // Files put on disk from outside are indexed by a scan (creating a page scans only its own file).
    await storage.scanSpace(space);

    const otherMeta = await storage.createPage({ space, parentPath: '', title: 'Other', kind: 'doc' });
    await storage.writeDocBody(otherMeta.id, '# Other\n\n![[unrelated.png]]\n');
    other = await storage.requireEntry(otherMeta.id);

    const rootMeta = await storage.createPage({ space, parentPath: '', title: 'Shared', kind: 'doc' });
    await storage.writeDocBody(rootMeta.id, '# Shared\n\n![[diagram.png]]\n\nSee [[Other#Heading]] and ![[missing.png]].\n');
    root = await storage.requireEntry(rootMeta.id);
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await deleteTestSpace(space);
    await teardownSchema();
  });

  it('returns the by-name image as an asset with the resolved path, and the file is then readable with the token', async () => {
    const { token, id } = await makeToken();
    const res = await get(token);
    expect(res.statusCode).toBe(200);
    const { links } = res.json() as PublicPageLinks;
    const image = links.find((l) => l.linkPath === 'diagram.png');
    expect(image).toMatchObject({ kind: 'asset', targetPath: 'attachments/diagram.png', targetPageId: null });
    const file = await app.inject({ method: 'GET', url: `/files/${space}/attachments/diagram.png?share=${token}` });
    expect(file.statusCode).toBe(200);
    await shares.revokeShare(id);
  });

  it('drops what is not a readable file: a note link, an unresolved name', async () => {
    const { token, id } = await makeToken();
    const { links } = (await get(token)).json() as PublicPageLinks;
    expect(links.map((l) => l.linkPath)).toEqual(['diagram.png']);
    await shares.revokeShare(id);
  });

  it('does not grant a file only another, unshared page references', async () => {
    const { token, id } = await makeToken();
    const file = await app.inject({ method: 'GET', url: `/files/${space}/attachments/unrelated.png?share=${token}` });
    expect(file.statusCode).toBe(403);
    await shares.revokeShare(id);
  });

  it('404s a page that is not in the share, even though it exists', async () => {
    const { token, id } = await makeToken();
    expect((await get(token, other.id)).statusCode).toBe(404);
    expect((await get(token, 'no-such-page')).statusCode).toBe(404);
    await shares.revokeShare(id);
  });

  it('404s an unknown or revoked token alike', async () => {
    expect((await get('nope-not-a-token')).statusCode).toBe(404);
    const { token, id } = await makeToken();
    await shares.revokeShare(id);
    expect((await get(token)).statusCode).toBe(404);
  });

  it('leaks no page id, fragment, display text or line context', async () => {
    const { token, id } = await makeToken();
    const res = await get(token);
    for (const link of (res.json() as PublicPageLinks).links) {
      expect(link).toMatchObject({ targetPageId: null, fragment: null, fragmentKind: null, fragmentResolved: null, displayText: null, context: '' });
    }
    expect(res.body).not.toContain(other.id);
    expect(res.body).not.toContain(root.id);
    expect(res.body).not.toContain('Heading');
    await shares.revokeShare(id);
  });
});
