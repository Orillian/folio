/**
 * PATCH /api/spaces/:space/scan-settings (Obsidian vault compatibility, wave 1a):
 * space admin only, validated, persisted in `spaces.scan_ignore` / `light_footprint`,
 * a changed ignore list rescans before the answer, and the list is shown to space
 * admins only in GET /api/spaces. Real PG + real git + fastify inject, same
 * harness as assetMode.test.ts.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as authStore from './auth/store.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as session from './auth/session.js';
import * as storage from './storage.js';
import { registerRoutes } from './routes.js';
import type { SpaceInfo } from '../shared/contracts.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    registerRoutes(protectedScope);
  });
  await app.ready();
  return app;
}

describe('scan settings route (real PG + git, fastify inject)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let adminCookie: string;
  let editorCookie: string;
  let adminId: string;
  let editorId: string;
  const createdSpaces: string[] = [];

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    const admin = await authStore.createUser({ email: `ss-admin-${stamp}@test.local`, name: 'SS Admin', passwordHash: 'x', isAdmin: false });
    const editor = await authStore.createUser({ email: `ss-editor-${stamp}@test.local`, name: 'SS Editor', passwordHash: 'x', isAdmin: false });
    adminCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(admin.id)).token}`;
    editorCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(editor.id)).token}`;
    adminId = admin.id;
    editorId = editor.id;
    app = await buildApp();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await teardownSchema();
  });
  afterEach(async () => {
    await Promise.all(createdSpaces.splice(0).map((s) => deleteTestSpace(s).catch(() => {})));
  });

  async function newSpace(name: string): Promise<string> {
    const created = await storage.createSpace(name, adminId);
    await authStore.setMembership(created.slug, adminId, 'admin');
    await authStore.setMembership(created.slug, editorId, 'editor');
    createdSpaces.push(created.slug);
    return created.slug;
  }
  const patch = (space: string, body: unknown, cookie?: string) =>
    app.inject({ method: 'PATCH', url: `/api/spaces/${space}/scan-settings`, payload: body as Record<string, unknown>, headers: cookie ? { cookie } : {} });
  async function paths(space: string): Promise<string[]> {
    return (await storage.listEntries(space)).map((e) => e.relPath).sort();
  }

  it('is for the space admin only, validates the list, rescans, and persists the flag', async () => {
    const space = await newSpace(`Scan route ${Date.now()}`);
    const dir = storage.getSpaceDir(space);
    await fs.mkdir(path.join(dir, 'Templates'), { recursive: true });
    await fs.writeFile(path.join(dir, 'Templates', 't.md'), '# T\n', 'utf8');
    await fs.writeFile(path.join(dir, 'keep.md'), '# Keep\n', 'utf8');
    await storage.scanSpace(space);
    expect(await paths(space)).toEqual(['Templates/t.md', 'index.md', 'keep.md']);

    expect((await patch(space, { scanIgnore: ['Templates/'] })).statusCode).toBe(401);
    expect((await patch(space, { scanIgnore: ['Templates/'] }, editorCookie)).statusCode).toBe(403);
    for (const bad of [{}, { scanIgnore: ['../x'] }, { scanIgnore: ['a/b'] }, { scanIgnore: ['*'] }, { scanIgnore: 'Templates' }, { lightFootprint: 'yes' }]) {
      expect((await patch(space, bad, adminCookie)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await paths(space)).toEqual(['Templates/t.md', 'index.md', 'keep.md']);

    const ok = await patch(space, { scanIgnore: ['./Templates/', 'Templates/'] }, adminCookie);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ slug: space, pageCount: 2, scanIgnore: ['Templates/'], lightFootprint: false });
    expect(await paths(space)).toEqual(['index.md', 'keep.md']); // already rescanned
    await expect(fs.access(path.join(dir, 'Templates', 't.md'))).resolves.toBeUndefined(); // the files are untouched

    const light = await patch(space, { lightFootprint: true }, adminCookie);
    expect(light.json()).toMatchObject({ scanIgnore: ['Templates/'], lightFootprint: true });
    expect(storage.isLightFootprintSpace(space)).toBe(true);

    expect((await patch('no-such-space-scan', { scanIgnore: [] }, adminCookie)).statusCode).toBeGreaterThanOrEqual(403);
  });

  it('GET /api/spaces shows the ignore list to space admins only', async () => {
    const space = await newSpace(`Scan list ${Date.now()}`);
    await patch(space, { scanIgnore: ['drafts/'], lightFootprint: true }, adminCookie);
    const asAdmin = (await app.inject({ method: 'GET', url: '/api/spaces', headers: { cookie: adminCookie } })).json<{ spaces: SpaceInfo[] }>().spaces.find((s) => s.slug === space);
    const asEditor = (await app.inject({ method: 'GET', url: '/api/spaces', headers: { cookie: editorCookie } })).json<{ spaces: SpaceInfo[] }>().spaces.find((s) => s.slug === space);
    expect(asAdmin?.scanIgnore).toEqual(['drafts/']);
    expect(asAdmin?.lightFootprint).toBe(true);
    expect(asEditor).toBeDefined();
    expect(asEditor?.scanIgnore).toBeUndefined();
    expect(asEditor?.lightFootprint).toBe(true);
  });
});
