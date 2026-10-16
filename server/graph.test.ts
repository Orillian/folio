/**
 * Graph view (server/graph.ts), real PG + real files: the space graph and the
 * local graph through REST and MCP, filtered in SQL to what the caller may
 * open — owner / editor / viewer / a viewer with a grant / an outsider,
 * a restricted page (no node, no edge, no ghost, no tag of its own), `.agent`
 * (admins only), `_templates/` (never), unresolved links, tags, files;
 * depth and direction of the local graph; and a performance smoke on a
 * generated space of 5k pages and 20k links.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GraphResponse, User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { buildFolioMcpServer, type McpActor } from './mcp.js';
import * as pageAccess from './pageAccess.js';
import { registerRoutes } from './routes.js';
import * as storage from './storage.js';
import { clampDepth, parseDirection, parseGraphOptions } from './graph.js';

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
  });
  await app.ready();
  return app;
}

describe('graph options parsing', () => {
  it('flags, depth and direction fall back to their defaults', () => {
    expect(parseGraphOptions({})).toEqual({ tags: false, files: false, unresolved: false, orphans: true, tree: false });
    expect(parseGraphOptions({ tags: '1', files: 'true', unresolved: 'on', orphans: '0', tree: '1' })).toEqual({ tags: true, files: true, unresolved: true, orphans: false, tree: true });
    expect(parseGraphOptions({ tags: 'maybe', orphans: false })).toEqual({ tags: false, files: false, unresolved: false, orphans: false, tree: false });
    expect([clampDepth(undefined), clampDepth('0'), clampDepth('2'), clampDepth(9), clampDepth('x')]).toEqual([1, 1, 2, 3, 1]);
    expect([parseDirection('in'), parseDirection('out'), parseDirection('sideways'), parseDirection(undefined)]).toEqual(['in', 'out', 'both', 'both']);
  });
});

describe('graph view: ACL-filtered space and local graphs (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let owner: User;
  let editor: User;
  let viewer: User;
  let granted: User;
  let outsider: User;
  const spaces: string[] = [];
  let slug: string;
  const ids: Record<string, string> = {};
  const auth: Record<string, Record<string, string>> = {};

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    app = await buildApp();
    const stamp = Date.now();
    const mk = (name: string) => authStore.createUser({ email: `graph-${name}-${stamp}@example.com`, name, passwordHash: 'x', isAdmin: false });
    owner = await mk('owner');
    editor = await mk('editor');
    viewer = await mk('viewer');
    granted = await mk('granted');
    outsider = await mk('outsider');

    slug = (await storage.createSpace(`Graph ACL ${stamp}`, owner.id)).slug;
    spaces.push(slug);
    await authStore.setMembership(slug, owner.id, 'admin');
    await authStore.setMembership(slug, editor.id, 'editor');
    await authStore.setMembership(slug, viewer.id, 'viewer');
    await authStore.setMembership(slug, granted.id, 'viewer');
    const dir = storage.getSpaceDir(slug);
    const put = async (rel: string, text: string | Buffer) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), text);
    };
    await put('hub.md', '# Hub\n\nSee [[a]], [b](b.md), [[restricted]] and [[Ghost]]. ![pic](assets/pic.png) #team\n');
    await put('a.md', '# A\n\n[[b]] and again [[b|bee]]. #team/x\n');
    await put('b.md', '# B\n\nBack to [[hub]].\n');
    await put('c.md', '# C\n\nPoints at [[a]].\n');
    await put('restricted.md', '# Restricted\n\nAlso [[a]] and [[Secret ghost]]. ![s](assets/secret.png) #secret\n');
    await put('lonely.md', '# Lonely\n');
    await put('.agent/rules.md', '# Rules\n\nRead [[hub]].\n');
    await put('_templates/tpl.md', '# Template\n\n[[hub]] [[Template ghost]] #tpl\n');
    await put('assets/pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await put('assets/secret.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await storage.scanSpace(slug);
    for (const rel of ['hub.md', 'a.md', 'b.md', 'c.md', 'restricted.md', 'lonely.md', '.agent/rules.md', '_templates/tpl.md']) {
      const found = await storage.getEntryIdByExactPath(slug, rel);
      if (!found) throw new Error(`no page ${rel}`);
      ids[rel] = found;
    }
    await pageAccess.setAccess(owner, (await storage.getEntry(ids['restricted.md']))!, 'restricted', [{ userId: granted.id, role: 'viewer' }]);
    for (const [name, user] of Object.entries({ owner, editor, viewer, granted, outsider })) {
      auth[name] = { cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` };
    }
  });
  afterAll(async () => {
    await app.close();
    for (const s of spaces) await deleteTestSpace(s);
    await teardownSchema();
  });

  const get = async (url: string, who: string) => {
    const res = await app.inject({ method: 'GET', url, headers: auth[who] });
    return { status: res.statusCode, body: res.json() as GraphResponse, raw: res.body };
  };
  /** Node ids mapped back to paths (page ids) or kept (tag:/file:/ghost:). */
  const pathOf = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
  const nodePaths = (g: GraphResponse) => g.nodes.map((n) => (n.kind === 'tag' || n.kind === 'file' || n.kind === 'unresolved' ? n.id : n.path!)).sort();
  const edgeList = (g: GraphResponse) => g.edges.map((e) => `${pathOf(e.source)}>${pathOf(e.target)}x${e.count}`).sort();
  const contentPaths = (paths: string[]) => paths.filter((p) => p !== 'index.md' && p !== 'README.md');

  it('editor and viewer: readable pages only; the restricted page, .agent and templates are not nodes, and links to them are not drawn', async () => {
    for (const who of ['editor', 'viewer']) {
      const { status, body, raw } = await get(`/api/spaces/${slug}/graph`, who);
      expect(status, who).toBe(200);
      expect(contentPaths(nodePaths(body))).toEqual(['a.md', 'b.md', 'c.md', 'hub.md', 'lonely.md']);
      expect(edgeList(body)).toEqual(['a.md>b.mdx2', 'b.md>hub.mdx1', 'c.md>a.mdx1', 'hub.md>a.mdx1', 'hub.md>b.mdx1']);
      expect(body.truncated).toBe(false);
      expect(body.totalPages).toBe(body.nodes.length);
      const hub = body.nodes.find((n) => n.path === 'hub.md')!;
      expect(hub).toMatchObject({ title: 'Hub', kind: 'doc', tags: ['team'], degree: 2 });
      expect(hub.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      // Nothing about the closed page leaks: not its id, title, tag, ghost or file.
      for (const secret of [ids['restricted.md'], 'Restricted', 'restricted.md', 'Secret ghost', 'secret', ids['.agent/rules.md'], 'Rules', 'Template']) expect(raw, `${who}: ${secret}`).not.toContain(secret);
    }
  });

  it('options: tags, files and unresolved add nodes hanging off readable pages only; orphans=0 drops unlinked pages', async () => {
    const { body, raw } = await get(`/api/spaces/${slug}/graph?tags=1&files=1&unresolved=1&orphans=0`, 'editor');
    expect(nodePaths(body)).toEqual(['a.md', 'b.md', 'c.md', 'file:assets/pic.png', 'ghost:Ghost.md', 'hub.md', 'tag:team', 'tag:team/x']);
    expect(edgeList(body)).toEqual([
      'a.md>b.mdx2',
      'a.md>tag:team/xx1',
      'b.md>hub.mdx1',
      'c.md>a.mdx1',
      'hub.md>a.mdx1',
      'hub.md>b.mdx1',
      'hub.md>file:assets/pic.pngx1',
      'hub.md>ghost:Ghost.mdx1',
      'hub.md>tag:teamx1',
    ]);
    expect(body.nodes.find((n) => n.id === 'ghost:Ghost.md')).toMatchObject({ title: 'Ghost', kind: 'unresolved', degree: 1 });
    expect(body.nodes.find((n) => n.id === 'tag:team')).toMatchObject({ title: '#team', kind: 'tag' });
    expect(body.nodes.find((n) => n.id === 'file:assets/pic.png')).toMatchObject({ title: 'pic.png', kind: 'file', path: 'assets/pic.png' });
    expect(body.nodes.find((n) => n.path === 'hub.md')!.degree).toBe(5); // a, b (both ways), the file, the ghost, #team
    for (const secret of ['Secret ghost', 'secret.png', 'tag:secret', 'Template ghost', 'tag:tpl']) expect(raw).not.toContain(secret);
  });

  it('owner (space admin) sees the restricted page and .agent; a viewer with a grant sees the restricted page but not .agent; templates never', async () => {
    const own = (await get(`/api/spaces/${slug}/graph?unresolved=1&tags=1`, 'owner')).body;
    expect(contentPaths(nodePaths(own))).toEqual(
      ['.agent/rules.md', 'a.md', 'b.md', 'c.md', 'ghost:Ghost.md', 'ghost:Secret ghost.md', 'hub.md', 'lonely.md', 'restricted.md', 'tag:secret', 'tag:team', 'tag:team/x'].sort(),
    );
    expect(edgeList(own)).toEqual(expect.arrayContaining(['.agent/rules.md>hub.mdx1', 'hub.md>restricted.mdx1', 'restricted.md>a.mdx1']));
    expect(JSON.stringify(own)).not.toContain('Template');

    const g = (await get(`/api/spaces/${slug}/graph`, 'granted')).body;
    expect(contentPaths(nodePaths(g))).toEqual(['a.md', 'b.md', 'c.md', 'hub.md', 'lonely.md', 'restricted.md']);
    expect(edgeList(g)).toContain('restricted.md>a.mdx1');
    expect(JSON.stringify(g)).not.toContain('Rules');
  });

  it('an outsider gets 403 for the space graph and for a page graph', async () => {
    expect((await get(`/api/spaces/${slug}/graph`, 'outsider')).status).toBe(403);
    expect((await get(`/api/pages/${ids['hub.md']}/graph`, 'outsider')).status).toBe(403);
    expect((await get(`/api/spaces/no-such-space-${Date.now()}/graph`, 'editor')).status).toBe(404);
  });

  it('local graph: depth and direction, edges among the found pages, closed pages left out', async () => {
    const local = async (rel: string, qs: string, who = 'editor') => {
      const res = await get(`/api/pages/${ids[rel]}/graph?${qs}`, who);
      expect(res.status, `${rel}?${qs}`).toBe(200);
      return res.body;
    };
    let g = await local('hub.md', '');
    expect(g.center).toBe(ids['hub.md']);
    expect(nodePaths(g)).toEqual(['a.md', 'b.md', 'hub.md']);
    expect(edgeList(g)).toEqual(['a.md>b.mdx2', 'b.md>hub.mdx1', 'hub.md>a.mdx1', 'hub.md>b.mdx1']);
    expect(nodePaths(await local('hub.md', 'depth=2'))).toEqual(['a.md', 'b.md', 'c.md', 'hub.md']);
    expect(nodePaths(await local('hub.md', 'direction=out'))).toEqual(['a.md', 'b.md', 'hub.md']);
    expect(nodePaths(await local('hub.md', 'direction=in'))).toEqual(['b.md', 'hub.md']);
    expect(nodePaths(await local('a.md', 'direction=in&depth=2'))).toEqual(['a.md', 'b.md', 'c.md', 'hub.md']);
    expect(nodePaths(await local('a.md', 'direction=out&depth=3'))).toEqual(['a.md', 'b.md', 'hub.md']);
    g = await local('a.md', 'depth=1');
    expect(nodePaths(g)).toEqual(['a.md', 'b.md', 'c.md', 'hub.md']);
    expect(JSON.stringify(g)).not.toContain(ids['restricted.md']);
    // The owner sees the restricted page link into a, and .agent link into hub.
    expect(nodePaths(await local('a.md', 'depth=1', 'owner'))).toContain('restricted.md');
    expect(nodePaths(await local('hub.md', 'direction=in', 'owner'))).toEqual(['.agent/rules.md', 'b.md', 'hub.md']);
    // The local graph keeps its centre with orphans=0; a lonely page is just itself.
    expect(nodePaths(await local('lonely.md', 'orphans=0'))).toEqual(['lonely.md']);
    // Options work here too: hub's ghost, file and tag.
    expect(nodePaths(await local('hub.md', 'direction=out&tags=1&files=1&unresolved=1'))).toEqual(['a.md', 'b.md', 'file:assets/pic.png', 'ghost:Ghost.md', 'hub.md', 'tag:team', 'tag:team/x']);
    // A page the caller cannot open: 403; a .agent page: 404 (as everywhere).
    expect((await get(`/api/pages/${ids['restricted.md']}/graph`, 'editor')).status).toBe(403);
    expect((await get(`/api/pages/${ids['.agent/rules.md']}/graph`, 'editor')).status).toBe(404);
  });

  it('MCP get_graph: same rules, compact nodes, the page neighbourhood, and a limit', async () => {
    const call = async (actor: McpActor, args: Record<string, unknown>) => {
      const server = buildFolioMcpServer(actor);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test', version: '1.0.0' });
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      try {
        return await client.callTool({ name: 'get_graph', arguments: args });
      } finally {
        await client.close();
      }
    };
    const actor: McpActor = { user: editor, scopes: ['read'], tokenId: 'graph-editor' };
    const whole = await call(actor, { space: slug, unresolved: true });
    expect(whole.isError).toBeFalsy();
    const sc = whole.structuredContent as unknown as GraphResponse;
    expect(contentPaths(nodePaths(sc))).toEqual(['a.md', 'b.md', 'c.md', 'ghost:Ghost.md', 'hub.md', 'lonely.md']);
    expect(sc.nodes.every((n) => n.updatedAt === undefined)).toBe(true);
    expect(sc.limit).toBe(300);
    expect(JSON.stringify(whole)).not.toContain('Restricted');

    const near = (await call(actor, { space: slug, page: ids['hub.md'], depth: 2 })).structuredContent as unknown as GraphResponse;
    expect(nodePaths(near)).toEqual(['a.md', 'b.md', 'c.md', 'hub.md']);
    expect(near.center).toBe(ids['hub.md']);

    const capped = (await call(actor, { space: slug, limit: 2 })).structuredContent as unknown as GraphResponse;
    expect(capped.nodes).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    expect(capped.totalPages).toBeGreaterThan(2);

    expect((await call(actor, { space: slug, page: ids['restricted.md'] })).isError).toBe(true);
    expect((await call({ user: outsider, scopes: ['read'], tokenId: 'graph-out' }, { space: slug })).isError).toBe(true);
  });

  it('performance smoke: 5k pages and 20k links answer in about a second', async () => {
    const perfSlug = (await storage.createSpace(`Graph perf ${Date.now()}`, owner.id)).slug;
    spaces.push(perfSlug);
    await authStore.setMembership(perfSlug, editor.id, 'editor');
    const N = 5000;
    const L = 20000;
    await query(
      `INSERT INTO pages_index (id, space_slug, path, kind, title, updated_at)
       SELECT $1 || '-' || i, $1, 'notes/' || (i % 40) || '/page-' || i || '.md', 'doc', 'Page ' || i, now() - (i || ' minutes')::interval
         FROM generate_series(1, $2::int) AS i`,
      [perfSlug, N],
    );
    // Deterministic pseudo-random links, a few hubs, some restricted pages.
    await query(
      `INSERT INTO page_links (source_page_id, target_path, link_path, target_page_id, syntax, kind)
       SELECT $1 || '-' || (1 + abs(hashint4(i)) % $2), 'x.md', 'x', $1 || '-' || (1 + CASE WHEN i % 5 = 0 THEN i % 50 ELSE abs(hashint4(i + 1000003)) % $2 END), 'wikilink', 'page'
         FROM generate_series(1, $3::int) AS i`,
      [perfSlug, N, L],
    );
    await query(`INSERT INTO page_tags (page_id, tag, source) SELECT $1 || '-' || i, 'topic/' || (i % 30), 'body' FROM generate_series(1, $2::int) AS i`, [perfSlug, N]);
    await query(`INSERT INTO page_access (page_id, owner_id) SELECT $1 || '-' || i, $2 FROM generate_series(1, $3::int, 100) AS i`, [perfSlug, owner.id, N]);
    await query('ANALYZE pages_index; ANALYZE page_links; ANALYZE page_tags');

    let t0 = performance.now();
    const res = await get(`/api/spaces/${perfSlug}/graph?tags=1&tree=1`, 'editor');
    const spaceMs = performance.now() - t0;
    expect(res.status).toBe(200);
    expect(res.body.totalPages).toBe(N - N / 100 + 1); // + the space home page createSpace writes
    expect(res.body.edges.filter((e) => !e.target.startsWith('tag:')).length).toBeGreaterThan(15000);

    t0 = performance.now();
    const local = await get(`/api/pages/${perfSlug}-7/graph?depth=3&tree=1`, 'editor');
    const localMs = performance.now() - t0;
    expect(local.status).toBe(200);
    expect(local.body.nodes.length).toBeGreaterThan(10);

    console.log(`graph perf: space ${N} pages / ${res.body.edges.length} edges in ${spaceMs.toFixed(0)} ms (${(res.raw.length / 1024).toFixed(0)} KB); local depth 3 (${local.body.nodes.length} nodes) in ${localMs.toFixed(0)} ms`);
    expect(spaceMs).toBeLessThan(1500);
    expect(localMs).toBeLessThan(1500);
  }, 60_000);
});
