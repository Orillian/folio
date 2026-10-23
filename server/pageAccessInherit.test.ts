/**
 * Stage 7: page restrictions are inherited by child pages
 * (docs/spec-access.md §13). A page is readable only by who passes every
 * restriction on its chain (its own rule and its restricted ancestors'); the
 * page role is the lowest role those restrictions give. Real fs + real PG,
 * through the same surfaces a person or an agent reaches: the tree, search,
 * the graph, a page GET, the subtree, MCP, the socket audience, the access
 * dialog, moves, copies, duplicates, templates, share links and the trash.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PageAccessInfo, TreeNode, User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { buildFolioMcpServer, type McpActor } from './mcp.js';
import * as pageAccess from './pageAccess.js';
import { resolveCopyScope } from './copyScope.js';
import { registerRoutes } from './routes.js';
import * as storage from './storage.js';
import * as shares from './shares.js';
import { resolveShareScope } from './export/shareScope.js';
import * as audience from './notifications/audience.js';
import { childPrefixOf } from './access/pageTree.js';
import { childPrefixSql } from './access/roleSql.js';
import * as trash from './trash/service.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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

function treeIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...treeIds(node.children)]);
}

describe('childPrefixOf (TS) == childPrefixSql (SQL) == storage.relPathStem', () => {
  let teardown: () => Promise<void>;
  beforeAll(async () => {
    teardown = await setUpTestSchema();
  });
  afterAll(async () => teardown());

  it('agrees for every page kind and both page shapes', async () => {
    const cases: Array<{ path: string; kind: string; isIndex: boolean }> = [
      { path: 'index.md', kind: 'doc', isIndex: true },
      { path: 'README.md', kind: 'doc', isIndex: true },
      { path: 'a/index.md', kind: 'doc', isIndex: true },
      { path: 'a/b/README.md', kind: 'doc', isIndex: true },
      { path: 'plan.md', kind: 'doc', isIndex: false },
      { path: 'x/Plan.MD', kind: 'doc', isIndex: false },
      { path: 'x/board.excalidraw.svg', kind: 'board', isIndex: false },
      { path: 'x/weekly.table.md', kind: 'table', isIndex: false },
      { path: 'x/survey.form.md', kind: 'form', isIndex: false },
      { path: 'x/scan.pdf', kind: 'pdf', isIndex: false },
      { path: 'x/offer.pptx', kind: 'office', isIndex: false },
      { path: 'x/sheet.XLSX', kind: 'office', isIndex: false },
      { path: 'x/map.canvas', kind: 'canvas', isIndex: false },
      { path: 'x/tasks.base', kind: 'base', isIndex: false },
      { path: 'x/q3.artifact', kind: 'artifact', isIndex: false },
      { path: 'укр/сторінка.md', kind: 'doc', isIndex: false },
    ];
    for (const page of cases) {
      const rows = await query<{ prefix: string | null }>(`SELECT ${childPrefixSql('t')} AS prefix FROM (SELECT $1::text AS path, $2::text AS kind, $3::boolean AS is_index) t`, [
        page.path,
        page.kind,
        page.isIndex,
      ]);
      const ts = childPrefixOf(page);
      expect(rows[0].prefix ?? undefined, page.path).toBe(ts);
      if (!page.isIndex) {
        const dir = page.path.includes('/') ? page.path.slice(0, page.path.lastIndexOf('/') + 1) : '';
        expect(ts, page.path).toBe(`${dir}${storage.relPathStem(page.path, page.kind as Parameters<typeof storage.relPathStem>[1])}/`);
      }
    }
  });
});

describe('inherited page restrictions (real PG + fs)', () => {
  let teardown: () => Promise<void>;
  let app: FastifyInstance;
  let owner: User;
  let alice: User; // viewer grant on the parent
  let bob: User; // space editor, no grant
  let carol: User; // editor grant on the parent
  let dave: User; // in a group granted the parent
  let slug: string;
  const ids: Record<string, string> = {};
  const cookie: Record<string, string> = {};

  const get = async (url: string, who: string) => {
    const res = await app.inject({ method: 'GET', url, headers: { cookie: cookie[who] } });
    return { status: res.statusCode, body: res.statusCode < 300 ? res.json() : undefined, raw: res.body };
  };
  const post = async (url: string, who: string, payload: unknown) => {
    const res = await app.inject({ method: 'POST', url, headers: { cookie: cookie[who] }, payload: payload as object });
    return { status: res.statusCode, body: res.json() };
  };
  const entry = async (rel: string) => (await storage.getEntry(ids[rel]))!;
  const role = async (user: User, rel: string) => session.effectivePageRole(user, await entry(rel));

  beforeAll(async () => {
    teardown = await setUpTestSchema();
    app = await buildApp();
    const stamp = Date.now();
    const mk = (name: string) => authStore.createUser({ email: `inherit-${name}-${stamp}@example.com`, name, passwordHash: 'x', isAdmin: false });
    owner = await mk('owner');
    alice = await mk('alice');
    bob = await mk('bob');
    carol = await mk('carol');
    dave = await mk('dave');
    slug = (await storage.createSpace(`Inherit ${stamp}`, owner.id)).slug;
    await authStore.setMembership(slug, owner.id, 'admin');
    await authStore.setMembership(slug, alice.id, 'editor');
    await authStore.setMembership(slug, bob.id, 'editor');
    await authStore.setMembership(slug, carol.id, 'viewer');
    await authStore.setMembership(slug, dave.id, 'viewer');
    const dir = storage.getSpaceDir(slug);
    const put = async (rel: string, text: string) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), text);
    };
    await put('secret.md', '# Secret\n\nzebraword parent\n');
    await put('secret/child.md', '# Child\n\nzebraword child [[open]]\n');
    await put('secret/child/deep.md', '# Deep\n\nzebraword deep\n');
    await put('team/index.md', '# Team\n');
    await put('team/notes.md', '# Notes\n\nzebraword team\n');
    await put('open.md', '# Open\n\nzebraword open [[child]]\n');
    await put('_templates/tpl.md', '# Tpl\n');
    await put('_templates/tpl/inner.md', '# Inner\n');
    await storage.scanSpace(slug);
    for (const rel of ['secret.md', 'secret/child.md', 'secret/child/deep.md', 'team/index.md', 'team/notes.md', 'open.md', '_templates/tpl.md', '_templates/tpl/inner.md']) {
      const id = await storage.getEntryIdByExactPath(slug, rel);
      if (!id) throw new Error(`no page ${rel}`);
      ids[rel] = id;
    }
    const groupId = (await query<{ id: string }>("INSERT INTO groups (slug, name) VALUES ($1, 'Readers') RETURNING id", [`readers-${stamp}`]))[0].id;
    await query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [groupId, dave.id]);
    await query("INSERT INTO space_group_roles (space_slug, group_id, role) VALUES ($1, $2, 'viewer')", [slug, groupId]);
    await pageAccess.setAccess(owner, await entry('secret.md'), 'restricted', [
      { userId: alice.id, role: 'viewer' },
      { userId: carol.id, role: 'editor' },
      { groupId, role: 'viewer' },
    ]);
    for (const [name, user] of Object.entries({ owner, alice, bob, carol, dave })) {
      cookie[name] = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}`;
    }
  });
  afterAll(async () => {
    await app.close();
    await deleteTestSpace(slug).catch(() => undefined);
    await teardown();
  });

  it('the deploy report (server/tools/access-inherit-report.ts) lists who loses which page', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/tools/access-inherit-report.ts', '--json', '--space', slug], {
      env: { ...process.env },
      cwd: path.resolve(import.meta.dirname, '..'),
    });
    const report = JSON.parse(stdout) as { pages: Array<{ path: string; lost: Array<{ name: string }>; readersBefore: number; readersAfter: number; restrictedBy: Array<{ path: string }> }> };
    expect(report.pages.map((p) => p.path)).toEqual(['secret/child.md', 'secret/child/deep.md']);
    for (const page of report.pages) {
      expect(page.lost.map((p) => p.name)).toEqual(['bob']);
      expect([page.readersBefore, page.readersAfter]).toEqual([5, 4]);
      expect(page.restrictedBy.map((r) => r.path)).toEqual(['secret.md']);
    }
  });

  it('a child and a grandchild of a restricted page are restricted like it (group grants included)', async () => {
    for (const rel of ['secret.md', 'secret/child.md', 'secret/child/deep.md']) {
      expect(await role(owner, rel), `owner ${rel}`).toBe('editor');
      expect(await role(alice, rel), `alice ${rel}`).toBe('viewer');
      expect(await role(carol, rel), `carol ${rel}`).toBe('editor');
      expect(await role(dave, rel), `dave ${rel}`).toBe('viewer');
      expect(await role(bob, rel), `bob ${rel}`).toBeUndefined();
    }
    expect(await role(bob, 'open.md')).toBe('editor');
    expect(await role(bob, 'team/notes.md')).toBe('editor');
  });

  it('a child can narrow, never widen: the lowest role on the chain, one rule not passed hides', async () => {
    // Carol (editor on the parent) restricts the child to herself + bob (who cannot read the parent) + alice as editor.
    await pageAccess.setAccess(carol, await entry('secret/child.md'), 'restricted', [
      { userId: bob.id, role: 'editor' },
      { userId: alice.id, role: 'editor' },
    ]);
    try {
      expect(await role(carol, 'secret/child.md')).toBe('editor');
      expect(await role(alice, 'secret/child.md')).toBe('viewer'); // editor here, viewer on the parent
      expect(await role(bob, 'secret/child.md')).toBeUndefined(); // the child cannot widen past the parent
      expect(await role(owner, 'secret/child.md')).toBeUndefined(); // parent's owner, not let into the child; no admin bypass
      expect(await role(dave, 'secret/child/deep.md')).toBeUndefined();
      expect(await role(alice, 'secret/child/deep.md')).toBe('viewer');

      const info = (await get(`/api/pages/${ids['secret/child/deep.md']}/access`, 'carol')).body as PageAccessInfo;
      expect(info.visibility).toBe('space');
      expect(info.inheritedFrom.map((p) => p.title)).toEqual(['Secret', 'Child']);
      expect(info.audience?.map((r) => [r.name, r.role]).sort()).toEqual([
        ['alice', 'viewer'],
        ['carol', 'editor'],
      ]);
      const asAlice = (await get(`/api/pages/${ids['secret/child/deep.md']}/access`, 'alice')).body as PageAccessInfo;
      expect(asAlice.audience).toBeUndefined();
      expect(asAlice.audienceCount).toBe(2);
    } finally {
      await pageAccess.setAccess(carol, await entry('secret/child.md'), 'space', []);
    }
  });

  it('no leak through the tree, the page API, the subtree, search, the graph, backlinks or MCP', async () => {
    const hiddenIds = [ids['secret.md'], ids['secret/child.md'], ids['secret/child/deep.md']];
    const tree = (await get(`/api/spaces/${slug}/tree`, 'bob')).body.tree as TreeNode[];
    for (const id of hiddenIds) expect(treeIds(tree)).not.toContain(id);
    expect(treeIds(tree)).toContain(ids['open.md']);
    const aliceTree = (await get(`/api/spaces/${slug}/tree`, 'alice')).body.tree as TreeNode[];
    expect(treeIds(aliceTree)).toEqual(expect.arrayContaining(hiddenIds));
    // Lock marks: its own rule vs inherited; open pages carry none.
    const flat = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((node) => [node, ...flat(node.children)]);
    const marks = new Map(flat(aliceTree).map((node) => [node.id, node.access]));
    expect([marks.get(ids['secret.md']), marks.get(ids['secret/child.md']), marks.get(ids['secret/child/deep.md']), marks.get(ids['open.md'])]).toEqual([
      'restricted',
      'inherited',
      'inherited',
      undefined,
    ]);

    for (const id of hiddenIds) expect((await get(`/api/pages/${id}`, 'bob')).status).toBe(403);
    expect((await get(`/api/pages/${ids['secret/child/deep.md']}`, 'alice')).status).toBe(200);

    const search = (await get(`/api/search?q=zebraword&space=${slug}`, 'bob')).body.hits as Array<{ id: string }>;
    expect(search.map((h) => h.id).sort()).toEqual([ids['open.md'], ids['team/notes.md']].sort());
    const searchAlice = (await get(`/api/search?q=zebraword&space=${slug}`, 'alice')).body.hits as Array<{ id: string }>;
    expect(searchAlice.map((h) => h.id)).toEqual(expect.arrayContaining(hiddenIds));

    const graph = await get(`/api/spaces/${slug}/graph`, 'bob');
    expect(graph.status).toBe(200);
    for (const id of hiddenIds) expect(graph.raw).not.toContain(id);
    expect(graph.raw).not.toContain('Child');

    const backlinks = await get(`/api/pages/${ids['open.md']}/backlinks`, 'bob');
    if (backlinks.status === 200) expect(backlinks.raw).not.toContain(ids['secret/child.md']);

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
    const bobActor: McpActor = { user: bob, scopes: ['read'], tokenId: 'inherit-bob' };
    const mcpSearch = await call(bobActor, 'search_pages', { query: 'zebraword', space: slug });
    expect(JSON.stringify(mcpSearch)).not.toContain(ids['secret/child.md']);
    expect(JSON.stringify(mcpSearch)).not.toContain('zebraword deep');
    expect((await call(bobActor, 'read_page', { id: ids['secret/child/deep.md'] })).isError).toBe(true);
    const mcpTree = await call(bobActor, 'list_tree', { space: slug });
    for (const id of hiddenIds) expect(JSON.stringify(mcpTree)).not.toContain(id);
    expect(JSON.stringify(await call(bobActor, 'get_graph', { space: slug }))).not.toContain(ids['secret/child.md']);
  });

  it('the socket audience of a child is the parent\'s audience', async () => {
    const tokens = new Map<string, string>();
    for (const user of [owner, alice, bob, carol, dave]) tokens.set((await authStore.createSession(user.id)).token, user.name);
    const allowed = await audience.sessionsThatCanReadPage(await entry('secret/child/deep.md'), new Set(tokens.keys()));
    expect([...allowed].map((t) => tokens.get(t)).sort()).toEqual(['alice', 'carol', 'dave', 'owner']);
  });

  it('moves and renames: inheritance follows the page\'s place', async () => {
    // Out of the restricted subtree: open to the space again (like Confluence).
    await storage.movePage(ids['secret/child/deep.md'], '');
    expect((await storage.getEntry(ids['secret/child/deep.md']))!.relPath).toBe('deep.md');
    expect(await role(bob, 'secret/child/deep.md')).toBe('editor');
    // Into it: restricted at once.
    await storage.movePage(ids['open.md'], 'secret');
    expect(await role(bob, 'open.md')).toBeUndefined();
    expect((await session.readablePageIds(bob, slug)).has(ids['open.md'])).toBe(false);
    // The restricted page itself moves with its children folder: they stay restricted.
    await storage.movePage(ids['secret.md'], 'team');
    expect((await storage.getEntry(ids['secret/child.md']))!.relPath).toBe('team/secret/child.md');
    expect(await role(bob, 'secret/child.md')).toBeUndefined();
    expect(await role(bob, 'team/notes.md')).toBe('editor');
    // A slug rename keeps the pairing too.
    await storage.renamePageSlug(ids['secret.md'], 'vault');
    expect((await storage.getEntry(ids['secret/child.md']))!.relPath).toBe('team/vault/child.md');
    expect(await role(bob, 'secret/child.md')).toBeUndefined();
    // Restricting a directory-index page closes its whole folder.
    await pageAccess.setAccess(owner, await entry('team/index.md'), 'restricted', []);
    expect(await role(bob, 'team/notes.md')).toBeUndefined();
    expect(await role(alice, 'secret/child.md')).toBeUndefined(); // now under team/ too, and alice has no grant there
    await pageAccess.setAccess(owner, await entry('team/index.md'), 'space', []);
    expect(await role(alice, 'secret/child.md')).toBe('viewer');
    // Back where they were.
    await storage.renamePageSlug(ids['secret.md'], 'secret');
    await storage.movePage(ids['secret.md'], '');
    await storage.movePage(ids['open.md'], '');
    await storage.movePage(ids['secret/child/deep.md'], 'secret/child');
    expect((await storage.getEntry(ids['secret/child/deep.md']))!.relPath).toBe('secret/child/deep.md');
    expect(await role(bob, 'secret/child/deep.md')).toBeUndefined();
  });

  it('copies, duplicates and templates out of a restricted subtree never land open', async () => {
    // Alice copies the child (restricted only through its parent) to the space root: the copy is hers alone.
    const scope = await resolveCopyScope(alice, await entry('secret/child.md'), true);
    const copy = await storage.copyPage(ids['secret/child.md'], slug, '', undefined, true, scope);
    const copyEntry = (await storage.getEntry(copy.id))!;
    expect(await session.effectivePageRole(bob, copyEntry)).toBeUndefined();
    expect(await session.effectivePageRole(alice, copyEntry)).toBe('editor');
    const copiedDeep = (await storage.listEntries(slug)).find((e) => e.relPath.startsWith(`${copyEntry.relPath.slice(0, -3)}/`) && e.title === 'Deep')!;
    expect(copiedDeep).toBeDefined();
    expect(await session.effectivePageRole(bob, copiedDeep)).toBeUndefined();
    expect((await query('SELECT owner_id FROM page_access WHERE page_id = $1', [copy.id]))[0]).toEqual({ owner_id: alice.id });

    // A duplicate next to the original stays under the same parent: no extra rule, same audience.
    const dup = await storage.duplicatePage(ids['secret/child.md'], undefined, 'Child (copy)', await resolveCopyScope(alice, await entry('secret/child.md'), true));
    expect((await query('SELECT 1 FROM page_access WHERE page_id = $1', [dup.id])).length).toBe(0);
    const dupEntry = (await storage.getEntry(dup.id))!;
    expect(await session.effectivePageRole(bob, dupEntry)).toBeUndefined();
    expect(await session.effectivePageRole(dave, dupEntry)).toBe('viewer');

    // A template made from it, and a page made from a restricted template.
    const template = await storage.makeTemplate(ids['secret/child.md'], { scope: await resolveCopyScope(carol, await entry('secret/child.md'), true) });
    expect(await session.effectivePageRole(bob, (await storage.getEntry(template.id))!)).toBeUndefined();
    await pageAccess.setAccess(owner, await entry('_templates/tpl.md'), 'restricted', [{ userId: carol.id, role: 'viewer' }]);
    const fromInner = await storage.copyPage(ids['_templates/tpl/inner.md'], slug, '', undefined, true, await resolveCopyScope(carol, await entry('_templates/tpl/inner.md'), true));
    expect(await session.effectivePageRole(bob, (await storage.getEntry(fromInner.id))!)).toBeUndefined();
    // Bob cannot copy what he cannot open (the routes refuse it; storage too).
    await expect(storage.copyPage(ids['secret/child.md'], slug, '', undefined, true, await resolveCopyScope(bob, await entry('secret/child.md'), true))).rejects.toThrow();
    await pageAccess.setAccess(owner, await entry('_templates/tpl.md'), 'space', []);
    for (const id of [copy.id, dup.id, template.id, fromInner.id]) await storage.deletePage(id).catch(() => undefined);
  });

  it('share links keep their semantics: a subtree link cuts at pages with a rule of their own, its own root is always in', async () => {
    const token = (info: { url: string }) => info.url.split('/share/')[1];
    // Rooted inside the restricted subtree (the creator can open it): what lies below, restricted only through the root's parents, rides along.
    const childShare = await shares.createShareLink(ids['secret/child.md'], carol.id, 'view', 'http://localhost', true);
    expect([...(await resolveShareScope(token(childShare)))!.collected.ids].sort()).toEqual([ids['secret/child.md'], ids['secret/child/deep.md']].sort());
    // A page with a rule of its own below the root is cut, with everything under it.
    await pageAccess.setAccess(carol, await entry('secret/child.md'), 'restricted', []);
    const parentShare = await shares.createShareLink(ids['secret.md'], owner.id, 'view', 'http://localhost', true);
    expect([...(await resolveShareScope(token(parentShare)))!.collected.ids]).toEqual([ids['secret.md']]);
    await pageAccess.setAccess(carol, await entry('secret/child.md'), 'space', []);
    expect((await resolveShareScope(token(parentShare)))!.collected.ids.has(ids['secret/child/deep.md'])).toBe(true);
    // Everyone-facing sets (public sites, a guest's raw files) count inherited restrictions.
    const restricted = await pageAccess.restrictedPageIds(slug);
    for (const rel of ['secret.md', 'secret/child.md', 'secret/child/deep.md']) expect(restricted.has(ids[rel]), rel).toBe(true);
    expect(restricted.has(ids['open.md'])).toBe(false);
  });

  it('trash: a child deleted on its own and restored after its parent is gone comes back restricted', async () => {
    await storage.deletePage(ids['secret/child/deep.md'], owner.id);
    const item = (await query<{ id: string; payload: { access?: Array<{ inheritedFrom?: string[] }> } }>('SELECT id, payload FROM trash_items WHERE page_id = $1', [ids['secret/child/deep.md']]))[0];
    expect(item.payload.access?.some((entry) => entry.inheritedFrom?.length)).toBe(true);
    // Restored while the parents are still there: no rule of its own, the parents restrict it again.
    await trash.restoreTrashItem(owner, item.id);
    expect((await query('SELECT 1 FROM page_access WHERE page_id = $1', [ids['secret/child/deep.md']])).length).toBe(0);
    expect(await role(bob, 'secret/child/deep.md')).toBeUndefined();
    expect(await role(alice, 'secret/child/deep.md')).toBe('viewer');

    // Deleted again, then its restricted parent goes too: the restore keeps the parents' audience.
    await storage.deletePage(ids['secret/child/deep.md'], owner.id);
    const again = (await query<{ id: string }>('SELECT id FROM trash_items WHERE page_id = $1 ORDER BY deleted_at DESC LIMIT 1', [ids['secret/child/deep.md']]))[0];
    await pageAccess.setAccess(owner, await entry('secret.md'), 'space', []);
    await trash.restoreTrashItem(owner, again.id);
    expect(await role(bob, 'secret/child/deep.md')).toBeUndefined();
    expect(await role(alice, 'secret/child/deep.md')).toBe('viewer');
    expect(await role(carol, 'secret/child/deep.md')).toBe('editor');
    expect(await role(owner, 'secret/child/deep.md')).toBe('editor');
  });
});
