/**
 * R23 tail (headers and footers) — GET/PUT /api/spaces/:space/export-settings.
 * Since 14.10.2026 a thin wrapper over the `.folio/` store (spaceAppearance.ts):
 * the templates land in `.folio/pdf-header.html` / `.folio/pdf-footer.html` and
 * `<slug>.folio` is never rewritten by a save that has nothing to migrate.
 * Fastify harness per ./routes.test.ts (the admin gate and the 401/403 split
 * are HTTP facts); the file-preservation properties are checked against the
 * raw bytes on disk.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authStore from '../auth/store.js';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import { HttpError } from '../errors.js';
import * as session from '../auth/session.js';
import * as storage from '../storage.js';
import { registerExportRoutes } from './routes.js';
import { buildPrintDocument } from './print.js';
import { MAX_HEADER_FOOTER_BYTES } from './spaceSettings.js';

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
    registerExportRoutes(protectedScope);
  });
  await app.ready();
  return app;
}

describe('R23 tail — space export settings (real PG, fastify inject)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let space: string;
  let folioFile: string;
  let adminCookie: string;
  let editorCookie: string;
  let rootEntry: storage.PageIndexEntry;

  function get(cookie?: string) {
    return app.inject({ method: 'GET', url: `/api/spaces/${space}/export-settings`, headers: cookie ? { cookie } : {} });
  }
  function put(body: unknown, cookie?: string) {
    return app.inject({ method: 'PUT', url: `/api/spaces/${space}/export-settings`, payload: body as Record<string, unknown>, headers: cookie ? { cookie } : {} });
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();

    const admin = await authStore.createUser({ email: `hf-admin-${Date.now()}@test.local`, name: 'HF Admin', passwordHash: 'x', isAdmin: false });
    const editor = await authStore.createUser({ email: `hf-editor-${Date.now()}@test.local`, name: 'HF Editor', passwordHash: 'x', isAdmin: false });

    const created = await storage.createSpace(`Header Footer ${Date.now()}`, admin.id);
    space = created.slug;
    folioFile = path.join(storage.getRepoDir(space), `${space}.folio`);
    await authStore.setMembership(space, admin.id, 'admin');
    await authStore.setMembership(space, editor.id, 'editor');

    adminCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(admin.id)).token}`;
    editorCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(editor.id)).token}`;

    const rootMeta = await storage.createPage({ space, parentPath: '', title: 'Front Page', kind: 'doc' });
    await storage.writeDocBody(rootMeta.id, '# Front Page\n\nBody.\n');
    rootEntry = await storage.requireEntry(rootMeta.id);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await deleteTestSpace(space);
    await teardownSchema();
  });

  it('is gated: 401 without a session, 403 for an editor, 200 for the space admin — GET and PUT alike', async () => {
    expect((await get()).statusCode).toBe(401);
    expect((await get(editorCookie)).statusCode).toBe(403);
    expect((await get(adminCookie)).statusCode).toBe(200);

    expect((await put({ headerHtml: 'x' })).statusCode).toBe(401);
    expect((await put({ headerHtml: 'x' }, editorCookie)).statusCode).toBe(403);
  });

  it('survives a round-trip: PUT stores the raw templates and GET returns them verbatim', async () => {
    const headerHtml = '<span>{{space}} — {{title}}</span>';
    const footerHtml = '<span>{{date}}</span><span>{{page}} / {{pages}}</span>';

    const saved = await put({ headerHtml, footerHtml }, adminCookie);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ headerHtml, footerHtml });

    const read = await get(adminCookie);
    expect(read.json()).toEqual({ headerHtml, footerHtml });
  });

  it('the saved templates actually reach the PDF path (print.ts reads the same file)', async () => {
    await put({ headerHtml: '<b>HDR {{space}}</b>', footerHtml: '<i>FTR {{page}}</i>' }, adminCookie);
    const doc = await buildPrintDocument({ markdown: '# Front Page\n\nBody.\n', entry: rootEntry, baseUrl: 'https://folio.test' });
    expect(doc.headerTemplate).toContain('HDR');
    expect(doc.footerTemplate).toContain('FTR');
    expect(doc.footerTemplate).toContain('pageNumber'); // {{page}} became chromium's own span
  });

  it('writes the templates into .folio/ and leaves `<slug>.folio` (v, name, unknown keys) byte-for-byte as it was', async () => {
    // Plant extra content the way a future Folio (or a human in the repo) might.
    const before = JSON.parse(await fs.readFile(folioFile, 'utf8')) as Record<string, unknown>;
    const planted: Record<string, unknown> = { ...before, custom: { keep: ['me', 1] }, trailing: 'stays' };
    const plantedRaw = `${JSON.stringify(planted, null, 2)}\n`;
    await fs.writeFile(folioFile, plantedRaw, 'utf8');

    await put({ headerHtml: '<span>H</span>' }, adminCookie);

    expect(await fs.readFile(folioFile, 'utf8')).toBe(plantedRaw);
    expect(await fs.readFile(path.join(storage.getSpaceDir(space), '.folio', 'pdf-header.html'), 'utf8')).toBe('<span>H</span>');
    expect((await get(adminCookie)).json()).toEqual({ headerHtml: '<span>H</span>' });
  });

  it('renaming the space keeps the export templates and every other key — only `name` changes', async () => {
    const headerHtml = '<span>Kept {{space}}</span>';
    const footerHtml = '<span>{{page}}</span>';
    await put({ headerHtml, footerHtml }, adminCookie);
    const before = JSON.parse(await fs.readFile(folioFile, 'utf8')) as Record<string, unknown>;

    await storage.renameSpace(space, 'Renamed Header Footer');

    const after = JSON.parse(await fs.readFile(folioFile, 'utf8')) as Record<string, unknown>;
    expect(after).toEqual({ ...before, name: 'Renamed Header Footer' });
    expect((await get(adminCookie)).json()).toEqual({ headerHtml, footerHtml });
  });

  it('a rename leaves a `.folio` that is not JSON untouched (the DB name still changes)', async () => {
    const original = await fs.readFile(folioFile, 'utf8');
    await fs.writeFile(folioFile, 'not json {', 'utf8');
    try {
      const info = await storage.renameSpace(space, 'Renamed Again');
      expect(info.name).toBe('Renamed Again');
      expect(await fs.readFile(folioFile, 'utf8')).toBe('not json {');
    } finally {
      await fs.writeFile(folioFile, original, 'utf8');
    }
  });

  it('blanking both templates removes the export section entirely (and blank-only strings count as blank)', async () => {
    await put({ headerHtml: '<span>H</span>', footerHtml: '<span>F</span>' }, adminCookie);
    await put({ headerHtml: '', footerHtml: '   ' }, adminCookie);

    const raw = JSON.parse(await fs.readFile(folioFile, 'utf8')) as Record<string, unknown>;
    expect('export' in raw).toBe(false);
    expect((await get(adminCookie)).json()).toEqual({});
  });

  it('rejects garbage and oversized bodies per the schema/cap, and a rejected PUT changes nothing on disk', async () => {
    await put({ footerHtml: '<span>keep</span>' }, adminCookie);
    const before = await fs.readFile(folioFile, 'utf8');

    expect((await put({ headerHtml: 42 }, adminCookie)).statusCode).toBe(400);
    expect((await put({ headerHtml: { nested: true } }, adminCookie)).statusCode).toBe(400);
    const oversized = 'x'.repeat(MAX_HEADER_FOOTER_BYTES + 1);
    expect((await put({ headerHtml: oversized }, adminCookie)).statusCode).toBe(400);

    expect(await fs.readFile(folioFile, 'utf8')).toBe(before);
    expect((await get(adminCookie)).json()).toEqual({ footerHtml: '<span>keep</span>' });
  });

  it('never touches a `<slug>.folio` that is not JSON: the save goes to .folio/, the bytes stay', async () => {
    const good = await fs.readFile(folioFile, 'utf8');
    try {
      await fs.writeFile(folioFile, 'this is { not json', 'utf8');
      const res = await put({ headerHtml: '<span>H2</span>' }, adminCookie);
      expect(res.statusCode).toBe(200);
      expect(await fs.readFile(folioFile, 'utf8')).toBe('this is { not json');
      expect((await get(adminCookie)).json()).toEqual({ headerHtml: '<span>H2</span>' });
    } finally {
      await fs.writeFile(folioFile, good, 'utf8');
    }
  });

  it('owner follow-up: a header image pointing at a private/loopback address is rejected end-to-end (400), disk untouched', async () => {
    await put({ footerHtml: '<span>keep-me</span>' }, adminCookie);
    const before = await fs.readFile(folioFile, 'utf8');

    const res = await put({ headerHtml: '<img src="http://127.0.0.1:1/logo.png">' }, adminCookie);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/failed to load header\/footer image/);
    expect(res.json().error).toMatch(/private\/loopback/);

    // The error is never swallowed AND the file is never half-written.
    expect(await fs.readFile(folioFile, 'utf8')).toBe(before);
    expect((await get(adminCookie)).json()).toEqual({ footerHtml: '<span>keep-me</span>' });
  });

  it('an unknown space 404s (requireSpaceRole existence check first)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spaces/definitely-not-a-space/export-settings', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(404);
  });
});
