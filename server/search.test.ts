import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SearchHit, User } from '../shared/contracts.js';
import * as session from './auth/session.js';
import { HttpError } from './errors.js';
import { buildFolioMcpServer, type McpActor } from './mcp.js';
import { registerRoutes } from './routes.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { query } from './db/pool.js';
import * as storage from './storage.js';
import * as pageAccess from './pageAccess.js';
import { clampSearchLimit, clampSearchOffset, searchPages, searchPublicSpace } from './search.js';
import * as authStore from './auth/store.js';

describe('search (real PG: tsvector/simple + unaccent + pg_trgm)', () => {
  let teardownSchema: () => Promise<void>;
  let memberId: string;
  let outsiderId: string;
  let spaceASlug: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();

    memberId = (await authStore.createUser({ email: 'member@search-test.local', name: 'Member', passwordHash: 'x', isAdmin: false })).id;
    outsiderId = (await authStore.createUser({ email: 'outsider@search-test.local', name: 'Outsider', passwordHash: 'x', isAdmin: false })).id;

    const spaceA = await storage.createSpace(`Search Test A ${Date.now()}`, memberId);
    spaceASlug = spaceA.slug;
    await authStore.setMembership(spaceASlug, memberId, 'admin'); // outsider is deliberately NOT added

    await storage.createPage({
      space: spaceASlug,
      parentPath: '',
      title: 'Roadmap Alpha',
      kind: 'doc',
    });
  });

  afterAll(async () => {
    const root = (await storage.listEntries(spaceASlug)).find((e) => e.dirPath === '' && e.isIndex);
    if (root) await storage.deletePage(root.id).catch(() => {});
    await teardownSchema();
  });

  it('a member sees hits from their own space', async () => {
    const hits = await searchPages('Roadmap', { userId: memberId });
    expect(hits.some((h) => h.title === 'Roadmap Alpha')).toBe(true);
  });

  it('indexes a status tag as its text: found by the label, never by the colour attribute, snippet without the syntax', async () => {
    const meta = await storage.createPage({ space: spaceASlug, parentPath: '', title: 'Status Index Page', kind: 'doc' });
    await storage.writeDocBody(meta.id, '# Status Index Page\n\nVerdict: :status[Zanzibar]{color=purple} for now\n');
    const byLabel = await searchPages('Zanzibar', { userId: memberId });
    const hit = byLabel.find((h) => h.id === meta.id);
    expect(hit).toBeDefined();
    expect(hit!.snippet).not.toContain(':status');
    expect(hit!.snippet).not.toContain('color=');
    const byAttribute = await searchPages('purple', { userId: memberId });
    expect(byAttribute.some((h) => h.id === meta.id)).toBe(false);
  });

  it('a non-member sees NO hits from a space they cannot see — filtered in-query, not post-filtered', async () => {
    const hits = await searchPages('Roadmap', { userId: outsiderId });
    expect(hits.some((h) => h.space === spaceASlug)).toBe(false);
  });

  // Round 27 (access and rights): the old instance-admin search bypass is gone —
  // an instance-admin with NO explicit membership sees exactly what any other
  // non-member sees: nothing from a private space. `isAdmin` grants nothing
  // extra to search (spec-access.md §1/§2); SearchOptions no longer even
  // accepts an admin flag. See server/access/accessBoundary.test.ts's "path
  // 3" test for the full six-path acceptance version of this.
  it('an instance admin with NO explicit membership sees NOTHING from a private space — the old admin bypass is gone', async () => {
    const adminId = (await authStore.createUser({ email: 'admin@search-test.local', name: 'Admin', passwordHash: 'x', isAdmin: true })).id;
    const hits = await searchPages('Roadmap', { userId: adminId });
    expect(hits.some((h) => h.space === spaceASlug)).toBe(false);
  });

  it('a space with visibility "instance" is searchable by any active user, membership or not — including an instance-admin', async () => {
    const anyUserId = (await authStore.createUser({ email: 'any-instance-vis@search-test.local', name: 'Any', passwordHash: 'x', isAdmin: false })).id;
    const adminId = (await authStore.createUser({ email: 'admin2@search-test.local', name: 'Admin2', passwordHash: 'x', isAdmin: true })).id;
    await authStore.setSpaceVisibility(spaceASlug, 'instance');
    try {
      expect((await searchPages('Roadmap', { userId: anyUserId })).some((h) => h.title === 'Roadmap Alpha')).toBe(true);
      expect((await searchPages('Roadmap', { userId: adminId })).some((h) => h.title === 'Roadmap Alpha')).toBe(true);
    } finally {
      await authStore.setSpaceVisibility(spaceASlug, 'private');
    }
  });

  it('pg_trgm catches a typo in the title that a token match would miss', async () => {
    // "Rodmap" is not a token of "Roadmap Alpha" at all (missing the 'a'), so
    // plain tsvector/tsquery matching alone would find nothing here — only
    // title similarity (pg_trgm's `%` operator) can.
    const hits = await searchPages('Rodmap', { userId: memberId });
    expect(hits.some((h) => h.title === 'Roadmap Alpha')).toBe(true);
  });

  it('an empty query returns no hits', async () => {
    const hits = await searchPages('   ', { userId: memberId });
    expect(hits).toEqual([]);
  });
});

