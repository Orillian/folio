/**
 * Embedded notes and public wikilinks (wave 2, Obsidian), real PG + real files:
 * GET /api/pages/:id/embed (whole page / heading section / ^block, depth, ACL),
 * GET /api/public/spaces/:slug/pages/:id/embed and /links, and `linkPath` in
 * GET /api/pages/:id/meta. The slicing rules themselves are also pinned
 * without a database (sliceEmbedFragment).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmbedPayload, PublicPageLinks, User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { sliceEmbedFragment, parseEmbedDepth } from './embed.js';
import { HttpError } from './errors.js';
import * as pageAccess from './pageAccess.js';
import { registerPublicSiteRoutes } from './publicSiteRoutes.js';
import { registerRoutes } from './routes.js';
import * as storage from './storage.js';

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

async function buildPublicApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  registerPublicSiteRoutes(app);
  await app.ready();
  return app;
}

const SECTIONS = `# Doc

Top text.

## My Heading

Body of mine.

### Sub Heading

Nested text.

## Other

Other body.

## My Heading

Second mine.
`;

const BLOCKS = `# Blocks

A plain paragraph ^para1

Mixed case paragraph ^Mixed-Id

- item one ^item1
  - nested child
  - nested two
- item two

| a | b |
|---|---|
| 1 | 2 |

^tbl

> quote one
> quote two

^qid

![[pic.png]]^img1

- parent
    - deep ^deep1
        - deeper
`;

describe('embedded notes and public wikilinks (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let owner: User;
  let editor: User;
  let granted: User;
  let outsider: User;
  const spaces: string[] = [];
  let app: FastifyInstance;
  let publicApp: FastifyInstance;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    const mk = (name: string) => authStore.createUser({ email: `embed-${name}-${stamp}@example.com`, name, passwordHash: 'x', isAdmin: false });
    owner = await mk('owner');
    editor = await mk('editor');
    granted = await mk('granted');
    outsider = await mk('outsider');
    app = await buildApp();
    publicApp = await buildPublicApp();
  });
  afterAll(async () => {
    await app.close();
    await publicApp.close();
    for (const slug of spaces) await deleteTestSpace(slug);
    await teardownSchema();
  });

  async function newSpace(name: string) {
    const slug = (await storage.createSpace(`${name} ${Date.now()}`, owner.id)).slug;
    spaces.push(slug);
    await authStore.setMembership(slug, owner.id, 'admin');
    await authStore.setMembership(slug, editor.id, 'editor');
    await authStore.setMembership(slug, granted.id, 'viewer');
    const dir = storage.getSpaceDir(slug);
    return {
      slug,
      put: async (rel: string, text: string) => {
        await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await fs.writeFile(path.join(dir, rel), text, 'utf8');
      },
      id: async (rel: string) => {
        const found = await storage.getEntryIdByExactPath(slug, rel);
        if (!found) throw new Error(`no page ${rel}`);
        return found;
      },
    };
  }

  const cookie = async (user: User) => ({ cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` });
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method: 'GET', url, headers });
    return { status: res.statusCode, body: res.json() as any };
  };
  const getPublic = async (url: string) => {
    const res = await publicApp.inject({ method: 'GET', url });
    return { status: res.statusCode, body: res.json() as any };
  };
  const frag = (f: string) => `fragment=${encodeURIComponent(f)}`;

  describe('GET /api/pages/:id/embed', () => {
    let s: Awaited<ReturnType<typeof newSpace>>;
    const ids: Record<string, string> = {};
    let ownerAuth: Record<string, string>;
    let editorAuth: Record<string, string>;
    let grantedAuth: Record<string, string>;
    let outsiderAuth: Record<string, string>;

    beforeAll(async () => {
      s = await newSpace('Embed ACL');
      await s.put('whole.md', '# Whole\n\nIntro line.\n\nSecond paragraph.\n');
      await s.put('sections.md', SECTIONS);
      await s.put('blocks.md', BLOCKS);
      await s.put('restricted.md', '# Restricted\n\nOnly the granted.\n');
      await s.put('.agent/rules.md', '# Rules\n\nAdmins only.\n');
      await s.put('Folder/Note.md', '# Note\n\n## Head\n\nHead text.\n');
      await s.put('links.md', '# Links\n\nSee [[Folder/Note#Head|alias]], [[Restricted]] and [md](whole.md#whole).\n');
      await storage.scanSpace(s.slug);
      for (const rel of ['whole.md', 'sections.md', 'blocks.md', 'restricted.md', '.agent/rules.md', 'Folder/Note.md', 'links.md']) ids[rel] = await s.id(rel);
      ids.table = (await storage.createPage({ space: s.slug, parentPath: '', title: 'A table', kind: 'table' })).id;
      ids.board = (await storage.createPage({ space: s.slug, parentPath: '', title: 'A board', kind: 'board' })).id;
      await pageAccess.setAccess(owner, (await storage.getEntry(ids['restricted.md']))!, 'restricted', [{ userId: granted.id, role: 'viewer' }]);
      ownerAuth = await cookie(owner);
      editorAuth = await cookie(editor);
      grantedAuth = await cookie(granted);
      outsiderAuth = await cookie(outsider);
    });

    it('no fragment: the whole page body, with the page identity', async () => {
      const res = await get(`/api/pages/${ids['whole.md']}/embed`, editorAuth);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: ids['whole.md'], space: s.slug, path: 'whole.md', title: 'Whole', markdown: '# Whole\n\nIntro line.\n\nSecond paragraph.\n' });
      // a blank fragment is no fragment
      expect((await get(`/api/pages/${ids['whole.md']}/embed?fragment=`, editorAuth)).body.markdown).toBe('# Whole\n\nIntro line.\n\nSecond paragraph.\n');
    });

    it('a heading: its section up to the next heading of the same or a higher level, nested headings included', async () => {
      const section = '## My Heading\n\nBody of mine.\n\n### Sub Heading\n\nNested text.';
      for (const f of ['my-heading', 'My Heading', '#My Heading', 'My%20Heading', 'Doc#My Heading']) {
        const res = await get(`/api/pages/${ids['sections.md']}/embed?${frag(f)}`, editorAuth);
        expect(res.status, f).toBe(200);
        expect(res.body.markdown, f).toBe(section);
      }
      // the second heading with the same text has the outline's `-2` slug
      expect((await get(`/api/pages/${ids['sections.md']}/embed?${frag('my-heading-2')}`, editorAuth)).body.markdown).toBe('## My Heading\n\nSecond mine.');
      // a deeper heading stops at the next heading of ANY smaller-or-equal depth
      expect((await get(`/api/pages/${ids['sections.md']}/embed?${frag('Sub Heading')}`, editorAuth)).body.markdown).toBe('### Sub Heading\n\nNested text.');
      expect((await get(`/api/pages/${ids['sections.md']}/embed?${frag('other')}`, editorAuth)).body.markdown).toBe('## Other\n\nOther body.');
      // the top heading is the whole page
      expect((await get(`/api/pages/${ids['sections.md']}/embed?${frag('doc')}`, editorAuth)).body.markdown).toBe(SECTIONS.trimEnd());
    });

    it('a block: a paragraph, a list item with its children, or the block above an id that stands alone; the id is not in the text', async () => {
      const block = async (f: string) => (await get(`/api/pages/${ids['blocks.md']}/embed?${frag(f)}`, editorAuth)).body.markdown;
      expect(await block('^para1')).toBe('A plain paragraph');
      expect(await block('^Mixed-Id')).toBe('Mixed case paragraph');
      expect(await block('^mixed-id')).toBe('Mixed case paragraph');
      expect(await block('^item1')).toBe('- item one\n  - nested child\n  - nested two');
      expect(await block('^tbl')).toBe('| a | b |\n|---|---|\n| 1 | 2 |');
      expect(await block('^qid')).toBe('> quote one\n> quote two');
      expect(await block('^img1')).toBe('![[pic.png]]');
      // a nested list item comes back at the left edge, its children relative to it
      expect(await block('^deep1')).toBe('- deep\n    - deeper');
    });

    it('a fragment the page does not have is 404 `fragment not found`', async () => {
      for (const f of ['no-such-heading', '^nope', '^', '#']) {
        const res = await get(`/api/pages/${ids['sections.md']}/embed?${frag(f)}`, editorAuth);
        expect(res.status, f).toBe(404);
        expect(res.body, f).toEqual({ error: 'fragment not found' });
      }
    });

    it('depth: absent or 1..3 is fine, above 3 / zero / not a number is 400', async () => {
      for (const d of ['', '1', '2', '3']) {
        expect((await get(`/api/pages/${ids['whole.md']}/embed?depth=${d}`, editorAuth)).status, `depth=${d}`).toBe(200);
      }
      const over = await get(`/api/pages/${ids['whole.md']}/embed?depth=4`, editorAuth);
      expect(over.status).toBe(400);
      expect(over.body).toEqual({ error: 'embed depth limit exceeded' });
      for (const d of ['0', 'abc', '-1', '1.5', '2x']) {
        expect((await get(`/api/pages/${ids['whole.md']}/embed?depth=${d}`, editorAuth)).status, `depth=${d}`).toBe(400);
      }
    });

    it('only documents embed', async () => {
      for (const id of [ids.table, ids.board]) {
        const res = await get(`/api/pages/${id}/embed`, editorAuth);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'only documents can be embedded' });
      }
    });

    it('ACL: the same gate as reading the page - no session 401, no access 403, a restricted page for its granted people only, `.agent` for admins only, a missing page 404', async () => {
      expect((await get(`/api/pages/${ids['whole.md']}/embed`)).status).toBe(401);
      expect((await get(`/api/pages/${ids['whole.md']}/embed`, outsiderAuth)).status).toBe(403);
      expect((await get(`/api/pages/${ids['whole.md']}/embed`, grantedAuth)).status).toBe(200);

      const closed = `/api/pages/${ids['restricted.md']}/embed`;
      expect((await get(closed, editorAuth)).status).toBe(403);
      expect((await get(closed, outsiderAuth)).status).toBe(403);
      const allowed = await get(closed, grantedAuth);
      expect(allowed.status).toBe(200);
      expect(allowed.body.markdown).toBe('# Restricted\n\nOnly the granted.\n');
      expect((await get(closed, ownerAuth)).status).toBe(200);

      const agent = `/api/pages/${ids['.agent/rules.md']}/embed`;
      expect((await get(agent, editorAuth)).status).toBe(404);
      expect((await get(agent, grantedAuth)).status).toBe(404);
      expect((await get(agent, ownerAuth)).status).toBe(200);

      expect((await get('/api/pages/01ARZ3NDEKTSV4RRFFQ69G5FAV/embed', ownerAuth)).status).toBe(404);
    });

    it('/meta carries linkPath - the target as written, without fragment and alias - also for a target the caller cannot read', async () => {
      const links = (await get(`/api/pages/${ids['links.md']}/meta`, editorAuth)).body.links as any[];
      expect(links.find((l) => l.fragment === 'Head')).toMatchObject({ linkPath: 'Folder/Note', syntax: 'wikilink', displayText: 'alias', targetPageId: ids['Folder/Note.md'] });
      expect(links.find((l) => l.linkPath === 'Restricted')).toMatchObject({ kind: 'unresolved', targetPageId: null });
      expect(links.find((l) => l.syntax === 'md')).toMatchObject({ linkPath: 'whole.md', fragment: 'whole' });
      // the owner sees the restricted target resolved, with the same linkPath
      const ownerLinks = (await get(`/api/pages/${ids['links.md']}/meta`, ownerAuth)).body.links as any[];
      expect(ownerLinks.find((l) => l.linkPath === 'Restricted')).toMatchObject({ kind: 'page', targetPageId: ids['restricted.md'] });
    });
  });

  describe('public site: /embed and /links', () => {
    let pub: Awaited<ReturnType<typeof newSpace>>;
    let other: Awaited<ReturnType<typeof newSpace>>;
    let priv: Awaited<ReturnType<typeof newSpace>>;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      pub = await newSpace('Embed Pub');
      other = await newSpace('Embed Other');
      priv = await newSpace('Embed Priv');
      await pub.put('index.md', '# Home\n\nWelcome.\n');
      await pub.put('open.md', '# Open\n\n## Part\n\nPart text ^pb\n\n## After\n\nAfter text.\n');
      await pub.put('closed.md', '# Closed\n\nClosed text.\n');
      await pub.put('page.md', '# Page\n\nLinks: [[Open#Part]], [[Closed]], [[Ghost]] and ![[Open#^pb]].\n');
      await pub.put('.agent/rules.md', '# Rules\n\nAgent text.\n');
      await pub.put('_templates/tpl.md', '# Template\n\nTemplate text.\n');
      await other.put('elsewhere.md', '# Elsewhere\n\nOther space.\n');
      await priv.put('hidden.md', '# Hidden\n\nPrivate space.\n');
      for (const sp of [pub, other, priv]) await storage.scanSpace(sp.slug);
      for (const rel of ['index.md', 'open.md', 'closed.md', 'page.md', '.agent/rules.md', '_templates/tpl.md']) ids[rel] = await pub.id(rel);
      ids.elsewhere = await other.id('elsewhere.md');
      ids.hidden = await priv.id('hidden.md');
      ids.table = (await storage.createPage({ space: pub.slug, parentPath: '', title: 'Pub table', kind: 'table' })).id;
      await pageAccess.setAccess(owner, (await storage.getEntry(ids['closed.md']))!, 'restricted', []);
      await authStore.setSpaceVisibility(pub.slug, 'public');
      await authStore.setSpaceVisibility(other.slug, 'public');
    });

    it('anonymous: a public page embeds whole, as a heading section and as a block', async () => {
      const whole = await getPublic(`/api/public/spaces/${pub.slug}/pages/${ids['open.md']}/embed`);
      expect(whole.status).toBe(200);
      expect(whole.body).toEqual({ id: ids['open.md'], space: pub.slug, path: 'open.md', title: 'Open', markdown: '# Open\n\n## Part\n\nPart text ^pb\n\n## After\n\nAfter text.\n' });
      const section = await getPublic(`/api/public/spaces/${pub.slug}/pages/${ids['open.md']}/embed?${frag('Part')}&depth=2`);
      expect(section.status).toBe(200);
      expect(section.body.markdown).toBe('## Part\n\nPart text ^pb');
      expect((await getPublic(`/api/public/spaces/${pub.slug}/pages/${ids['open.md']}/embed?${frag('^pb')}`)).body.markdown).toBe('Part text');
      const missing = await getPublic(`/api/public/spaces/${pub.slug}/pages/${ids['open.md']}/embed?${frag('nope')}`);
      expect(missing).toEqual({ status: 404, body: { error: 'fragment not found' } });
      expect((await getPublic(`/api/public/spaces/${pub.slug}/pages/${ids['open.md']}/embed?depth=4`)).status).toBe(400);
      expect((await getPublic(`/api/public/spaces/${pub.slug}/pages/${ids.table}/embed`)).status).toBe(400); // a public table is not a document
    });

    it('everything that is not a public page of THIS space answers the same 404 `page not found`', async () => {
      const closedIds = [ids['closed.md'], ids['.agent/rules.md'], ids['_templates/tpl.md'], ids.elsewhere, ids.hidden, 'dir:Folder', '01ARZ3NDEKTSV4RRFFQ69G5FAV'];
      for (const id of closedIds) {
        for (const tail of ['embed', 'links']) {
          expect(await getPublic(`/api/public/spaces/${pub.slug}/pages/${encodeURIComponent(id)}/${tail}`), `${id} ${tail}`).toEqual({ status: 404, body: { error: 'page not found' } });
        }
      }
    });

    it('a space that is not public is 404 `space not found`, for both routes', async () => {
      for (const slug of [priv.slug, 'no-such-space']) {
        for (const tail of ['embed', 'links']) {
          expect(await getPublic(`/api/public/spaces/${slug}/pages/${ids.hidden}/${tail}`), `${slug} ${tail}`).toEqual({ status: 404, body: { error: 'space not found' } });
        }
      }
    });

    it('/links: wikilinks to public pages are resolved, to a restricted page or nothing are unresolved; the payload is only `links`', async () => {
      const res = await getPublic(`/api/public/spaces/${pub.slug}/pages/${ids['page.md']}/links`);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['links']);
      const links = (res.body as PublicPageLinks).links;
      expect(links.map((l) => l.linkPath)).toEqual(['Open', 'Closed', 'Ghost', 'Open']);
      expect(links[0]).toMatchObject({ syntax: 'wikilink', kind: 'page', targetPageId: ids['open.md'], fragment: 'Part', fragmentKind: 'heading', fragmentResolved: true });
      expect(links[1]).toMatchObject({ syntax: 'wikilink', kind: 'unresolved', targetPageId: null, fragmentResolved: null });
      expect(links[2]).toMatchObject({ kind: 'unresolved', targetPageId: null });
      expect(links[3]).toMatchObject({ syntax: 'embed', kind: 'page', targetPageId: ids['open.md'], fragment: '^pb', fragmentKind: 'block', fragmentResolved: true });
      // the restricted page's id does not appear anywhere in the response
      expect(JSON.stringify(res.body)).not.toContain(ids['closed.md']);
      // a page without links
      expect((await getPublic(`/api/public/spaces/${pub.slug}/pages/${ids['index.md']}/links`)).body).toEqual({ links: [] });
    });

    it('a page that becomes restricted stops embedding anonymously', async () => {
      const entry = (await storage.getEntry(ids['open.md']))!;
      await pageAccess.setAccess(owner, entry, 'restricted', []);
      try {
        expect((await getPublic(`/api/public/spaces/${pub.slug}/pages/${ids['open.md']}/embed`)).status).toBe(404);
        const links = (await getPublic(`/api/public/spaces/${pub.slug}/pages/${ids['page.md']}/links`)).body as PublicPageLinks;
        expect(links.links.find((l) => l.linkPath === 'Open')).toMatchObject({ kind: 'unresolved', targetPageId: null });
      } finally {
        await pageAccess.setAccess(owner, entry, 'space', []);
      }
      expect((await getPublic(`/api/public/spaces/${pub.slug}/pages/${ids['open.md']}/embed`)).status).toBe(200);
    });
  });
});

describe('sliceEmbedFragment (pure)', () => {
  const notFoundAt = (body: string, fragment: string) => {
    try {
      sliceEmbedFragment(body, fragment);
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(404);
      expect((err as HttpError).message).toBe('fragment not found');
      return;
    }
    throw new Error(`expected 404 for ${fragment}`);
  };

  it('no fragment returns the body untouched, including its final newline', () => {
    expect(sliceEmbedFragment('# A\n\ntext\n', null)).toBe('# A\n\ntext\n');
    expect(sliceEmbedFragment('# A\n\ntext\n', '  ')).toBe('# A\n\ntext\n');
    expect(sliceEmbedFragment('', null)).toBe('');
  });

  it('a heading inside a code fence is not a heading; a quoted heading still counts for the slugs', () => {
    const body = '# A\n\n```\n## Not a heading\n```\n\n## Real\n\ntext\n';
    notFoundAt(body, 'not-a-heading');
    expect(sliceEmbedFragment(body, 'real')).toBe('## Real\n\ntext');
    expect(sliceEmbedFragment(body, 'a')).toBe(body.trimEnd());
  });

  it('setext headings, Cyrillic headings and CRLF line endings', () => {
    const setext = 'Title\n=====\n\nIntro\n\nSub\n---\n\nunder sub\n';
    expect(sliceEmbedFragment(setext, 'sub')).toBe('Sub\n---\n\nunder sub');
    expect(sliceEmbedFragment('# \u041f\u0440\u0438\u0432\u0456\u0442\n\n\u0442\u0435\u043a\u0441\u0442\n\n# \u0414\u0430\u043b\u0456\n\n\u0449\u0435\n', '\u041f\u0440\u0438\u0432\u0456\u0442')).toBe('# \u041f\u0440\u0438\u0432\u0456\u0442\n\n\u0442\u0435\u043a\u0441\u0442');
    expect(sliceEmbedFragment('# A\r\n\r\n## B\r\n\r\nbee\r\n\r\n## C\r\n', 'b')).toBe('## B\r\n\r\nbee');
  });

  it('a block id: a paragraph in a quote, a later paragraph of a list item, the first paragraph of an item, a quote above an id', () => {
    expect(sliceEmbedFragment('> a quoted line ^q1\n', '^q1')).toBe('a quoted line');
    expect(sliceEmbedFragment('> first\n> second ^q2\n', '^q2')).toBe('first\nsecond');
    expect(sliceEmbedFragment('- item\n\n  second paragraph ^later\n', '^later')).toBe('second paragraph');
    expect(sliceEmbedFragment('1. numbered ^n1\n2. next\n', '^n1')).toBe('1. numbered');
    expect(sliceEmbedFragment('- [ ] task ^t1\n', '^t1')).toBe('- [ ] task');
    // the id stands alone under a list: the whole list
    expect(sliceEmbedFragment('- a\n- b\n\n^lst\n', '^lst')).toBe('- a\n- b');
    // a code block above an id
    expect(sliceEmbedFragment('```js\nlet x = 1;\n```\n\n^code\n', '^code')).toBe('```js\nlet x = 1;\n```');
    // an id with nothing above it names nothing
    notFoundAt('^lonely\n', '^lonely');
    notFoundAt('# H\n\ntext ^other\n', '^missing');
  });

  it('a `^id` in the middle of a paragraph or inside code is not a block', () => {
    notFoundAt('text ^mid and more\n', '^mid');
    notFoundAt('```\ncode ^incode\n```\n', '^incode');
  });

  it('parseEmbedDepth', () => {
    expect(parseEmbedDepth('')).toBe(1);
    expect(parseEmbedDepth(undefined)).toBe(1);
    expect(parseEmbedDepth(' 3 ')).toBe(3);
    expect(() => parseEmbedDepth('4')).toThrow('embed depth limit exceeded');
    for (const bad of ['0', 'x', '-2', '1.5', '99999999999999999999']) expect(() => parseEmbedDepth(bad), bad).toThrow(HttpError);
  });
});

describe('block embed of a callout', () => {
  it('gives the whole callout, marker included, not the bare paragraph', () => {
    const body = '# Doc\n\nintro\n\n> [!hint] Tip title\n> the body ^tip1\n\nafter\n';
    expect(sliceEmbedFragment(body, '^tip1')).toBe('> [!hint] Tip title\n> the body');
    const single = 'x\n\n> [!hint] one line ^h2\n';
    expect(sliceEmbedFragment(single, '^h2')).toBe('> [!hint] one line');
  });
});
