/**
 * "Store images in the repository" — the per-space asset mode (store | repo).
 *
 *  - PUT /api/spaces/:space/asset-mode: space admin only, validated, persisted
 *    in `spaces.asset_mode` and reported back through SpaceInfo.
 *  - POST /api/spaces/:space/assets in repo mode: writes `assets/<name>` under the
 *    CONTENT ROOT (so `docs/assets/` for a docs-as-code space with
 *    rootPath=docs) and returns the content-root-relative `path` next to `url`;
 *    store mode keeps returning the content-addressed asset and no `path`.
 *  - the new file is committed by the standard write-back, is not indexed as a
 *    page, and is served from /files/<space>/assets/... for a rootPath space.
 *
 * Real PG + real git + fastify inject, same harness as connectGit.test.ts.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import * as fastifyMultipartModule from '@fastify/multipart';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as authStore from './auth/store.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as session from './auth/session.js';
import * as storage from './storage.js';
import * as git from './git.js';
import { registerFileRoutes } from './fileAccess.js';
import { registerRoutes } from './routes.js';

const execFileAsync = promisify(execFile);

const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function multipartBody(filename: string, mime: string, content: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----folio-asset-mode-test';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(fastifyMultipartModule.default, { limits: { fileSize: 50 * 1024 * 1024 } });
  await registerFileRoutes(app); // does its own session check, like in server/index.ts
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    registerRoutes(protectedScope);
  });
  await app.ready();
  return app;
}

describe('space asset mode (store | repo) — real PG + real git, fastify inject', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let adminCookie: string;
  let editorCookie: string;
  let viewerCookie: string;
  let adminId: string;
  let editorId: string;
  let viewerId: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    const admin = await authStore.createUser({ email: `am-admin-${stamp}@test.local`, name: 'AM Admin', passwordHash: 'x', isAdmin: false });
    const editor = await authStore.createUser({ email: `am-editor-${stamp}@test.local`, name: 'AM Editor', passwordHash: 'x', isAdmin: false });
    const viewer = await authStore.createUser({ email: `am-viewer-${stamp}@test.local`, name: 'AM Viewer', passwordHash: 'x', isAdmin: false });
    adminCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(admin.id)).token}`;
    editorCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(editor.id)).token}`;
    viewerCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(viewer.id)).token}`;
    adminId = admin.id;
    editorId = editor.id;
    viewerId = viewer.id;
    app = await buildApp();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await teardownSchema();
  });

  const createdSpaces: string[] = [];
  afterEach(async () => {
    await Promise.all(createdSpaces.splice(0).map((s) => deleteTestSpace(s).catch(() => {})));
  });

  async function newSpace(name: string): Promise<string> {
    const created = await storage.createSpace(name, adminId);
    await authStore.setMembership(created.slug, adminId, 'admin');
    await authStore.setMembership(created.slug, editorId, 'editor');
    await authStore.setMembership(created.slug, viewerId, 'viewer');
    createdSpaces.push(created.slug);
    return created.slug;
  }

  function setMode(space: string, body: unknown, cookie?: string) {
    return app.inject({
      method: 'PUT',
      url: `/api/spaces/${space}/asset-mode`,
      payload: body as Record<string, unknown>,
      headers: cookie ? { cookie } : {},
    });
  }

  function upload(space: string, filename: string, cookie: string) {
    const { payload, headers } = multipartBody(filename, 'image/png', PNG_BYTES);
    return app.inject({ method: 'POST', url: `/api/spaces/${space}/assets`, payload, headers: { ...headers, cookie } });
  }

  it('defaults to store and is switched by the space admin only (401 / 403 / 400 / 200)', async () => {
    const space = await newSpace(`Mode ${Date.now()}`);
    expect((await storage.getSpaceInfo(space))?.assetMode).toBe('store');

    expect((await setMode(space, { assetMode: 'repo' })).statusCode).toBe(401);
    expect((await setMode(space, { assetMode: 'repo' }, viewerCookie)).statusCode).toBe(403);
    expect((await setMode(space, { assetMode: 'repo' }, editorCookie)).statusCode).toBe(403);
    expect((await setMode(space, { assetMode: 'cloud' }, adminCookie)).statusCode).toBe(400);
    expect((await setMode(space, {}, adminCookie)).statusCode).toBe(400);
    expect((await storage.getSpaceInfo(space))?.assetMode).toBe('store');

    const ok = await setMode(space, { assetMode: 'repo' }, adminCookie);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ slug: space, assetMode: 'repo' });
    expect((await storage.getSpaceInfo(space))?.assetMode).toBe('repo');

    expect((await setMode(space, { assetMode: 'store' }, adminCookie)).statusCode).toBe(200);
    expect((await storage.getSpaceInfo(space))?.assetMode).toBe('store');
  });

  it('answers 404 for an unknown space instead of creating anything', async () => {
    const res = await setMode('no-such-space-asset-mode', { assetMode: 'repo' }, adminCookie);
    expect([403, 404]).toContain(res.statusCode);
    await expect(storage.setSpaceAssetMode('no-such-space-asset-mode', 'repo')).rejects.toMatchObject({ status: 404 });
  });

  it('store mode: the upload is an object-storage URL with no repo path (unchanged behaviour)', async () => {
    const space = await newSpace(`Store ${Date.now()}`);
    const res = await upload(space, 'photo.png', editorCookie);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { url: string; path?: string };
    expect(body.url).toMatch(/^\/a\//);
    expect(body.path).toBeUndefined();
    await expect(fs.access(path.join(storage.getSpaceDir(space), 'assets', 'photo.png'))).rejects.toThrow();
  });

  it('saveAssetIntoRepo returns the content-root-relative path and never overwrites an existing name', async () => {
    const space = await newSpace(`Repo ${Date.now()}`);
    const first = await storage.saveAssetIntoRepo(space, 'My Diagram.png', PNG_BYTES);
    expect(first.path).toBe('assets/My-Diagram.png');
    expect(first.url).toBe(`/files/${space}/assets/My-Diagram.png`);
    const second = await storage.saveAssetIntoRepo(space, 'My Diagram.png', PNG_BYTES);
    expect(second.path).toBe('assets/My-Diagram-2.png');
    expect(await fs.readFile(path.join(storage.getRepoDir(space), first.path))).toEqual(PNG_BYTES);
    expect(await fs.readFile(path.join(storage.getRepoDir(space), second.path))).toEqual(PNG_BYTES);
  });

  it('saveAssetIntoRepo with a rootPath writes under <rootPath>/assets and still returns assets/<name>', async () => {
    const space = await newSpace(`Rooted ${Date.now()}`);
    await storage.setSpaceRootPathCache(space, 'docs');
    try {
      const saved = await storage.saveAssetIntoRepo(space, 'arch.png', PNG_BYTES);
      expect(saved.path).toBe('assets/arch.png');
      expect(saved.url).toBe(`/files/${space}/assets/arch.png`);
      expect(await fs.readFile(path.join(storage.getRepoDir(space), 'docs', 'assets', 'arch.png'))).toEqual(PNG_BYTES);
      await expect(fs.access(path.join(storage.getRepoDir(space), 'assets', 'arch.png'))).rejects.toThrow();
    } finally {
      await storage.setSpaceRootPathCache(space, '');
    }
  });

  it('repo mode via the route: 201 with url + path, committed by the write-back, not indexed, and served under a rootPath', async () => {
    const space = await newSpace(`Route ${Date.now()}`);
    expect((await setMode(space, { assetMode: 'repo' }, adminCookie)).statusCode).toBe(200);
    // Emulate a docs-as-code space whose content root is docs/ (the cache is what spaceDir() reads).
    await storage.setSpaceRootPathCache(space, 'docs');
    try {
      const res = await upload(space, 'flow.png', editorCookie);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ url: `/files/${space}/assets/flow.png`, path: 'assets/flow.png' });

      // The standard write-back stages everything, so the file lands in the repo's next commit.
      const dir = storage.getRepoDir(space);
      await git.commitAll(dir, 'folio:update', { name: 'AM Editor', email: 'am-editor@test.local' });
      const { stdout } = await execFileAsync('git', ['ls-files'], { cwd: dir });
      expect(stdout.split('\n')).toContain('docs/assets/flow.png');

      // scanSpace skips `assets` directories: even a markdown file in there is no page.
      await fs.writeFile(path.join(dir, 'docs', 'assets', 'stray.md'), '# stray\n', 'utf8');
      await storage.scanSpace(space);
      const entries = await storage.listEntries(space);
      expect(entries.some((e) => e.relPath.startsWith('assets/') || e.relPath.includes('/assets/'))).toBe(false);

      // /files serves from the content root, so the Folio URL works for a rootPath space.
      const served = await app.inject({ method: 'GET', url: res.json<{ url: string }>().url, headers: { cookie: viewerCookie } });
      expect(served.statusCode).toBe(200);
      expect(Buffer.from(served.rawPayload)).toEqual(PNG_BYTES);
    } finally {
      await storage.setSpaceRootPathCache(space, '');
    }
  });
});