describe('search v2 grammar (real PG): phrases, exclusions, tag:, kind:, status:, in:, prop:, operator-only listings, paging, ACL', () => {
  let teardownSchema: () => Promise<void>;
  let owner: User;
  let outsider: User;
  let slug: string;
  let ids: Record<string, string>;

  const search = async (q: string, extra: { userId?: string; limit?: number; offset?: number; space?: string } = {}) =>
    (await searchPages(q, { userId: extra.userId ?? owner.id, space: extra.space ?? slug, limit: extra.limit, offset: extra.offset })).map((h) => h.path);

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    owner = await authStore.createUser({ email: `s2-owner-${stamp}@search-test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    outsider = await authStore.createUser({ email: `s2-outsider-${stamp}@search-test.local`, name: 'Outsider', passwordHash: 'x', isAdmin: false });
    slug = (await storage.createSpace(`Search V2 ${stamp}`, owner.id)).slug;
    await authStore.setMembership(slug, owner.id, 'admin');

    const dir = storage.getSpaceDir(slug);
    const put = async (rel: string, text: string): Promise<void> => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), text, 'utf8');
    };
    await put(
      'docs/alpha.md',
      '---\nstatus: draft\nowner: Ada\nrating: 5\ndone: true\nreviewers: [Bob, Cleo]\ndate: 2026-10-14\ntags: [Team/Core]\n---\n# Alpha plan\n\nRolling update strategy for the cluster. #project/alpha\n',
    );
    await put('docs/beta.md', '---\nstatus: archived\nowner: Grace\nrating: 3\n---\n# Beta notes\n\nAnother cluster note about deploys. #project/beta #projection\n');
    await put('docs/sub/delta.md', '# Delta deep\n\nRolling stones gather no moss, said the cluster. #project\n');
    await put('notes/gamma.md', '# Gamma list\n\nThe cluster again, plain. #inbox\n');
    await put('notes/epsilon.md', '---\nlabels: [Legacy]\n---\n# Epsilon\n\nOld labels note about the cluster.\n');
    await storage.scanSpace(slug);
    await storage.scanSpace(slug);

    ids = {};
    for (const rel of ['docs/alpha.md', 'docs/beta.md', 'docs/sub/delta.md', 'notes/gamma.md', 'notes/epsilon.md']) ids[rel] = (await storage.getEntryIdByExactPath(slug, rel))!;
    // A deterministic "newest first": alpha oldest ... epsilon newest.
    const order = ['docs/alpha.md', 'docs/beta.md', 'docs/sub/delta.md', 'notes/gamma.md', 'notes/epsilon.md'];
    for (const [i, rel] of order.entries()) await query('UPDATE pages_index SET updated_at = $2 WHERE id = $1', [ids[rel], new Date(Date.UTC(2026, 0, 1 + i)).toISOString()]);
  });

  afterAll(async () => {
    await deleteTestSpace(slug);
    await teardownSchema();
  });

  it('plain words are ANDed exactly as before; "or" is just a word', async () => {
    expect(await search('rolling cluster')).toEqual(expect.arrayContaining(['docs/alpha.md', 'docs/sub/delta.md']));
    expect(await search('rolling update')).toEqual(['docs/alpha.md']);
    expect(await search('rolling or update')).toEqual([]);
  });

  it('"a phrase" matches the words in order, adjacent', async () => {
    expect(await search('"rolling update"')).toEqual(['docs/alpha.md']);
    expect(await search('"update rolling"')).toEqual([]);
    expect(await search('"rolling stones" cluster')).toEqual(['docs/sub/delta.md']);
  });

  it('-word and -"phrase" exclude pages that contain them', async () => {
    const all = await search('cluster in:docs/');
    expect(all).toEqual(expect.arrayContaining(['docs/alpha.md', 'docs/beta.md', 'docs/sub/delta.md']));
    expect(await search('cluster in:docs/ -rolling')).toEqual(['docs/beta.md']);
    expect(await search('cluster in:docs/ -"rolling stones"')).toEqual(expect.arrayContaining(['docs/alpha.md', 'docs/beta.md']));
    expect(await search('cluster in:docs/ -"rolling stones"')).not.toContain('docs/sub/delta.md');
    // Exclusion alone lists everything else (here only the space's own root page does not mention the word).
    expect(await search('-cluster')).toEqual(['index.md']);
    expect(await search('in:docs/ -rolling')).toEqual(['docs/beta.md']);
  });

  it('tag: matches the tag and its children, not a longer name; tags AND; front matter tags count, labels: is a synonym', async () => {
    expect((await search('tag:project')).sort()).toEqual(['docs/alpha.md', 'docs/beta.md', 'docs/sub/delta.md']);
    expect(await search('tag:project/alpha')).toEqual(['docs/alpha.md']);
    expect(await search('tag:proj')).toEqual([]);
    expect((await search('tag:projection'))).toEqual(['docs/beta.md']);
    expect(await search('tag:Team/Core')).toEqual(['docs/alpha.md']);
    expect(await search('tag:#project tag:team')).toEqual(['docs/alpha.md']);
    expect(await search('tag:project tag:inbox')).toEqual([]);
    expect(await search('tag:legacy')).toEqual(['notes/epsilon.md']);
    // Words and tag together.
    expect(await search('cluster tag:project')).toEqual(expect.arrayContaining(['docs/beta.md', 'docs/sub/delta.md']));
    expect(await search('rolling tag:project/alpha')).toEqual(['docs/alpha.md']);
  });

  it('kind: and status: filter by equality lists; a page without a status is published', async () => {
    const board = await storage.createPage({ space: slug, parentPath: '', title: 'Sketch board', kind: 'board' });
    try {
      const boards = await searchPages('kind:board', { userId: owner.id, space: slug });
      expect(boards.map((h) => h.id)).toEqual([board.id]);
      expect(boards[0].kind).toBe('board');
      expect(await search('kind:doc,board in:notes/')).toEqual(expect.arrayContaining(['notes/gamma.md', 'notes/epsilon.md']));
      expect(await search('kind:table')).toEqual([]);
    } finally {
      await storage.deletePage(board.id, owner.id);
    }
    expect(await search('status:draft')).toEqual(['docs/alpha.md']);
    expect(await search('status:archived cluster')).toEqual(['docs/beta.md']);
    expect(await search('status:draft,archived')).toEqual(expect.arrayContaining(['docs/alpha.md', 'docs/beta.md']));
    const published = await search('status:published');
    expect(published).toEqual(expect.arrayContaining(['docs/sub/delta.md', 'notes/gamma.md']));
    expect(published).not.toContain('docs/alpha.md');
    expect(published).not.toContain('docs/beta.md');
  });

  it('in: is a folder prefix (a similarly named folder does not match)', async () => {
    expect((await search('in:docs/')).sort()).toEqual(['docs/alpha.md', 'docs/beta.md', 'docs/sub/delta.md']);
    expect(await search('in:docs/sub')).toEqual(['docs/sub/delta.md']);
    expect(await search('in:doc')).toEqual([]);
    expect((await search('in:notes/ in:docs/sub/')).sort()).toEqual(['docs/sub/delta.md', 'notes/epsilon.md', 'notes/gamma.md']);
    expect(await search('cluster in:notes')).toEqual(expect.arrayContaining(['notes/gamma.md', 'notes/epsilon.md']));
  });

  it('prop: matches front matter — text (any case), a number (5 = 5.0), a boolean, a list element, a date — and prop:key tests that the key exists', async () => {
    expect(await search('prop:owner=Ada')).toEqual(['docs/alpha.md']);
    expect(await search('prop:owner=ada')).toEqual(['docs/alpha.md']);
    expect(await search('prop:owner=Ad')).toEqual([]);
    expect(await search('prop:rating=5')).toEqual(['docs/alpha.md']);
    expect(await search('prop:rating=5.0')).toEqual(['docs/alpha.md']);
    expect(await search('prop:rating=3')).toEqual(['docs/beta.md']);
    expect(await search('prop:done=true')).toEqual(['docs/alpha.md']);
    expect(await search('prop:reviewers=bob')).toEqual(['docs/alpha.md']);
    expect(await search('prop:reviewers=Dan')).toEqual([]);
    expect(await search('prop:date=2026-10-14')).toEqual(['docs/alpha.md']);
    expect(await search('prop:date=2026-10-15')).toEqual([]);
    expect((await search('prop:owner')).sort()).toEqual(['docs/alpha.md', 'docs/beta.md']);
    expect(await search('prop:nothing')).toEqual([]);
    expect(await search('prop:owner=Ada rolling')).toEqual(['docs/alpha.md']);
    expect(await search('prop:owner=Ada tag:inbox')).toEqual([]);
  });

  it('a query of operators alone lists the matching pages, most recently changed first', async () => {
    expect(await search('in:docs/')).toEqual(['docs/sub/delta.md', 'docs/beta.md', 'docs/alpha.md']);
    expect(await search('in:notes/')).toEqual(['notes/epsilon.md', 'notes/gamma.md']);
    const hits = await searchPages('in:notes/', { userId: owner.id, space: slug });
    expect(hits[0].snippet).toContain('Epsilon');
  });

  it('hits carry the page kind and its normalized tags (front matter tags and labels included)', async () => {
    const hits = await searchPages('tag:project/alpha', { userId: owner.id, space: slug });
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('doc');
    expect(hits[0].tags).toEqual(['project/alpha', 'team/core']);
    const epsilon = (await searchPages('epsilon', { userId: owner.id, space: slug }))[0];
    expect(epsilon.tags).toEqual(['legacy']);
    const plain = (await searchPages('gamma', { userId: owner.id, space: slug }))[0];
    expect(plain.tags).toEqual(['inbox']);
  });

  it('limit and offset page the results; the cap is 100', async () => {
    const all = await search('in:docs/ in:notes/');
    expect(all).toHaveLength(5);
    expect(await search('in:docs/ in:notes/', { limit: 2 })).toEqual(all.slice(0, 2));
    expect(await search('in:docs/ in:notes/', { limit: 2, offset: 2 })).toEqual(all.slice(2, 4));
    expect(await search('in:docs/ in:notes/', { limit: 2, offset: 4 })).toEqual(all.slice(4));
    expect(await search('in:docs/ in:notes/', { limit: 0 })).toHaveLength(1); // clamped to 1
    expect(clampSearchLimit('500')).toBe(100);
    expect(clampSearchLimit(undefined)).toBe(50);
    expect(clampSearchLimit('abc')).toBe(50);
    expect(clampSearchOffset('-3')).toBe(0);
  });

  it('the ACL still applies to every operator: a restricted page and a non-member are never returned', async () => {
    const secretId = ids['notes/gamma.md'];
    await pageAccess.setAccess(owner, (await storage.getEntry(secretId))!, 'restricted', []);
    try {
      const member = await authStore.createUser({ email: `s2-member-${Date.now()}@search-test.local`, name: 'Member', passwordHash: 'x', isAdmin: false });
      await authStore.setMembership(slug, member.id, 'editor');
      for (const q of ['gamma', 'tag:inbox', 'in:notes/', 'status:published in:notes/', 'kind:doc cluster', 'cluster -rolling', 'prop:owner']) {
        const forMember = await search(q, { userId: member.id });
        expect(forMember, q).not.toContain('notes/gamma.md');
        expect(await search(q, { userId: outsider.id }), q).toEqual([]);
      }
      expect(await search('tag:inbox')).toEqual(['notes/gamma.md']); // the owner still sees it
    } finally {
      await pageAccess.setAccess(owner, (await storage.getEntry(secretId))!, 'space', []);
    }
  });

  it('GET /api/search reads the same grammar and pages with limit and offset; the MCP tools read it too and say so', async () => {
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
    try {
      const auth = { cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(owner.id)).token}` };
      const get = async (q: string, extra = ''): Promise<SearchHit[]> =>
        (await app.inject({ method: 'GET', url: `/api/search?q=${encodeURIComponent(q)}&space=${slug}${extra}`, headers: auth })).json<{ hits: SearchHit[] }>().hits;
      expect((await get('tag:project/alpha')).map((h) => [h.path, h.kind, h.tags])).toEqual([['docs/alpha.md', 'doc', ['project/alpha', 'team/core']]]);
      expect((await get('"rolling update" -stones')).map((h) => h.path)).toEqual(['docs/alpha.md']);
      const all = (await get('in:docs/ in:notes/')).map((h) => h.path);
      expect(all).toHaveLength(5);
      expect((await get('in:docs/ in:notes/', '&limit=2&offset=1')).map((h) => h.path)).toEqual(all.slice(1, 3));
      expect(await get('in:docs/ in:notes/', '&limit=2&offset=99')).toEqual([]);
      expect((await get('in:docs/ in:notes/', '&limit=1000&offset=-5')).map((h) => h.path)).toEqual(all); // clamped
      expect((await app.inject({ method: 'GET', url: `/api/search?q=tag%3Aproject&space=${slug}`, headers: { cookie: 'x=y' } })).statusCode).toBe(401);

      const call = async (name: string, args: Record<string, unknown>) => {
        const actor: McpActor = { user: owner, scopes: ['read'], tokenId: 'search-v2' };
        const server = buildFolioMcpServer(actor);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'test', version: '1.0.0' });
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        try {
          return { result: await client.callTool({ name, arguments: args }), tools: (await client.listTools()).tools };
        } finally {
          await client.close();
        }
      };
      const viaPages = await call('search_pages', { query: 'tag:project -rolling prop:owner=Grace', space: slug });
      expect((viaPages.result.structuredContent as { hits: SearchHit[] }).hits.map((h) => [h.path, h.kind, h.tags])).toEqual([['docs/beta.md', 'doc', ['project/beta', 'projection']]]);
      const viaSearch = await call('search', { query: 'tag:project -rolling prop:owner=Grace' });
      expect((viaSearch.result.structuredContent as { results: Array<{ id: string }> }).results.map((r) => r.id)).toEqual([ids['docs/beta.md']]);
      for (const name of ['search_pages', 'search']) {
        const description = viaPages.tools.find((t) => t.name === name)!.description!;
        for (const op of ['tag:', 'kind:', 'status:', 'in:', 'prop:', '-excluded', '"an exact phrase"']) expect(description, `${name} mentions ${op}`).toContain(op);
      }
    } finally {
      await app.close();
    }
  });

  it('the public reader gets the text grammar and body tags only: prop: is ignored, front matter tags are neither matched nor returned', async () => {
    await authStore.setSpaceVisibility(slug, 'public');
    try {
      const bodyTag = await searchPublicSpace('tag:project/alpha', slug);
      expect(bodyTag.map((h) => h.path)).toEqual(['docs/alpha.md']);
      expect(bodyTag[0].tags).toEqual(['project/alpha']); // `team/core` came from the front matter
      expect(await searchPublicSpace('tag:team/core', slug)).toEqual([]);
      expect(await searchPublicSpace('tag:legacy', slug)).toEqual([]);
      expect((await searchPublicSpace('"rolling update"', slug)).map((h) => h.path)).toEqual(['docs/alpha.md']);
      expect((await searchPublicSpace('cluster -rolling in:docs/', slug)).map((h) => h.path)).toEqual(['docs/beta.md']);
      // prop: names front matter, which the site does not publish: ignored, so it filters nothing.
      expect((await searchPublicSpace('rolling prop:owner=nobody', slug)).map((h) => h.path).sort()).toEqual(['docs/alpha.md', 'docs/sub/delta.md']);
      expect(await searchPublicSpace('   ', slug)).toEqual([]);
    } finally {
      await authStore.setSpaceVisibility(slug, 'private');
    }
  });
});
