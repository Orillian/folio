/**
 * Obsidian Bases (server/bases/**), real PG + real files: a `.base` file is
 * indexed as a page; its view lists only pages the reader may open (restricted,
 * `.agent/`, `_templates/` left out); `canEdit` follows page access; the SQL
 * prefilter never drops a row the evaluator keeps; a cell edit is a properties
 * PUT (etag / 409 / roles); the visual editor's write keeps comments and
 * unknown keys (etag / 409 / roles / invalid YAML); a broken file answers a
 * readable error; ```base previews see `this`; POST /api/pages creates one;
 * MCP query_base and read_page.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '../../shared/contracts.js';
import type { BaseQueryResponse, BaseSourceResponse } from '../../shared/bases/types.js';
import { parseBaseConfig } from '../../shared/bases/parse.js';
import * as authStore from '../auth/store.js';
import * as session from '../auth/session.js';
import { query } from '../db/pool.js';
import { deleteTestSpace, setUpTestSchema } from '../db/testSchema.js';
import { HttpError } from '../errors.js';
import { buildFolioMcpServer, type McpActor } from '../mcp.js';
import * as pageAccess from '../pageAccess.js';
import { registerRoutes } from '../routes.js';
import { registerPropertiesRoutes } from '../propertiesRoutes.js';
import * as storage from '../storage.js';
import { userViewer } from '../accessSql.js';
import { registerBaseRoutes } from './routes.js';
import { prefilterSql } from './sql.js';
import { queryBase } from './query.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(async (scope) => {
    scope.addHook('onRequest', session.requireSession);
    registerRoutes(scope);
    registerPropertiesRoutes(scope);
    registerBaseRoutes(scope);
  });
  await app.ready();
  return app;
}

const PROJECTS_BASE = `# Projects of the team
filters:
  and:
    - file.inFolder("projects")
    - '!file.hasTag("archived")'
formulas:
  late: 'if(due < date("2026-10-16") && status != "done", "late", "")'
properties:
  status:
    displayName: Status
views:
  # grouped by status
  - type: table
    name: By status
    order: [file.name, status, owner, due, formula.late]
    groupBy:
      property: status
      direction: ASC
    summaries:
      owner: Unique
  - type: cards
    name: Gallery
    order: [file.name, owner]
`;

describe('bases: a view over the pages the reader may open (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let owner: User;
  let editor: User;
  let viewer: User;
  let granted: User;
  const spaces: string[] = [];
  let slug: string;
  const ids: Record<string, string> = {};
  const auth: Record<string, Record<string, string>> = {};

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    app = await buildApp();
    const stamp = Date.now();
    const mk = (name: string) => authStore.createUser({ email: `bases-${name}-${stamp}@example.com`, name, passwordHash: 'x', isAdmin: false });
    owner = await mk('owner');
    editor = await mk('editor');
    viewer = await mk('viewer');
    granted = await mk('granted');
    slug = (await storage.createSpace(`Bases ${stamp}`, owner.id)).slug;
    spaces.push(slug);
    await authStore.setMembership(slug, owner.id, 'admin');
    await authStore.setMembership(slug, editor.id, 'editor');
    await authStore.setMembership(slug, viewer.id, 'viewer');
    await authStore.setMembership(slug, granted.id, 'editor');
    const dir = storage.getSpaceDir(slug);
    const put = async (rel: string, text: string) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), text);
    };
    await put('projects/alpha.md', '---\nstatus: doing\nowner: ann\ndue: 2026-10-01\ntags: [work]\n---\n# Alpha\n\nSee [[beta]].\n');
    await put('projects/beta.md', '---\nstatus: todo\nowner: bob\ndue: 2026-11-01\n---\n# Beta\n');
    await put('projects/gamma.md', '---\nstatus: done\nowner: ann\n---\n# Gamma\n');
    await put('projects/old.md', '---\nstatus: done\ntags: [archived]\n---\n# Old\n');
    await put('projects/secret.md', '---\nstatus: todo\nowner: eve\n---\n# Secret\n');
    await put('projects/nostatus.md', '# No status\n');
    await put('notes/other.md', '---\nstatus: todo\n---\n# Other\n');
    await put('.agent/rules.md', '---\nstatus: todo\n---\n# Rules\n');
    await put('_templates/projects/tpl.md', '---\nstatus: todo\n---\n# Template\n');
    await put('ops/index.md', '---\ntitle: Operations hub\n---\n# Operations hub\n');
    await put('ops/runbooks/restart.md', '# Restart\n');
    await put('Projects.base', PROJECTS_BASE);
    await put('Broken.base', 'views:\n  - type: table\n   name: x\n');
    await storage.scanSpace(slug);
    for (const rel of ['projects/alpha.md', 'projects/beta.md', 'projects/gamma.md', 'projects/secret.md', 'projects/nostatus.md', 'Projects.base', 'Broken.base']) {
      const found = await storage.getEntryIdByExactPath(slug, rel);
      if (!found) throw new Error(`no page ${rel}`);
      ids[rel] = found;
    }
    // secret: restricted to the owner, an EDIT grant for `granted`.
    await pageAccess.setAccess(owner, (await storage.getEntry(ids['projects/secret.md']))!, 'restricted', [{ userId: granted.id, role: 'editor' }]);
    for (const [name, user] of Object.entries({ owner, editor, viewer, granted })) {
      auth[name] = { cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` };
    }
  });
  afterAll(async () => {
    await app.close();
    for (const s of spaces) await deleteTestSpace(s);
    await teardownSchema();
  });

  const get = async <T = BaseQueryResponse>(url: string, who: string) => {
    const res = await app.inject({ method: 'GET', url, headers: auth[who] });
    return { status: res.statusCode, body: res.json() as T };
  };
  const send = async <T = BaseSourceResponse>(method: 'PUT' | 'POST', url: string, who: string, payload: unknown) => {
    const res = await app.inject({ method, url, headers: auth[who], payload: payload as Record<string, unknown> });
    return { status: res.statusCode, body: res.json() as T };
  };
  const paths = (r: BaseQueryResponse) => r.rows.map((x) => x.path).sort();

  it('indexes a .base file as a page named by its stem', async () => {
    const entry = (await storage.getEntry(ids['Projects.base']))!;
    expect(entry.kind).toBe('base');
    expect(entry.title).toBe('Projects');
    const doc = await get<{ kind: string; markdown?: string }>(`/api/pages/${ids['Projects.base']}`, 'viewer');
    expect(doc.body.kind).toBe('base');
  });

  it('lists only readable pages; groups, formulas and summaries; restricted / .agent / templates never appear', async () => {
    const asEditor = await get(`/api/pages/${ids['Projects.base']}/base`, 'editor');
    expect(asEditor.status).toBe(200);
    expect(paths(asEditor.body)).toEqual(['projects/alpha.md', 'projects/beta.md', 'projects/gamma.md', 'projects/nostatus.md']);
    expect(JSON.stringify(asEditor.body)).not.toContain('eve');
    expect(asEditor.body.view).toBe('By status');
    expect(asEditor.body.groups!.map((g) => g.key)).toEqual([{ t: 'text', v: 'doing' }, { t: 'text', v: 'done' }, { t: 'text', v: 'todo' }, null]);
    expect(asEditor.body.columns.find((c) => c.id === 'status')!.label).toBe('Status');
    expect(asEditor.body.columns.find((c) => c.id === 'owner')!.summary).toEqual({ name: 'Unique', value: { t: 'number', v: 2 } });
    const alpha = asEditor.body.rows.find((r) => r.path === 'projects/alpha.md')!;
    expect(alpha.cells.due).toEqual({ t: 'date', v: '2026-10-01' });
    expect(alpha.cells['formula.late']).toEqual({ t: 'text', v: 'late' });

    const asGranted = await get(`/api/pages/${ids['Projects.base']}/base`, 'granted');
    expect(paths(asGranted.body)).toContain('projects/secret.md');
    const asOwner = await get(`/api/pages/${ids['Projects.base']}/base?view=Gallery`, 'owner');
    expect(asOwner.body.layout).toBe('cards');
    expect(paths(asOwner.body)).toContain('projects/secret.md');
  });

  it('canEdit follows the page role: editors yes, viewers no, a restricted page only with an edit grant', async () => {
    const canEdit = (r: BaseQueryResponse) => Object.fromEntries(r.rows.map((x) => [x.path, x.canEdit]));
    expect(Object.values(canEdit((await get(`/api/pages/${ids['Projects.base']}/base`, 'viewer')).body)).every((v) => v === false)).toBe(true);
    expect(canEdit((await get(`/api/pages/${ids['Projects.base']}/base`, 'editor')).body)['projects/alpha.md']).toBe(true);
    const g = canEdit((await get(`/api/pages/${ids['Projects.base']}/base`, 'granted')).body);
    expect(g['projects/secret.md']).toBe(true);
    expect(g['projects/alpha.md']).toBe(true);
  });

  it('the SQL prefilter keeps every row the evaluator keeps', async () => {
    const statements = [
      'file.inFolder("projects")',
      'file.hasTag("work")',
      '!file.hasTag("archived")',
      'status == "todo"',
      'status != "done"',
      'owner.contains("an")',
      'file.ext == "md"',
      'file.folder == "projects"',
      'file.name == "alpha.md"',
      'file.hasProperty("due")',
      'due < date("2026-10-15")',
      'status == "todo" || file.hasTag("work")',
      '!(status == "todo")',
    ];
    for (const st of statements) {
      const config = parseBaseConfig(`filters:\n  and:\n    - '${st.replace(/'/g, "''")}'\n`).config!;
      const viaEngine = await queryBase({ space: slug, config, viewer: userViewer(owner), spaceEditor: true, tokenMayWrite: true, thisPageId: null });
      const params: unknown[] = [slug];
      const sql = prefilterSql([config.filters], params);
      const sqlRows = await query<{ path: string }>(`SELECT p.path FROM pages_index p WHERE p.space_slug = $1 AND p.kind <> 'folder' AND ${sql}`, params);
      const kept = new Set(sqlRows.map((r) => r.path));
      for (const row of viaEngine.rows) expect(kept.has(row.path), `${st}: ${row.path}`).toBe(true);
    }
    // Exact ones are exact: the tag / folder / extension statements match the same set in SQL and in the engine.
    for (const st of ['file.hasTag("work")', '!file.hasTag("archived")', 'file.inFolder("projects")', 'file.folder == "projects"']) {
      const config = parseBaseConfig(`filters: '${st}'\n`).config!;
      const viaEngine = await queryBase({ space: slug, config, viewer: userViewer(owner), spaceEditor: true, tokenMayWrite: true, thisPageId: null });
      const params: unknown[] = [slug];
      const sqlRows = await query<{ path: string }>(
        `SELECT p.path FROM pages_index p WHERE p.space_slug = $1 AND p.kind <> 'folder' AND NOT (p.path LIKE '\\_templates/%') AND ${prefilterSql([config.filters], params)}`,
        params,
      );
      expect(sqlRows.map((r) => r.path).sort(), st).toEqual(viaEngine.rows.map((r) => r.path).sort());
    }
  });

  it('editing a cell is a properties PUT: the base shows the new value; a stale etag is a 409; a viewer is refused', async () => {
    const id = ids['projects/beta.md'];
    const props = await get<{ properties: Record<string, unknown>; etag: string; canEdit: boolean; foreign: string[] }>(`/api/pages/${id}/properties`, 'editor');
    expect(props.body.canEdit).toBe(true);
    // `status: todo` on a document is a foreign value of Folio's own `status` key: read-only (the UI says so).
    expect(props.body.foreign).toContain('status');
    const next = { ...props.body.properties, owner: 'carol' };
    expect((await send('PUT', `/api/pages/${id}/properties`, 'viewer', { properties: next, etag: props.body.etag })).status).toBe(403);
    const put = await send<{ error?: string }>('PUT', `/api/pages/${id}/properties`, 'editor', { properties: next, etag: props.body.etag });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect((await send('PUT', `/api/pages/${id}/properties`, 'editor', { properties: { ...next, owner: 'dan' }, etag: props.body.etag })).status).toBe(409);
    const after = await get(`/api/pages/${ids['Projects.base']}/base`, 'editor');
    expect(after.body.rows.find((r) => r.id === id)!.cells.owner).toEqual({ t: 'text', v: 'carol' });
    const raw = await fs.readFile(path.join(storage.getSpaceDir(slug), 'projects/beta.md'), 'utf8');
    expect(raw).toContain('owner: carol');
    expect(raw).toContain('status: todo');
    expect(raw).toContain('# Beta');
  });

  it('the visual editor writes back keeping comments; etag, roles and validity are checked', async () => {
    const id = ids['Projects.base'];
    const src = await get<BaseSourceResponse>(`/api/pages/${id}/base/source`, 'editor');
    expect(src.body.canEdit).toBe(true);
    expect((await get<BaseSourceResponse>(`/api/pages/${id}/base/source`, 'viewer')).body.canEdit).toBe(false);
    const config = src.body.config!;
    config.views[1] = { ...config.views[1], sort: [{ property: 'owner', direction: 'DESC' }] };
    expect((await send('PUT', `/api/pages/${id}/base`, 'viewer', { etag: src.body.etag, config })).status).toBe(403);
    const ok = await send('PUT', `/api/pages/${id}/base`, 'editor', { etag: src.body.etag, config });
    expect(ok.status).toBe(200);
    const text = await fs.readFile(path.join(storage.getSpaceDir(slug), 'Projects.base'), 'utf8');
    expect(text).toContain('# Projects of the team');
    expect(text).toContain('  # grouped by status\n  - type: table\n    name: By status\n    order: [file.name, status, owner, due, formula.late]');
    expect(text).toContain('direction: DESC');
    expect(ok.body.etag).not.toBe(src.body.etag);
    expect((await send('PUT', `/api/pages/${id}/base`, 'editor', { etag: src.body.etag, config })).status).toBe(409);
    expect((await send('PUT', `/api/pages/${id}/base`, 'editor', { etag: ok.body.etag, source: 'views: [unclosed' })).status).toBe(400);
    const raw = await send('PUT', `/api/pages/${id}/base`, 'editor', { etag: ok.body.etag, source: PROJECTS_BASE });
    expect(raw.status).toBe(200);
    expect(raw.body.source).toBe(PROJECTS_BASE);
  });

  it('a broken file answers a readable error; the file is never rewritten by viewing', async () => {
    const before = await fs.readFile(path.join(storage.getSpaceDir(slug), 'Broken.base'), 'utf8');
    const r = await get(`/api/pages/${ids['Broken.base']}/base`, 'viewer');
    expect(r.status).toBe(200);
    expect(r.body.error?.message).toMatch(/not valid YAML/);
    expect(r.body.error?.line).toBe(3);
    expect(await fs.readFile(path.join(storage.getSpaceDir(slug), 'Broken.base'), 'utf8')).toBe(before);
  });

  it('a ```base block preview sees `this` = the embedding page', async () => {
    const source = 'filters: file.hasLink(this.file)\nviews:\n  - type: list\n    name: Links here\n';
    const r = await send<BaseQueryResponse>('POST', `/api/spaces/${slug}/base/preview`, 'viewer', { source, pageId: ids['projects/beta.md'] });
    expect(r.status).toBe(200);
    expect(r.body.layout).toBe('list');
    expect(r.body.rows.map((x) => x.path)).toEqual(['projects/alpha.md']);
    const other = await send<BaseQueryResponse>('POST', `/api/spaces/${slug}/base/preview`, 'viewer', { source, pageId: ids['projects/secret.md'] });
    expect(other.status).toBe(403);
  });

  it('file.folder shows the folder page title in the web answer; the path stays for agents and in filters', async () => {
    const source = 'filters: file.inFolder("ops")\nviews:\n  - type: table\n    name: T\n    order:\n      - file.name\n      - file.folder\n';
    const r = await send<BaseQueryResponse>('POST', `/api/spaces/${slug}/base/preview`, 'viewer', { source, pageId: ids['projects/beta.md'] });
    expect(r.status).toBe(200);
    const folder = (p: string) => r.body.rows.find((x) => x.path === p)!.cells['file.folder'];
    expect(folder('ops/index.md')).toEqual({ t: 'text', v: 'Operations hub' });
    expect(folder('ops/runbooks/restart.md')).toEqual({ t: 'text', v: 'Operations hub / runbooks' }); // no page for runbooks: its slug
    // The same query without the display option (agents, MCP): the path.
    const config = parseBaseConfig(source).config!;
    const plain = await queryBase({ space: slug, config, viewer: userViewer(viewer), spaceEditor: false, tokenMayWrite: false, thisPageId: null });
    expect(plain.rows.find((x) => x.path === 'ops/runbooks/restart.md')!.cells['file.folder']).toEqual({ t: 'text', v: 'ops/runbooks' });
  });

  it('POST /api/pages creates a base (starter or given YAML), named by its title', async () => {
    const created = await send<{ id: string; path: string; kind: string; title: string }>('POST', '/api/pages', 'editor', { space: slug, parentPath: 'projects', title: 'Мої задачі', kind: 'base' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'base', path: 'projects/Мої задачі.base', title: 'Мої задачі' });
    const text = await fs.readFile(path.join(storage.getSpaceDir(slug), created.body.path), 'utf8');
    expect(parseBaseConfig(text).config!.filters).toEqual({ and: ['file.inFolder("projects")'] });
    // The starter view: name, folder, tags, last updated — newest first.
    expect(parseBaseConfig(text).config!.views[0]).toMatchObject({ type: 'table', order: ['file.name', 'file.folder', 'file.tags', 'file.mtime'], sort: [{ property: 'file.mtime', direction: 'DESC' }] });
    const given = await send<{ id: string; path: string }>('POST', '/api/pages', 'editor', { space: slug, parentPath: '', title: 'From search', kind: 'base', base: 'filters: file.hasTag("work")\n' });
    expect(given.status).toBe(201);
    expect(await fs.readFile(path.join(storage.getSpaceDir(slug), given.body.path), 'utf8')).toBe('filters: file.hasTag("work")\n');
    expect((await send('POST', '/api/pages', 'editor', { space: slug, parentPath: '', title: 'Bad', kind: 'base', base: 'views: [' })).status).toBe(400);
    expect((await send('POST', '/api/pages', 'viewer', { space: slug, parentPath: '', title: 'Nope', kind: 'base' })).status).toBe(403);
  });

  it('MCP query_base and read_page: the agent\'s own ACL, compact values', async () => {
    const call = async (actor: McpActor, name: string, args: Record<string, unknown>) => {
      const server = buildFolioMcpServer(actor);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test', version: '1.0.0' });
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      try {
        return await client.callTool({ name, arguments: args });
      } finally {
        await client.close();
      }
    };
    const actor: McpActor = { user: viewer, scopes: ['read'], tokenId: 'bases-viewer' };
    const r = await call(actor, 'query_base', { id: ids['Projects.base'] });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { rows: Array<{ path: string; values: Record<string, unknown> }>; groups: unknown[] };
    expect(sc.rows.map((x) => x.path).filter((p) => p.endsWith('.md')).sort()).toEqual(['projects/alpha.md', 'projects/beta.md', 'projects/gamma.md', 'projects/nostatus.md']);
    expect(sc.rows.find((x) => x.path === 'projects/alpha.md')!.values.due).toBe('2026-10-01');
    expect(JSON.stringify(r)).not.toContain('eve');
    expect((await call(actor, 'query_base', { id: ids['projects/alpha.md'] })).isError).toBe(true);
    const read = await call(actor, 'read_page', { id: ids['Projects.base'] });
    expect(JSON.stringify(read.structuredContent)).toContain('query_base');
  });
});
