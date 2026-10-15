/**
 * Index v2 (Obsidian brief wave 1b), real PG + real files: the two-phase link
 * index (raw rows, then resolution per space), fragments, the meta_version
 * re-parse, and the reads — REST and MCP — filtered in SQL to what the caller
 * may read. Fixtures are written here.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '../shared/contracts.js';
import { INDEX_META_VERSION } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import * as collab from './collab.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { buildFolioMcpServer, type McpActor } from './mcp.js';
import * as pageAccess from './pageAccess.js';
import { findTrashItemId } from './pageChanges.js';
import { registerRoutes } from './routes.js';
import * as storage from './storage.js';
import { restoreTrashItem } from './trash/service.js';

const AUTHOR = { name: 'Tester', email: 't@example.test' };

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

interface LinkRow {
  syntax: string;
  kind: string;
  target_path: string;
  target_page_id: string | null;
  fragment: string | null;
  fragment_resolved: boolean | null;
}

async function linksOf(sourceId: string): Promise<LinkRow[]> {
  return query<LinkRow>('SELECT syntax, kind, target_path, target_page_id, fragment, fragment_resolved FROM page_links WHERE source_page_id = $1 ORDER BY line, id', [sourceId]);
}

async function unresolvedCount(space: string): Promise<number> {
  const rows = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM page_links l JOIN pages_index p ON p.id = l.source_page_id WHERE p.space_slug = $1 AND l.kind = 'unresolved'`, [space]);
  return rows[0].n;
}

describe('index v2: two-phase link index, fragments, re-parse, ACL-filtered reads (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let owner: User;
  let member: User;
  const spaces: string[] = [];

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    owner = await authStore.createUser({ email: `idx-owner-${stamp}@example.com`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    member = await authStore.createUser({ email: `idx-member-${stamp}@example.com`, name: 'Member', passwordHash: 'x', isAdmin: false });
  });
  afterAll(async () => {
    for (const slug of spaces) await deleteTestSpace(slug);
    await teardownSchema();
  });

  async function newSpace(name: string): Promise<{ slug: string; dir: string; put: (rel: string, text: string) => Promise<void>; id: (rel: string) => Promise<string> }> {
    const slug = (await storage.createSpace(`${name} ${Date.now()}`, owner.id)).slug;
    spaces.push(slug);
    await authStore.setMembership(slug, owner.id, 'admin');
    await authStore.setMembership(slug, member.id, 'editor');
    const dir = storage.getSpaceDir(slug);
    return {
      slug,
      dir,
      put: async (rel, text) => {
        await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await fs.writeFile(path.join(dir, rel), text, 'utf8');
      },
      id: async (rel) => {
        const found = await storage.getEntryIdByExactPath(slug, rel);
        if (!found) throw new Error(`no page ${rel}`);
        return found;
      },
    };
  }

  it('a link to a page that does not exist yet is unresolved; creating the page resolves it; deleting it keeps the rows as unresolved; restoring it from the trash resolves them again', async () => {
    const { slug } = await newSpace('Index TwoPhase');
    const source = await storage.createPage({ space: slug, parentPath: '', title: 'Source', kind: 'doc' });
    await storage.writeDocBody(source.id, '# Source\n\nSee [later](later.md#part-two) and [[Later#^b1|alias]].\n');
    expect((await linksOf(source.id)).map((l) => `${l.syntax}:${l.kind}:${l.target_path}`)).toEqual(['md:unresolved:later.md', 'wikilink:unresolved:Later.md']);

    const later = await storage.createPage({ space: slug, parentPath: '', title: 'Later', kind: 'doc' });
    let rows = await linksOf(source.id);
    expect(rows.map((l) => [l.kind, l.target_page_id, l.target_path])).toEqual([
      ['page', later.id, 'later.md'],
      ['page', later.id, 'later.md'],
    ]);
    expect(rows.map((l) => l.fragment_resolved)).toEqual([false, false]); // the new page has neither the heading nor the block yet
    await storage.writeDocBody(later.id, '# Later\n\n## Part two\n\nA paragraph ^b1\n');
    expect((await linksOf(source.id)).map((l) => l.fragment_resolved)).toEqual([true, true]);

    await storage.deletePage(later.id, owner.id);
    rows = await linksOf(source.id);
    expect(rows.map((l) => [l.kind, l.target_page_id, l.fragment_resolved])).toEqual([
      ['unresolved', null, null],
      ['unresolved', null, null],
    ]);
    expect(await query('SELECT 1 FROM links WHERE source_page_id = $1 AND kind = $2', [source.id, 'broken'])).toHaveLength(2); // the compatibility view

    const trashId = await findTrashItemId(later.id);
    expect(trashId).toBeTruthy();
    await restoreTrashItem(owner, trashId!); // a space admin restores
    rows = await linksOf(source.id);
    expect(rows.map((l) => [l.kind, l.target_page_id, l.fragment_resolved])).toEqual([
      ['page', later.id, true],
      ['page', later.id, true],
    ]);
  });

  it('renaming and moving a page with wikilinks and markdown links to it adds no unresolved link; fragments stay resolved', async () => {
    const s = await newSpace('Index Rename');
    await s.put('docs/target.md', '# Target\n\n## Intro\n\nBody ^blk\n');
    await s.put('docs/a.md', '# A\n\n[t](target.md#intro) and [[target#Intro]] and [[target#^blk|b]] and [[ghost]]\n');
    await s.put('elsewhere/b.md', '# B\n\n[[target]] and [t](../docs/target.md)\n');
    await storage.scanSpace(s.slug);
    const targetId = await s.id('docs/target.md');
    const before = await unresolvedCount(s.slug);
    expect(before).toBe(1); // [[ghost]]
    const intoTarget = async () =>
      query<{ n: number; frag: number }>(
        `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE fragment_resolved)::int AS frag FROM page_links WHERE target_page_id = $1 AND kind = 'page'`,
        [targetId],
      );
    expect(await intoTarget()).toEqual([{ n: 5, frag: 3 }]);

    await collab.renamePageSlug(targetId, 'renamed', AUTHOR);
    expect(await unresolvedCount(s.slug)).toBe(before);
    expect(await intoTarget()).toEqual([{ n: 5, frag: 3 }]);
    expect(await fs.readFile(path.join(s.dir, 'elsewhere/b.md'), 'utf8')).toContain('[[renamed]] and [t](../docs/renamed.md)');

    await collab.movePage(targetId, 'archive', AUTHOR);
    expect(await unresolvedCount(s.slug)).toBe(before);
    expect(await intoTarget()).toEqual([{ n: 5, frag: 3 }]);

    // a heading the links name disappears from the target: the fragments say so, the links stay resolved
    await storage.writeDocBody(targetId, '# Target\n\n## Other\n\nBody ^blk\n');
    expect(await intoTarget()).toEqual([{ n: 5, frag: 1 }]);
  });

  it('meta_version: a document indexed by an older parser is re-parsed by the scan although its file did not change', async () => {
    const s = await newSpace('Index Reparse');
    await s.put('one.md', '# One\n\n## Section\n\n#tagged text\n');
    await s.put('two.md', '# Two\n');
    await storage.scanSpace(s.slug);
    await storage.scanSpace(s.slug); // settles the files the first scan stamped an id into
    const oneId = await s.id('one.md');
    expect((await query<{ meta_version: number }>('SELECT meta_version FROM pages_index WHERE id = $1', [oneId]))[0].meta_version).toBe(INDEX_META_VERSION);

    await query('UPDATE pages_index SET meta_version = 0 WHERE id = $1', [oneId]);
    await query('DELETE FROM page_headings WHERE page_id = $1', [oneId]);
    await query('DELETE FROM page_tags WHERE page_id = $1', [oneId]);
    const stats = await storage.scanSpace(s.slug);
    expect(stats.filesRead).toBe(1); // only the stale row; two.md stays skipped
    expect((await query<{ slug: string }>('SELECT slug FROM page_headings WHERE page_id = $1 ORDER BY position', [oneId])).map((r) => r.slug)).toEqual(['one', 'section']);
    expect((await query<{ tag: string }>('SELECT tag FROM page_tags WHERE page_id = $1', [oneId])).map((r) => r.tag)).toEqual(['tagged']);
    expect((await query<{ meta_version: number }>('SELECT meta_version FROM pages_index WHERE id = $1', [oneId]))[0].meta_version).toBe(INDEX_META_VERSION);
    expect((await storage.scanSpace(s.slug)).filesRead).toBe(0);
  });

  describe('reads filtered to what the caller may see (REST and MCP)', () => {
    let app: FastifyInstance;
    let s: Awaited<ReturnType<typeof newSpace>>;
    const ids: Record<string, string> = {};
    let ownerAuth: Record<string, string>;
    let memberAuth: Record<string, string>;

    beforeAll(async () => {
      app = await buildApp();
      s = await newSpace('Index ACL');
      await s.put('target.md', '---\nstatus: draft\nowner: someone\ntags: [Spec]\n---\n# Target\n\n## Usage\n\nText ^tb\n');
      await s.put('open.md', '# Open\n\nSee [the target](target.md#usage) and [r](restricted.md) and [[Ghost open]]. #open\n');
      await s.put('restricted.md', '# Restricted\n\nAlso [[target]] and [[Ghost secret]]. #secret\n');
      await s.put('lonely.md', '# Lonely\n');
      await s.put('_templates/tpl.md', '# Template\n\n[[target]] [[Ghost template]] #tpl\n');
      await storage.scanSpace(s.slug);
      for (const rel of ['target.md', 'open.md', 'restricted.md', 'lonely.md']) ids[rel] = await s.id(rel);
      await pageAccess.setAccess(owner, (await storage.getEntry(ids['restricted.md']))!, 'restricted', []);
      const cookie = async (user: User) => ({ cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` });
      ownerAuth = await cookie(owner);
      memberAuth = await cookie(member);
    });
    afterAll(async () => {
      await app.close();
    });

    const get = async (url: string, headers: Record<string, string>) => {
      const res = await app.inject({ method: 'GET', url, headers });
      return { status: res.statusCode, body: res.json() as any };
    };

    it('REST: backlinks with context, page meta, tags, unresolved links and orphans count only readable, non-template sources', async () => {
      const t = ids['target.md'];
      const memberBacklinks = await get(`/api/pages/${t}/backlinks`, memberAuth);
      expect(memberBacklinks.status).toBe(200);
      expect(memberBacklinks.body.backlinks.map((b: any) => [b.id, b.syntax, b.fragment, b.line])).toEqual([[ids['open.md'], 'md', 'usage', 3]]);
      expect(memberBacklinks.body.backlinks[0].context).toBe('See [the target](target.md#usage) and [r](restricted.md) and [[Ghost open]]. #open');
      expect((await get(`/api/pages/${t}/backlinks`, ownerAuth)).body.backlinks.map((b: any) => b.id).sort()).toEqual([ids['open.md'], ids['restricted.md']].sort());

      const meta = await get(`/api/pages/${t}/meta`, memberAuth);
      expect(meta.status).toBe(200);
      expect(meta.body).toMatchObject({
        id: t,
        path: 'target.md',
        title: 'Target',
        headings: [
          { level: 1, text: 'Target', slug: 'target', line: 1 },
          { level: 2, text: 'Usage', slug: 'usage', line: 3 },
        ],
        blocks: [{ blockId: 'tb', line: 5 }],
        tags: [{ tag: 'spec', source: 'frontmatter', line: null }],
        backlinkCount: 1,
        metaVersion: INDEX_META_VERSION,
      });
      expect(meta.body.properties).toMatchObject({ status: 'draft', owner: 'someone', tags: ['Spec'] });
      expect((await get(`/api/pages/${t}/meta`, ownerAuth)).body.backlinkCount).toBe(2);
      // a link to a page the caller cannot read looks like a link to nothing; its owner sees it resolved
      const linkTo = (body: any, p: string) => body.links.find((l: any) => l.targetPath === p);
      expect(linkTo((await get(`/api/pages/${ids['open.md']}/meta`, memberAuth)).body, 'restricted.md')).toMatchObject({ kind: 'unresolved', targetPageId: null });
      expect(linkTo((await get(`/api/pages/${ids['open.md']}/meta`, ownerAuth)).body, 'restricted.md')).toMatchObject({ kind: 'page', targetPageId: ids['restricted.md'] });
      expect(linkTo((await get(`/api/pages/${ids['open.md']}/meta`, ownerAuth)).body, 'target.md')).toMatchObject({ syntax: 'md', fragment: 'usage', fragmentKind: 'heading', fragmentResolved: true });
      expect((await get(`/api/pages/${ids['restricted.md']}/meta`, memberAuth)).status).toBe(403);

      expect((await get(`/api/spaces/${s.slug}/tags`, memberAuth)).body.tags).toEqual([
        { tag: 'open', pages: 1 },
        { tag: 'spec', pages: 1 },
      ]);
      expect((await get(`/api/spaces/${s.slug}/tags`, ownerAuth)).body.tags.map((x: any) => x.tag)).toEqual(['open', 'secret', 'spec']);

      const memberUnresolved = (await get(`/api/spaces/${s.slug}/unresolved-links`, memberAuth)).body;
      expect(memberUnresolved).toMatchObject({ total: 1, links: [{ sourceId: ids['open.md'], sourcePath: 'open.md', sourceTitle: 'Open', targetPath: 'Ghost open.md', syntax: 'wikilink', line: 3 }] });
      const ownerPage = (await get(`/api/spaces/${s.slug}/unresolved-links?limit=1&offset=1`, ownerAuth)).body;
      expect(ownerPage.total).toBe(2);
      expect(ownerPage.links.map((l: any) => l.targetPath)).toEqual(['Ghost secret.md']);

      expect((await get(`/api/spaces/${s.slug}/orphans`, memberAuth)).body.pages.map((p: any) => p.path)).toEqual(['lonely.md', 'open.md']);
      expect((await get(`/api/spaces/${s.slug}/orphans`, ownerAuth)).body.pages.map((p: any) => p.path)).toEqual(['lonely.md', 'open.md']);

      const outsider = await authStore.createUser({ email: `idx-out-${Date.now()}@example.com`, name: 'Out', passwordHash: 'x', isAdmin: false });
      const outsiderAuth = { cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(outsider.id)).token}` };
      for (const url of [`/api/spaces/${s.slug}/tags`, `/api/spaces/${s.slug}/unresolved-links`, `/api/spaces/${s.slug}/orphans`, `/api/pages/${t}/meta`]) {
        expect((await get(url, outsiderAuth)).status, url).toBe(403);
      }
    });

    it('MCP: get_page_metadata, list_unresolved_links, list_orphans and get_backlinks answer with the same rules; a public-site actor sees only the public page set', async () => {
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
      const memberActor: McpActor = { user: member, scopes: ['read'], tokenId: 'idx-member' };
      const t = ids['target.md'];
      const meta = await call(memberActor, 'get_page_metadata', { id: t });
      expect(meta.isError).toBeFalsy();
      expect(meta.structuredContent).toMatchObject({ id: t, backlinkCount: 1, headings: [{ slug: 'target' }, { slug: 'usage' }] });
      const hidden = await call(memberActor, 'get_page_metadata', { id: ids['restricted.md'] });
      expect(hidden.isError).toBe(true);
      expect((hidden.content as Array<{ text: string }>)[0].text).toBe('page not found');
      expect((await call(memberActor, 'list_unresolved_links', { space: s.slug, limit: 10 })).structuredContent).toMatchObject({ total: 1 });
      expect(((await call(memberActor, 'list_orphans', { space: s.slug })).structuredContent as any).pages.map((p: any) => p.path)).toEqual(['lonely.md', 'open.md']);
      const backlinks = (await call(memberActor, 'get_backlinks', { id: t })).structuredContent as any;
      expect(backlinks.backlinks).toEqual([expect.objectContaining({ id: ids['open.md'], syntax: 'md', fragment: 'usage', line: 3, context: expect.stringContaining('[the target]') })]);

      await query(`UPDATE spaces SET visibility = 'public' WHERE slug = $1`, [s.slug]);
      try {
        const visitor = await authStore.findUserById(authStore.PUBLIC_VISITOR_USER_ID);
        const publicActor: McpActor = { user: visitor!, scopes: ['read'], tokenId: 'idx-public', publicSpace: s.slug };
        expect((await call(publicActor, 'list_unresolved_links', { space: s.slug })).structuredContent).toMatchObject({ total: 1, links: [{ targetPath: 'Ghost open.md' }] });
        expect(((await call(publicActor, 'get_backlinks', { id: t })).structuredContent as any).backlinks.map((b: any) => b.id)).toEqual([ids['open.md']]);
        expect((await call(publicActor, 'list_orphans', { space: 'some-other-space' })).isError).toBe(true);
      } finally {
        await query(`UPDATE spaces SET visibility = 'private' WHERE slug = $1`, [s.slug]);
      }
    });
  });
});
