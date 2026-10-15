/**
 * Space appearance (14.10.2026): the `.folio/` store behind
 * GET/PUT /api/spaces/:space/appearance and its assets. Real PG, real git
 * repositories, the real route registration (fastify inject) for the HTTP
 * facts (gate, 409 body, 400), direct calls for the migration's git details.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import * as fastifyMultipartModule from '@fastify/multipart';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SITE_ASSET_MAX_BYTES, type SpaceAppearanceResponse } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { buildPrintDocument } from './export/print.js';
import * as git from './git.js';
import { deleteAsset, readAppearance, uploadAsset, writeAppearance } from './spaceAppearance.js';
import { registerSpaceAppearanceRoutes } from './spaceAppearanceRoutes.js';
import * as storage from './storage.js';

const execFileAsync = promisify(execFile);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const ACTOR = { name: 'Site Admin', email: 'site-admin@test.local' };

async function gitOut(repo: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd: repo })).stdout.trim();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    return reply.status(status && status >= 400 && status < 500 ? status : 500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(fastifyMultipartModule.default);
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    registerSpaceAppearanceRoutes(protectedScope);
  });
  await app.ready();
  return app;
}

describe('space appearance — the .folio/ store (real PG + git)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let space: string;
  let repo: string;
  let adminCookie: string;
  let editorCookie: string;
  const created: string[] = [];

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    const admin = await authStore.createUser({ email: `ap-admin-${stamp}@test.local`, name: 'AP Admin', passwordHash: 'x', isAdmin: false });
    const editor = await authStore.createUser({ email: `ap-editor-${stamp}@test.local`, name: 'AP Editor', passwordHash: 'x', isAdmin: false });
    space = (await storage.createSpace(`Appearance ${stamp}`, admin.id)).slug;
    created.push(space);
    repo = storage.getRepoDir(space);
    await authStore.setMembership(space, admin.id, 'admin');
    await authStore.setMembership(space, editor.id, 'editor');
    adminCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(admin.id)).token}`;
    editorCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(editor.id)).token}`;
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    for (const slug of created) await deleteTestSpace(slug).catch(() => {});
    await teardownSchema();
  });

  const fileOf = (state: SpaceAppearanceResponse, file: string) => state.files.find((f) => f.file === file)!;

  it('GET/PUT are space-admin only; a save writes the file, commits only it, and a stale etag is a 409 carrying the current state', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/spaces/${space}/appearance` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/spaces/${space}/appearance`, headers: { cookie: editorCookie } })).statusCode).toBe(403);
    const initial = (await app.inject({ method: 'GET', url: `/api/spaces/${space}/appearance`, headers: { cookie: adminCookie } })).json<SpaceAppearanceResponse>();
    expect(fileOf(initial, 'site.css')).toMatchObject({ exists: false, etag: null, source: 'none', path: '.folio/site.css' });
    expect(initial.isPublic).toBe(false);

    // Someone's unsaved page edit sits in the working tree: the settings commit must not take it.
    const root = await storage.createPage({ space, parentPath: '', title: 'Home', kind: 'doc' });
    await git.commitAll(repo, 'seed', ACTOR);
    await storage.writeDocBody(root.id, '# Home\n\nUnsaved edit.\n');

    const put = (changes: unknown[]) =>
      app.inject({ method: 'PUT', url: `/api/spaces/${space}/appearance`, headers: { cookie: adminCookie }, payload: { changes } });
    const saved = await put([{ file: 'site.css', content: 'body { color: red }\n', etag: null }]);
    expect(saved.statusCode).toBe(200);
    const css = fileOf(saved.json<SpaceAppearanceResponse>(), 'site.css');
    expect(css).toMatchObject({ exists: true, source: 'folio', content: 'body { color: red }\n' });
    expect(await gitOut(repo, ['log', '-1', '--format=%s|%an'])).toBe('settings: update .folio/site.css|AP Admin');
    expect(await gitOut(repo, ['show', '--name-only', '--format=', 'HEAD'])).toBe('.folio/site.css');
    expect(await gitOut(repo, ['status', '--porcelain'])).toBe('M home.md');

    // The file changes in git behind the editor's back: the old etag is refused with the current state.
    await fs.writeFile(path.join(repo, '.folio', 'site.css'), 'body { color: blue }\n');
    const stale = await put([{ file: 'site.css', content: 'body { color: green }\n', etag: css.etag }]);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('appearance file changed in the repository');
    expect(fileOf(stale.json<SpaceAppearanceResponse>(), 'site.css').content).toBe('body { color: blue }\n');
    expect(await fs.readFile(path.join(repo, '.folio', 'site.css'), 'utf8')).toBe('body { color: blue }\n');
  });

  it('site.json must be valid JSON satisfying the schema (400); a valid one keeps unknown keys; an empty content deletes', async () => {
    const put = (content: string, etag: string | null) =>
      app.inject({ method: 'PUT', url: `/api/spaces/${space}/appearance`, headers: { cookie: adminCookie }, payload: { changes: [{ file: 'site.json', content, etag }] } });
    expect((await put('{ not json', null)).statusCode).toBe(400);
    const bad = await put(JSON.stringify({ title: 'x'.repeat(81), lang: 'english!' }), null);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/title/);
    expect(await fs.stat(path.join(repo, '.folio', 'site.json')).catch(() => null)).toBeNull();

    const json = `${JSON.stringify({ v: 1, title: 'Acme Docs', lang: 'uk', custom: { keep: true } }, null, 2)}\n`;
    const ok = await put(json, null);
    expect(ok.statusCode).toBe(200);
    const stored = fileOf(ok.json<SpaceAppearanceResponse>(), 'site.json');
    expect(stored.content).toBe(json);
    expect(JSON.parse(await fs.readFile(path.join(repo, '.folio', 'site.json'), 'utf8')).custom).toEqual({ keep: true });

    const removed = await put('', stored.etag);
    expect(removed.statusCode).toBe(200);
    expect(fileOf(removed.json<SpaceAppearanceResponse>(), 'site.json').exists).toBe(false);
    expect(await gitOut(repo, ['show', '--name-status', '--format=', 'HEAD'])).toBe('D\t.folio/site.json');
  });

  it('the first PDF save migrates legacy settings: one commit of only .folio paths + <slug>.folio + the old css; unknown keys stay; images become assets', async () => {
    const slug = (await storage.createSpace(`Legacy ${Date.now()}`, null)).slug;
    created.push(slug);
    const dir = storage.getRepoDir(slug);
    const meta = path.join(dir, `${slug}.folio`);
    const base = JSON.parse(await fs.readFile(meta, 'utf8')) as Record<string, unknown>;
    const logo = `<img src="data:image/png;base64,${PNG.toString('base64')}"> {{space}}`;
    await fs.writeFile(meta, `${JSON.stringify({ ...base, custom: ['kept'], export: { headerHtml: logo, footerHtml: '<span>{{page}}</span>' } }, null, 2)}\n`);
    await fs.writeFile(path.join(dir, `${slug}.export.css`), 'h1 { color: navy }\n');
    await fs.writeFile(path.join(dir, 'unrelated.md'), '# Unrelated\n');
    await git.commitAll(dir, 'legacy', ACTOR);
    await fs.writeFile(path.join(dir, 'unrelated.md'), '# Unrelated, edited\n');

    const before = await readAppearance(slug);
    expect(before.legacyPending).toBe(true);
    expect(fileOf(before, 'pdf-header.html')).toMatchObject({ source: 'legacy', exists: false, etag: null, content: logo });
    expect(fileOf(before, 'export.css')).toMatchObject({ source: 'legacy', content: 'h1 { color: navy }\n' });
    const headBefore = await gitOut(dir, ['rev-parse', 'HEAD']);

    const after = await writeAppearance(slug, ACTOR, [{ file: 'pdf-footer.html', content: '<span>{{page}} / {{pages}}</span>', etag: null }]);
    expect(after.legacyPending).toBe(false);
    expect(after.files.filter((f) => f.file !== 'site.json' && f.file !== 'site.css').every((f) => f.source === 'folio')).toBe(true);
    expect(fileOf(after, 'pdf-header.html').content).toBe('<img src="pdf-image-1.png"> {{space}}');
    expect(after.assets).toEqual([{ name: 'pdf-image-1.png', size: PNG.length, url: null }]);

    expect(await gitOut(dir, ['rev-list', '--count', `${headBefore}..HEAD`])).toBe('1');
    // --no-renames: the old css moving into .folio/export.css would otherwise show as one renamed path.
    const touched = (await gitOut(dir, ['show', '--name-only', '--no-renames', '--format=', 'HEAD'])).split('\n').sort();
    expect(touched).toEqual(
      ['.folio/assets/pdf-image-1.png', '.folio/export.css', '.folio/pdf-footer.html', '.folio/pdf-header.html', `${slug}.export.css`, `${slug}.folio`].sort(),
    );
    expect(await gitOut(dir, ['log', '-1', '--format=%s'])).toBe('settings: update .folio/pdf-footer.html (PDF settings moved into .folio/)');
    expect(await gitOut(dir, ['status', '--porcelain'])).toBe('M unrelated.md');
    const metaAfter = JSON.parse(await fs.readFile(meta, 'utf8')) as Record<string, unknown>;
    expect(metaAfter).toEqual({ ...base, custom: ['kept'] });
    expect(await fs.stat(path.join(dir, `${slug}.export.css`)).catch(() => null)).toBeNull();

    // The PDF renderer reads .folio/ and inlines the asset from disk.
    const home = await storage.createPage({ space: slug, parentPath: '', title: 'Home', kind: 'doc' });
    const doc = await buildPrintDocument({ markdown: '# Home\n', entry: await storage.requireEntry(home.id), baseUrl: 'https://folio.test' });
    expect(doc.headerTemplate).toContain('src="data:image/png;base64,');
    expect(doc.footerTemplate).toContain('totalPages');
    expect(doc.html).toContain('h1 { color: navy }');
  });

  it('assets: name rules, caps, the bytes must match the extension, 409 unless replace; raw body and delete commit their own path', async () => {
    await expect(uploadAsset(space, ACTOR, '../x.png', PNG, false)).rejects.toMatchObject({ status: 400 });
    await expect(uploadAsset(space, ACTOR, 'tool.exe', PNG, false)).rejects.toMatchObject({ status: 400 });
    await expect(uploadAsset(space, ACTOR, 'fake.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), false)).rejects.toMatchObject({ status: 400 });
    await expect(uploadAsset(space, ACTOR, 'huge.png', Buffer.concat([PNG, Buffer.alloc(SITE_ASSET_MAX_BYTES)]), false)).rejects.toMatchObject({ status: 413 });

    const raw = await app.inject({
      method: 'POST',
      url: `/api/spaces/${space}/appearance/assets?name=logo.png`,
      headers: { cookie: adminCookie, 'content-type': 'image/png' },
      payload: PNG,
    });
    expect(raw.statusCode).toBe(201);
    expect(raw.json()).toMatchObject({ name: 'logo.png', size: PNG.length, url: null });
    expect(await gitOut(repo, ['log', '-1', '--format=%s'])).toBe('settings: add .folio/assets/logo.png');
    const again = await app.inject({
      method: 'POST',
      url: `/api/spaces/${space}/appearance/assets?name=logo.png`,
      headers: { cookie: adminCookie, 'content-type': 'image/png' },
      payload: PNG,
    });
    expect(again.statusCode).toBe(409);
    await expect(uploadAsset(space, ACTOR, 'logo.png', PNG, true)).resolves.toMatchObject({ name: 'logo.png' });

    await deleteAsset(space, ACTOR, 'logo.png');
    expect(await fs.stat(path.join(repo, '.folio', 'assets', 'logo.png')).catch(() => null)).toBeNull();
    expect(await gitOut(repo, ['log', '-1', '--format=%s'])).toBe('settings: remove .folio/assets/logo.png');
    await expect(deleteAsset(space, ACTOR, 'logo.png')).rejects.toMatchObject({ status: 404 });
  });

  it('never follows a symlinked .folio file', async () => {
    const slug = (await storage.createSpace(`Symlink ${Date.now()}`, null)).slug;
    created.push(slug);
    const dir = storage.getRepoDir(slug);
    await fs.mkdir(path.join(dir, '.folio'), { recursive: true });
    await fs.writeFile(path.join(dir, 'secret.txt'), 'top secret');
    await fs.symlink(path.join(dir, 'secret.txt'), path.join(dir, '.folio', 'site.css'));
    const state = await readAppearance(slug);
    expect(fileOf(state, 'site.css')).toMatchObject({ exists: false, content: '' });
  });
});
