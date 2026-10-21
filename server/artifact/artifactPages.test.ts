/**
 * Artifact pages end to end (real fs + real PG + git, routes through Fastify inject):
 *  - the scan makes `x.artifact/` ONE page (nothing inside is a page or a file of the
 *    files index), title from the manifest or the folder, searchable by the entry text;
 *  - publish (create / replace) keeps id, properties and title; properties live in
 *    artifact.yaml; rename / copy / trash / restore move the whole folder;
 *  - /art serves the bundle with the sandbox headers, injects the bridge into the entry
 *    only, refuses traversal and a bad token;
 *  - PageDoc.artifact per reader; the state API and its limits; MCP publish_artifact
 *    and read_page.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ArtifactPublishResult, PageDoc, User } from '../../shared/contracts.js';
import * as authStore from '../auth/store.js';
import * as session from '../auth/session.js';
import { deleteTestSpace, setUpTestSchema } from '../db/testSchema.js';
import { query } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { buildFolioMcpServer, type McpActor } from '../mcp.js';
import { buildPageDoc } from '../pageDoc.js';
import { readPageProperties, savePageProperties } from '../properties.js';
import { registerPropertiesRoutes } from '../propertiesRoutes.js';
import { searchPages } from '../search.js';
import * as storage from '../storage.js';
import { listTrash, restoreTrashItem } from '../trash/service.js';
import { registerArtifactRoutes } from './routes.js';
import { ARTIFACT_CSP, registerArtifactServeRoutes } from './serve.js';
import { signArtifactToken } from './token.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send(err.code ? { error: err.message, code: err.code } : { error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(fastifyMultipart);
  registerArtifactServeRoutes(app);
  await app.register(async (scope) => {
    scope.addHook('onRequest', session.requireSession);
    registerArtifactRoutes(scope);
    registerPropertiesRoutes(scope);
  });
  await app.ready();
  return app;
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), content);
}

async function entryAt(space: string, relPath: string): Promise<storage.PageIndexEntry | undefined> {
  return (await storage.listEntries(space)).find((e) => e.relPath === relPath);
}

describe('artifact pages (real fs + real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let owner: User;
  let reader: User;
  let auth: Record<string, string>;
  let readerAuth: Record<string, string>;
  let space: string;
  let dir: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    owner = await authStore.createUser({ email: `art-owner-${stamp}@test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    reader = await authStore.createUser({ email: `art-reader-${stamp}@test.local`, name: 'Reader', passwordHash: 'x', isAdmin: false });
    space = (await storage.createSpace(`Art ${stamp}`, owner.id)).slug;
    await authStore.setMembership(space, owner.id, 'admin');
    await authStore.setMembership(space, reader.id, 'viewer');
    auth = { cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(owner.id)).token}` };
    readerAuth = { cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(reader.id)).token}` };
    dir = storage.getSpaceDir(space);
    // A hand-made bundle, no manifest; a .md inside must not become a page.
    await write(dir, 'reports/q3-dashboard.artifact/index.html', '<html><head><title>Q3</title><script>var x="zzhidden"</script></head><body><h1>Zebracorn revenue</h1></body></html>');
    await write(dir, 'reports/q3-dashboard.artifact/assets/app.js', 'console.log(1)');
    await write(dir, 'reports/q3-dashboard.artifact/README.md', '# Not a page\n');
    await storage.scanSpace(space);
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await deleteTestSpace(space).catch(() => {});
    await teardownSchema();
  });

  it('the scan makes a bundle folder ONE page and never walks into it', async () => {
    const e = await entryAt(space, 'reports/q3-dashboard.artifact');
    expect(e?.kind).toBe('artifact');
    expect(e?.title).toBe('q3-dashboard');
    expect(e?.id).toMatch(/^artifact-/);
    expect(await entryAt(space, 'reports/q3-dashboard.artifact/README.md')).toBeUndefined();
    expect(await query('SELECT path FROM space_files WHERE space_slug = $1 AND path LIKE $2', [space, '%.artifact/%'])).toEqual([]);
    // Unchanged on a rescan: same id, nothing re-read.
    await storage.scanSpace(space);
    expect((await entryAt(space, 'reports/q3-dashboard.artifact'))?.id).toBe(e?.id);
    // Searchable by the visible text of the entry, not by its scripts.
    const hits = await searchPages('zebracorn', { userId: owner.id, space, isInstanceAdmin: false });
    expect(hits.map((h) => h.id)).toContain(e!.id);
    const hidden = await searchPages('zzhidden', { userId: owner.id, space, isInstanceAdmin: false });
    expect(hidden.map((h) => h.id)).not.toContain(e!.id);
  });

  it('a changed file inside the bundle is noticed by the next scan', async () => {
    await new Promise((r) => setTimeout(r, 15));
    await write(dir, 'reports/q3-dashboard.artifact/artifact.yaml', 'title: Q3 dashboard\nicon: 📊\nstatus: draft\n');
    await storage.scanSpace(space);
    const e = (await entryAt(space, 'reports/q3-dashboard.artifact'))!;
    expect(e.title).toBe('Q3 dashboard');
    expect(e.icon).toBe('📊');
    const props = await readPageProperties(e, true);
    expect(props.properties).toEqual({ status: 'draft' });
  });

  let created: ArtifactPublishResult;
  it('POST /api/spaces/:space/artifacts creates a bundle; 422 for a claude.ai link', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/spaces/${space}/artifacts`,
      headers: auth,
      payload: {
        parentPath: 'apps',
        html: '<!doctype html><html><head><title>Counter</title></head><body><button>Count</button></body></html>',
        files: [{ path: 'data.json', content: '{"n":1}' }],
        sourceCode: 'export default function App() { return <button/> }',
        properties: { owner: 'alice' },
        origin: 'claude',
        sourceUrl: 'https://claude.ai/public/artifacts/abc',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    created = res.json();
    expect(created.page.kind).toBe('artifact');
    expect(created.page.path).toBe('apps/counter.artifact');
    expect(created.page.title).toBe('Counter');
    const manifest = await fs.readFile(path.join(dir, 'apps/counter.artifact/artifact.yaml'), 'utf8');
    expect(manifest).toContain('type: react');
    expect(manifest).toContain('owner: alice');
    expect(await fs.readFile(path.join(dir, 'apps/counter.artifact/source.jsx'), 'utf8')).toContain('export default');

    const refused = await app.inject({ method: 'POST', url: `/api/spaces/${space}/artifacts`, headers: auth, payload: { url: 'https://claude.ai/public/artifacts/abc' } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: 'useMcp' });
    const viewer = await app.inject({ method: 'POST', url: `/api/spaces/${space}/artifacts`, headers: readerAuth, payload: { html: '<p>x</p>' } });
    expect(viewer.statusCode).toBe(403);
  });

  it('multipart upload of an .html file', async () => {
    const boundary = '----folio';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="parentPath"',
      '',
      'uploads',
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="chart.html"',
      'Content-Type: text/html',
      '',
      '<html><body>Chart</body></html>',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const res = await app.inject({ method: 'POST', url: `/api/spaces/${space}/artifacts`, headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().page.path).toBe('uploads/chart.artifact');
  });

  it('PUT /api/pages/:id/artifact replaces the files, keeps id, title and properties', async () => {
    const id = created.page.id;
    const res = await app.inject({ method: 'PUT', url: `/api/pages/${id}/artifact`, headers: auth, payload: { html: '<html><body>Version two</body></html>' } });
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json().page;
    expect(page.id).toBe(id);
    expect(page.title).toBe('Counter');
    const bundle = path.join(dir, 'apps/counter.artifact');
    expect((await fs.readdir(bundle)).sort()).toEqual(['artifact.yaml', 'index.html']);
    expect(await fs.readFile(path.join(bundle, 'artifact.yaml'), 'utf8')).toContain('owner: alice');
    // No temp siblings left behind.
    expect((await fs.readdir(path.join(dir, 'apps'))).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('properties are the manifest\'s own keys (GET/PUT /api/pages/:id/properties)', async () => {
    const id = created.page.id;
    const got = await app.inject({ method: 'GET', url: `/api/pages/${id}/properties`, headers: auth });
    expect(got.json().properties).toEqual({ owner: 'alice' });
    const put = await app.inject({ method: 'PUT', url: `/api/pages/${id}/properties`, headers: auth, payload: { properties: { owner: 'bob', tags: ['kpi'] } } });
    expect(put.statusCode, put.body).toBe(200);
    const text = await fs.readFile(path.join(dir, 'apps/counter.artifact/artifact.yaml'), 'utf8');
    expect(text).toContain('owner: bob');
    expect(text).toContain('title: Counter');
    expect(await query('SELECT tag FROM page_tags WHERE page_id = $1', [id])).toEqual([{ tag: 'kpi' }]);
    const reserved = await app.inject({ method: 'PUT', url: `/api/pages/${id}/properties`, headers: auth, payload: { properties: { title: 'x' } } });
    expect(reserved.statusCode).toBe(400);
    // A bundle without a manifest gets one on its first property.
    await write(dir, 'bare.artifact/index.html', '<p>bare</p>');
    await storage.scanSpace(space);
    const bare = (await entryAt(space, 'bare.artifact'))!;
    await savePageProperties(bare, owner, { properties: { status: 'done' } });
    expect(await fs.readFile(path.join(dir, 'bare.artifact/artifact.yaml'), 'utf8')).toMatch(/folio: artifact[\s\S]*status: done/);
  });

  it('/art serves the bundle with the sandbox headers, the bridge only in the entry', async () => {
    const id = created.page.id;
    await app.inject({ method: 'PUT', url: `/api/pages/${id}/artifact`, headers: auth, payload: { html: '<html><head><title>C</title></head><body>v3</body></html>', files: [{ path: 'js/app.js', content: 'window.x=1' }] } });
    const token = signArtifactToken(id, owner.id);
    const entry = await app.inject({ method: 'GET', url: `/art/${token}/index.html` });
    expect(entry.statusCode).toBe(200);
    expect(entry.headers['content-security-policy']).toBe(ARTIFACT_CSP);
    expect(ARTIFACT_CSP).toMatch(/^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads; default-src 'self' data: blob:;/);
    expect(ARTIFACT_CSP).not.toContain('allow-same-origin');
    expect(entry.headers['x-content-type-options']).toBe('nosniff');
    expect(entry.headers['referrer-policy']).toBe('no-referrer');
    expect(entry.headers['access-control-allow-origin']).toBe('*');
    expect(entry.headers['content-type']).toContain('text/html');
    expect(entry.headers['cache-control']).toBe('private, no-store');
    // The bridge is inline (a sub-request from the sandboxed frame can be blocked), first in <head>; no external script.
    expect(entry.body).toMatch(/<head><script>(window\.__FOLIO_ARTIFACT_PRELOAD__=[^\n]*\n)?[\s\S]*op: 'init'[\s\S]*<\/script><title>C<\/title>/);
    expect(entry.body).not.toMatch(/<script[^>]*\ssrc=/i);

    const js = await app.inject({ method: 'GET', url: `/art/${token}/js/app.js` });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('text/javascript');
    expect(js.headers['cache-control']).toBe('private, max-age=300');
    expect(js.headers['content-security-policy']).toBe(ARTIFACT_CSP);
    expect(js.body).toBe('window.x=1');

    const bridge = await app.inject({ method: 'GET', url: `/art/${token}/__folio/bridge.js` });
    expect(bridge.statusCode).toBe(200);
    expect(bridge.body).toContain('window.__FOLIO_ARTIFACT_PRELOAD__');
    expect(bridge.body).toContain("op: 'init'");

    for (const bad of ['../../../../etc/passwd', '%2e%2e/%2e%2e/x', 'js/../../counter.artifact/index.html', '.hidden']) {
      // 404, or 403 when the client collapsed the dots and the token segment is no longer the token.
      expect([403, 404], bad).toContain((await app.inject({ method: 'GET', url: `/art/${token}/${bad}` })).statusCode);
    }
    expect((await app.inject({ method: 'GET', url: `/art/not-a-token/index.html` })).statusCode).toBe(403);
    // A symlink inside the bundle is never followed.
    await fs.symlink('/etc/hosts', path.join(dir, 'apps/counter.artifact/hosts'));
    expect((await app.inject({ method: 'GET', url: `/art/${token}/hosts` })).statusCode).toBe(404);
    await fs.rm(path.join(dir, 'apps/counter.artifact/hosts'));
  });

  it('PageDoc.artifact is minted per reader', async () => {
    const e = (await storage.requireEntry(created.page.id))!;
    const asUser: PageDoc = await buildPageDoc(e, { kind: 'user', userId: reader.id, isInstanceAdmin: false });
    expect(asUser.artifact?.stateServer).toBe(true);
    expect(asUser.artifact?.src).toMatch(/^\/art\/[^/]+\/index\.html$/);
    expect(asUser.artifact?.files.map((f) => f.path)).toEqual(['index.html', 'js/app.js']);
    const asShare = await buildPageDoc(e, { kind: 'share', pageIds: new Set([e.id]) });
    expect(asShare.artifact?.stateServer).toBe(false);
    expect(asShare.artifact?.src).not.toBe(asUser.artifact?.src);
  });

  it('state: personal and shared, limits enforced', async () => {
    const id = created.page.id;
    const put = (body: unknown, who = readerAuth) => app.inject({ method: 'PUT', url: `/api/pages/${id}/artifact/state`, headers: who, payload: body as object });
    expect((await put({ key: 'ls:count', value: '3' })).statusCode).toBe(200);
    expect((await put({ key: 'board', value: 'x', shared: true })).statusCode).toBe(200);
    const mine = await app.inject({ method: 'GET', url: `/api/pages/${id}/artifact/state`, headers: readerAuth });
    expect(mine.json()).toEqual({ personal: { 'ls:count': '3' }, shared: { board: 'x' } });
    const theirs = await app.inject({ method: 'GET', url: `/api/pages/${id}/artifact/state`, headers: auth });
    expect(theirs.json()).toEqual({ personal: {}, shared: { board: 'x' } });
    expect((await put({ key: 'big', value: 'x'.repeat(256 * 1024 + 1) })).statusCode).toBe(413);
    expect((await put({ key: 'ls:count', value: null })).json().personal).toEqual({});
  });

  it('rename, copy, trash and restore move the whole folder and keep the id', async () => {
    const id = created.page.id;
    const renamed = await storage.renamePageSlug(id, 'clicker');
    expect(renamed.meta.path).toBe('apps/clicker.artifact');
    expect(renamed.meta.id).toBe(id);
    const copy = await storage.copyPage(id, space, 'copies');
    expect(copy.kind).toBe('artifact');
    expect(copy.id).not.toBe(id);
    expect(copy.path).toBe('copies/counter.artifact');
    expect(await fs.readFile(path.join(dir, 'copies/counter.artifact/index.html'), 'utf8')).toContain('v3');
    const moved = await storage.movePage(copy.id, 'moved');
    expect(moved.path).toBe('moved/counter.artifact');
    expect(moved.id).toBe(copy.id);

    await storage.deletePage(id, owner.id);
    expect(await storage.getEntry(id)).toBeUndefined();
    const items = await listTrash(owner, { space });
    const item = items.items.find((i) => i.pageId === id)!;
    expect(item.kind).toBe('artifact');
    await restoreTrashItem(owner, item.id);
    const back = await storage.requireEntry(id);
    expect(back.relPath).toBe('apps/clicker.artifact');
    expect(back.kind).toBe('artifact');
  });

  it('nothing can be created inside a bundle', async () => {
    await expect(storage.createPage({ space, parentPath: 'apps/clicker.artifact', title: 'X', kind: 'doc' })).rejects.toThrow(/inside an artifact/);
  });

  it('MCP publish_artifact creates and replaces; read_page returns the manifest and entry HTML', async () => {
    const actor: McpActor = { user: owner, scopes: ['read', 'write'], tokenId: 'art-test' };
    const server = buildFolioMcpServer(actor);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'art-test', version: '1.0.0' });
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      const pub = await client.callTool({ name: 'publish_artifact', arguments: { space, parentPath: 'mcp', title: 'Kanban', html: '<html><body>Kanban board</body></html>', sourceCode: 'const K = () => null', type: 'react' } });
      expect(pub.isError, JSON.stringify(pub.content)).toBeFalsy();
      const out = pub.structuredContent as { id: string; created: boolean; path: string };
      expect(out.created).toBe(true);
      expect(out.path).toBe('mcp/kanban.artifact');
      const again = await client.callTool({ name: 'publish_artifact', arguments: { space, id: out.id, html: '<html><body>Kanban v2</body></html>' } });
      expect((again.structuredContent as { created: boolean }).created).toBe(false);
      const read = await client.callTool({ name: 'read_page', arguments: { id: out.id } });
      const page = read.structuredContent as { kind: string; title: string; entryHtml: string; artifact: { manifest: { type: string }; files: Array<{ path: string }> } };
      expect(page.kind).toBe('artifact');
      expect(page.title).toBe('Kanban');
      expect(page.entryHtml).toContain('Kanban v2');
      expect(page.artifact.manifest.type).toBe('html');
      const refused = await client.callTool({ name: 'publish_artifact', arguments: { space, url: 'https://claude.ai/chat/xyz' } });
      expect(refused.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
