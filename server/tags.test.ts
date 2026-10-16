/**
 * Tags of a space (Obsidian brief wave 3), real PG + real files + a real git repo:
 * the pages of a tag (hierarchy, ACL), and the space-wide rename — body tokens and
 * front matter rewritten in place, one commit, the index rebuilt, pages the caller
 * cannot edit skipped and counted.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { RenameTagResult, SpaceTagsResponse, TagPagesResponse, User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as collab from './collab.js';
import * as session from './auth/session.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { parsePageMeta } from './indexV2/parse.js';
import * as pageAccess from './pageAccess.js';
import { registerRoutes } from './routes.js';
import { searchPages } from './search.js';
import * as storage from './storage.js';
import { findBodyTagTokens, renameTagInBody, renameTagInFrontmatter } from './tags.js';
import { registerTagRoutes } from './tagsRoutes.js';

const sh = promisify(execFile);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if ((err as { validation?: unknown }).validation) return reply.status(400).send({ error: (err as Error).message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(async (scope) => {
    scope.addHook('onRequest', session.requireSession);
    registerRoutes(scope);
    registerTagRoutes(scope);
  });
  await app.ready();
  return app;
}

describe('renameTagInBody (pure)', () => {
  it('replaces each indexed #tag token under the tag in place and nothing else', () => {
    const body = '# Title\n\nSee #work and #Work/Alpha, then #workflow and #network, a #work/alpha/sub: end.\r\nLast line #work';
    const out = renameTagInBody(body, 'work', 'projects');
    expect(out.renamed).toBe(4);
    expect(out.body).toBe('# Title\n\nSee #projects and #projects/Alpha, then #workflow and #network, a #projects/alpha/sub: end.\r\nLast line #projects');
  });

  it('keeps a trailing slash and the case of what follows the prefix; a messy token is normalized', () => {
    expect(renameTagInBody('a #Work/Deep/Sub b #work/ c', 'work', 'x').body).toBe('a #x/Deep/Sub b #x/ c');
    expect(renameTagInBody('#work//a', 'work', 'x').body).toBe('#x/a');
  });

  it('never touches code, links, html, escapes, a word that merely contains #, or a hex colour', () => {
    const body = [
      'real #work',
      '',
      '`#work in code` and [link #work](https://x.io/#work) and <span title="#work">#work</span> and \\#work and C#work and http://x.io/#work',
      '',
      '```',
      '#work in a fence',
      '```',
      '',
      '    #work in an indented block',
      '',
      '[ref #work][r]',
      '',
      '[r]: https://x.io/#work',
    ].join('\n');
    const out = renameTagInBody(body, 'work', 'x');
    expect(out.renamed).toBe(1);
    expect(out.body).toBe(body.replace('real #work', 'real #x'));
  });

  it('finds exactly the tags the page parser indexes (guard against the two rules drifting apart)', () => {
    const bodies = [
      '# H\n\n#a #B/c text #d_e-f\n',
      'x #1 #123 #fff #a1b2c3 #beef #e0e0e0 y',
      '`#c` and ```#d``` \\#e &#35;f #g\n\n```\n#h\n```\n\n    #i\n',
      '[#a](u) [b #b](u) ![#c](u) <b>#d</b> <https://x.io/#e> https://x.io/#f #ok',
      '| #cell | b |\n|---|---|\n| #x | #y/z |\n\n- #list\n  - #nested\n\n> #quote\n',
      '## Heading #intag\n\n#nospace-heading\n\n#Ünï/çode ok\n',
      'a#b a #b#c #d/ /#e #/f\n',
    ];
    for (const body of bodies) {
      const indexed = parsePageMeta(body, null).tags.map((t) => t.tag);
      expect(findBodyTagTokens(body).map((t) => t.tag), body).toEqual(indexed);
    }
  });
});

describe('renameTagInFrontmatter (pure)', () => {
  const doc = (fm: string): string => `---\n${fm}\n---\n# Page\n\nBody #work stays for the body renamer.\n`;

  it('renames in a flow list, keeping every other line and the body byte for byte', () => {
    const raw = doc('title: Keep me   # a comment\ntags: [Work, ideas, work/alpha]\nowner: Ada');
    expect(renameTagInFrontmatter(raw, 'work', 'projects')).toBe(doc('title: Keep me   # a comment\ntags: [projects, ideas, projects/alpha]\nowner: Ada'));
  });

  it('renames only the changed items of a block list, comments and quoting of the others kept', () => {
    const raw = doc('tags:\n  - Work/Beta   # why\n  - "other"   # untouched\n  - "#work"\nowner: Ada');
    expect(renameTagInFrontmatter(raw, 'work', 'projects')).toBe(doc('tags:\n  - projects/Beta   # why\n  - "other"   # untouched\n  - "#projects"\nowner: Ada'));
  });

  it('renames in a comma / space separated string', () => {
    expect(renameTagInFrontmatter(doc('tags: work, personal'), 'work', 'x')).toBe(doc('tags: x, personal'));
    expect(renameTagInFrontmatter(doc('tags: "work personal"'), 'work', 'x')).toBe(doc('tags: "x personal"'));
  });

  it('a labels: entry is renamed in place under labels:, with its own style, other keys untouched', () => {
    expect(renameTagInFrontmatter(doc('title: T\nlabels: [Work, ideas]\nowner: Ada'), 'work', 'x')).toBe(doc('title: T\nlabels: [x, ideas]\nowner: Ada'));
    expect(renameTagInFrontmatter(doc('labels:\n  - Work/Sub   # why\n  - other\nowner: Ada'), 'work', 'x')).toBe(doc('labels:\n  - x/Sub   # why\n  - other\nowner: Ada'));
    expect(renameTagInFrontmatter(doc('labels: work, z'), 'work', 'x')).toBe(doc('labels: x, z'));
    expect(renameTagInFrontmatter(doc('labels: "work z"'), 'work', 'x')).toBe(doc('labels: "x z"'));
    // An empty tags: stays as it is.
    expect(renameTagInFrontmatter(doc('tags:\nlabels: [work]'), 'work', 'x')).toBe(doc('tags:\nlabels: [x]'));
  });

  it('with both keys each is renamed in place; a key without the tag is not touched, labels: is never moved or removed', () => {
    expect(renameTagInFrontmatter(doc('labels: [work]\ntags: [keep]'), 'work', 'x')).toBe(doc('labels: [x]\ntags: [keep]'));
    expect(renameTagInFrontmatter(doc('tags: [work]\nlabels: [Work/Sub, other]'), 'work', 'x')).toBe(doc('tags: [x]\nlabels: [x/Sub, other]'));
    expect(renameTagInFrontmatter(doc('tags:\n  - a   # c1\n  - work\nowner: Ada\nlabels:\n  - Work/Sub\n  - other'), 'work', 'x')).toBe(
      doc('tags:\n  - a   # c1\n  - x\nowner: Ada\nlabels:\n  - x/Sub\n  - other'),
    );
    // Only one of the keys holds the tag: the other one stays byte for byte.
    expect(renameTagInFrontmatter(doc('tags: [work]\nlabels: [other]'), 'work', 'x')).toBe(doc('tags: [x]\nlabels: [other]'));
    expect(renameTagInFrontmatter(doc('tags: [keep]\nlabels: work'), 'work', 'x')).toBe(doc('tags: [keep]\nlabels: x'));
    expect(renameTagInFrontmatter(doc('tags: [a, b]\nlabels: [x, y]\neffort: 3'), 'a', 'z')).toBe(doc('tags: [z, b]\nlabels: [x, y]\neffort: 3'));
    // No rename in this page: nothing is touched.
    expect(renameTagInFrontmatter(doc('labels: [keep]\ntags: [also]'), 'work', 'x')).toBeUndefined();
    expect(renameTagInFrontmatter(doc('labels: [keep]'), 'work', 'x')).toBeUndefined();
    expect(renameTagInFrontmatter('---\r\ntags: [a]\r\nlabels: [work]\r\n---\r\n# P\r\n', 'work', 'x')).toBe('---\r\ntags: [a]\r\nlabels: [x]\r\n---\r\n# P\r\n');
  });

  it('keeps CRLF', () => {
    const raw = '---\r\ntags: [work]\r\nowner: Ada\r\n---\r\n# P\r\n';
    expect(renameTagInFrontmatter(raw, 'work', 'x')).toBe('---\r\ntags: [x]\r\nowner: Ada\r\n---\r\n# P\r\n');
  });

  it('leaves a file alone when nothing is under the tag, there is no block, or the block is not YAML', () => {
    expect(renameTagInFrontmatter(doc('tags: [workflow, network]'), 'work', 'x')).toBeUndefined();
    expect(renameTagInFrontmatter('# No front matter #work\n', 'work', 'x')).toBeUndefined();
    expect(renameTagInFrontmatter('---\ntags: [work\nbroken: : :\n---\nbody\n', 'work', 'x')).toBeUndefined();
    expect(renameTagInFrontmatter(doc('title: x'), 'work', 'x')).toBeUndefined();
  });
});

describe('tag pages and the space-wide rename (real PG, real git)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let owner: User; // space admin
  let editor: User;
  let viewer: User;
  let outsider: User;
  let ownerAuth: { cookie: string };
  let editorAuth: { cookie: string };
  let viewerAuth: { cookie: string };
  let outsiderAuth: { cookie: string };
  let slug: string;
  let dir: string;
  let repoDir: string;
  const before: Record<string, string> = {};

  const read = (rel: string): Promise<string> => fs.readFile(path.join(dir, rel), 'utf8');
  const git = async (...args: string[]): Promise<string> => (await sh('git', ['-C', repoDir, ...args])).stdout;
  const cookieOf = async (user: User): Promise<{ cookie: string }> => ({ cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` });
  const tagPages = async (tag: string, auth = editorAuth, qs = ''): Promise<{ status: number; body: TagPagesResponse }> => {
    const res = await app.inject({ method: 'GET', url: `/api/spaces/${slug}/tags/${tag}/pages${qs}`, headers: auth });
    return { status: res.statusCode, body: res.json<TagPagesResponse>() };
  };
  const rename = (from: string, to: string, auth = editorAuth) =>
    app.inject({ method: 'POST', url: `/api/spaces/${slug}/tags/rename`, headers: auth, payload: { from, to } });

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    app = await buildApp();
    const stamp = Date.now();
    const mk = (n: string, admin = false) => authStore.createUser({ email: `${n}-${stamp}@tags-test.local`, name: n, passwordHash: 'x', isAdmin: admin });
    owner = await mk('Owner');
    editor = await mk('Editor');
    viewer = await mk('Viewer');
    outsider = await mk('Outsider');
    ownerAuth = await cookieOf(owner);
    editorAuth = await cookieOf(editor);
    viewerAuth = await cookieOf(viewer);
    outsiderAuth = await cookieOf(outsider);

    slug = (await storage.createSpace(`Tags Test ${stamp}`, owner.id)).slug;
    await authStore.setMembership(slug, owner.id, 'admin');
    await authStore.setMembership(slug, editor.id, 'editor');
    await authStore.setMembership(slug, viewer.id, 'viewer');
    dir = storage.getSpaceDir(slug);
    repoDir = storage.getRepoDir(slug);

    const put = async (rel: string, text: string): Promise<void> => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), text, 'utf8');
    };
    await put(
      'a.md',
      '# Alpha\n\nIntro #Work/Alpha and #work, then #work/alpha/sub: end.\n\n`#work in code` and [link #work](https://x.io/#work) and \\#work and C#work.\n\n```\n#work in a fence\n```\n\nLast line, no trailing newline #work',
    );
    await put('b.md', '---\ntitle: Bee\ntags: [Work, ideas]   # kept\nowner: Ada\n---\n# Bee\n\nNo tags in the body.\n');
    await put('c.md', '---\ntags:\n  - Work/Beta   # keep this comment\n  - other\nlabels: work\n---\n# Cee\n\nBody #WORK and #workflow.\n');
    await put('d.md', '---\ntags: "work, personal"\n---\n# Dee\n\n#personal only in the body\n');
    await put('crlf.md', '---\r\ntags: [work]\r\n---\r\n# Crlf\r\n\r\nText #work end\r\n');
    await put('h.md', '# Haystack\n\n#workflow and #network and #homework are different tags.\n');
    await put('_templates/t.md', '# Template\n\n#work\n');
    await put('hidden.md', '# Hidden\n\nA restricted page #work\n');
    await put('readonly.md', '# Read only\n\nGranted as viewer #work\n');
    await put('uk.md', '# Укр\n\nТекст #Проєкт/Альфа і #проєкт тут, а #проєктний — інший тег.\n');
    await put('lab1.md', '---\nlabels: [Legacy, keepme]\n---\n# Lab one\n\nBody.\n');
    await put('lab2.md', '---\nlabels:\n  - Legacy/Sub   # why\n  - other\n---\n# Lab two\n\nBody #legacy here.\n');
    await put('lab3.md', '---\ntags: [keepme, Legacy]\nlabels: [Legacy, Legacy/new, other]\n---\n# Lab three\n');
    await put('lab4.md', '---\ntags: [legacy]\nlabels: [other]\n---\n# Lab four\n');
    await put('lab5.md', '---\nlabels: [keep, other]\ntags: [also]\n---\n# Lab five, no legacy tag\n');
    await put('live.md', '---\ntags: [liveword]\n---\n# Live\n\nText #liveword and more #liveword/sub\n');
    await put('.agent/notes.md', '# Agent notes\n\n#work in an admin-only page\n');
    await storage.scanSpace(slug);
    await storage.scanSpace(slug); // settles the ids the first scan stamped into the files

    const idOf = async (rel: string): Promise<string> => (await storage.getEntryIdByExactPath(slug, rel))!;
    await pageAccess.setAccess(owner, (await storage.getEntry(await idOf('hidden.md')))!, 'restricted', []);
    await pageAccess.setAccess(owner, (await storage.getEntry(await idOf('readonly.md')))!, 'restricted', [{ userId: editor.id, role: 'viewer' }]);
    await sh('git', ['-C', repoDir, 'add', '-A']);
    await sh('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixtures', '--allow-empty']);
    for (const rel of ['a.md', 'b.md', 'c.md', 'd.md', 'crlf.md', 'h.md', '_templates/t.md', 'hidden.md', 'readonly.md', '.agent/notes.md']) before[rel] = await read(rel);
  });

  afterAll(async () => {
    await app.close();
    await deleteTestSpace(slug);
    await teardownSchema();
  });

  // The renames below build on each other, in this order.

  it('lists the pages of a tag and of its children, visible to the caller only; templates and .agent are not listed for an editor', async () => {
    const work = await tagPages('work');
    expect(work.status).toBe(200);
    expect(work.body.tag).toBe('work');
    // readonly.md is restricted, but the editor holds a viewer grant on it; hidden.md, the template and .agent are not theirs to see.
    expect(work.body.pages.map((p) => p.path)).toEqual(['a.md', 'b.md', 'c.md', 'crlf.md', 'd.md', 'readonly.md']);
    expect(work.body.total).toBe(6);
    expect(work.body.pages.find((p) => p.path === 'a.md')!.sources).toEqual(['body']);
    expect(work.body.pages.find((p) => p.path === 'b.md')!.sources).toEqual(['frontmatter']);
    expect(work.body.pages.find((p) => p.path === 'c.md')!.sources).toEqual(['body', 'frontmatter']);

    // The child tag lists only its own pages; the same answer however the tag is spelled in the URL.
    const alpha = await tagPages('work%2Falpha');
    expect(alpha.body.pages.map((p) => p.path)).toEqual(['a.md']);
    expect((await tagPages('work/alpha')).body.pages.map((p) => p.path)).toEqual(['a.md']);
    expect((await tagPages('%23Work%2FAlpha')).body.tag).toBe('work/alpha');
    expect((await tagPages('wor')).body.pages).toEqual([]);

    // The space admin also sees the restricted page they own and .agent; the viewer sees what an editor sees.
    expect((await tagPages('work', ownerAuth)).body.pages.map((p) => p.path)).toEqual(['.agent/notes.md', 'a.md', 'b.md', 'c.md', 'crlf.md', 'd.md', 'hidden.md', 'readonly.md']);
    expect((await tagPages('work', viewerAuth)).body.pages.map((p) => p.path)).toEqual(['a.md', 'b.md', 'c.md', 'crlf.md', 'd.md']);
    expect(work.body.pages.map((p) => p.path)).not.toContain('hidden.md');
  });

  it('pages the tag list: limit and offset, total unchanged', async () => {
    const first = await tagPages('work', editorAuth, '?limit=2');
    expect(first.body.pages.map((p) => p.path)).toEqual(['a.md', 'b.md']);
    expect(first.body.total).toBe(6);
    expect((await tagPages('work', editorAuth, '?limit=2&offset=4')).body.pages.map((p) => p.path)).toEqual(['d.md', 'readonly.md']);
  });

  it('guards: an outsider is refused, a missing space is 404, a path that is not .../pages is 404', async () => {
    expect((await tagPages('work', outsiderAuth)).status).toBe(403);
    const ghost = await app.inject({ method: 'GET', url: '/api/spaces/no-such-space/tags/work/pages', headers: editorAuth });
    expect(ghost.statusCode).toBe(404);
    const notPages = await app.inject({ method: 'GET', url: `/api/spaces/${slug}/tags/work/nonsense`, headers: editorAuth });
    expect(notPages.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/spaces/${slug}/tags/work/pages` })).statusCode).toBe(401);
  });

  it('rename is refused for a viewer, an outsider, a read-scope token, a bad body, and for the same tag', async () => {
    expect((await rename('work', 'x', viewerAuth)).statusCode).toBe(403);
    expect((await rename('work', 'x', outsiderAuth)).statusCode).toBe(403);
    const readPat = await authStore.createApiToken(editor.id, 'read', ['read']);
    const refused = await app.inject({ method: 'POST', url: `/api/spaces/${slug}/tags/rename`, headers: { authorization: `Bearer ${readPat.token}` }, payload: { from: 'work', to: 'x' } });
    expect(refused.statusCode).toBe(403);
    expect((await rename('work', '#x')).statusCode).toBe(400);
    expect((await rename('work', '')).statusCode).toBe(400);
    expect((await rename('work', '123')).statusCode).toBe(400);
    expect((await rename('#Work', 'work')).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/spaces/${slug}/tags/rename`, headers: editorAuth, payload: {} })).statusCode).toBe(400);
    // Nothing happened.
    expect(await read('a.md')).toBe(before['a.md']);
  });

  it('renames #work -> #projects across bodies and front matter: byte-preserving, one commit, skipped pages counted, index rebuilt', async () => {
    const commitsBefore = Number((await git('rev-list', '--count', 'HEAD')).trim());
    const res = await rename('#Work', 'Projects');
    expect(res.statusCode).toBe(200);
    // a, b, c, d, crlf, and the template are changed; readonly (viewer grant) is skipped and counted; hidden (no access) and .agent are untouched and NOT counted.
    expect(res.json<RenameTagResult>()).toEqual({ pagesChanged: 6, pagesSkipped: 1 });

    // Bodies: tokens only.
    expect(await read('a.md')).toBe(
      before['a.md']
        .replace('#Work/Alpha and #work, then #work/alpha/sub: end', '#projects/Alpha and #projects, then #projects/alpha/sub: end')
        .replace('Last line, no trailing newline #work', 'Last line, no trailing newline #projects'),
    );
    expect(await read('a.md')).toContain('`#work in code` and [link #work](https://x.io/#work) and \\#work and C#work.');
    expect(await read('a.md')).toContain('```\n#work in a fence\n```');
    expect((await read('a.md')).endsWith('\n')).toBe(before['a.md'].endsWith('\n')); // the last byte is as it was

    // Front matter: only the tag items change; the rest of the block, comments included, is the same bytes.
    expect(await read('b.md')).toBe(before['b.md'].replace('tags: [Work, ideas]   # kept', 'tags: [projects, ideas]   # kept'));
    expect(await read('c.md')).toBe(
      // labels: (the synonym of tags:) is renamed in place under its own key, never moved.
      before['c.md']
        .replace('  - Work/Beta   # keep this comment\n  - other\nlabels: work\n', '  - projects/Beta   # keep this comment\n  - other\nlabels: projects\n')
        .replace('Body #WORK and #workflow.', 'Body #projects and #workflow.'),
    );
    expect(await read('d.md')).toBe(before['d.md'].replace('tags: "work, personal"', 'tags: "projects, personal"'));
    expect(await read('crlf.md')).toBe(before['crlf.md'].replace('tags: [work]', 'tags: [projects]').replace('Text #work end', 'Text #projects end'));
    expect(await read('_templates/t.md')).toBe(before['_templates/t.md'].replace('#work', '#projects'));

    // Untouched: another tag with the same letters, the pages the caller cannot edit, .agent.
    expect(await read('h.md')).toBe(before['h.md']);
    expect(await read('hidden.md')).toBe(before['hidden.md']);
    expect(await read('readonly.md')).toBe(before['readonly.md']);
    expect(await read('.agent/notes.md')).toBe(before['.agent/notes.md']);

    // ONE commit, of exactly the changed files, under the agreed message.
    expect(Number((await git('rev-list', '--count', 'HEAD')).trim())).toBe(commitsBefore + 1);
    expect((await git('log', '-1', '--format=%s')).trim()).toBe('docs: rename tag #work -> #projects');
    expect((await git('show', '--name-only', '--format=', 'HEAD')).split('\n').filter(Boolean).sort()).toEqual(['_templates/t.md', 'a.md', 'b.md', 'c.md', 'crlf.md', 'd.md']);
    expect((await git('log', '-1', '--format=%an')).trim()).toBe('Editor');

    // The index follows: /tags shows the new tag (children included) and no old one for pages the editor reads; search finds it.
    const tags = (await app.inject({ method: 'GET', url: `/api/spaces/${slug}/tags`, headers: editorAuth })).json<SpaceTagsResponse>().tags;
    expect(tags.find((t) => t.tag === 'projects')?.pages).toBe(5);
    expect(tags.find((t) => t.tag === 'projects/alpha')?.pages).toBe(1);
    expect(tags.find((t) => t.tag === 'projects/beta')?.pages).toBe(1);
    expect(tags.find((t) => t.tag === 'work')?.pages).toBe(1); // readonly.md (hidden.md and .agent are not the editor's to see)
    expect(tags.some((t) => t.tag === 'workflow')).toBe(true);
    expect((await tagPages('projects')).body.pages.map((p) => p.path)).toEqual(['a.md', 'b.md', 'c.md', 'crlf.md', 'd.md']);
    expect((await searchPages('tag:projects/alpha', { userId: editor.id, space: slug })).map((h) => h.path)).toEqual(['a.md']);
    expect((await searchPages('tag:work', { userId: editor.id, space: slug })).map((h) => h.path)).toEqual(['readonly.md']);
    const rows = await query<{ tag: string; source: string }>(`SELECT tag, source FROM page_tags t JOIN pages_index p ON p.id = t.page_id WHERE p.space_slug = $1 AND p.path = 'b.md'`, [slug]);
    expect(rows.map((r) => `${r.tag}:${r.source}`).sort()).toEqual(['ideas:frontmatter', 'projects:frontmatter']);

    // Renaming it again finds nothing: no change, no commit.
    const again = await rename('work', 'projects');
    expect(again.json<RenameTagResult>()).toEqual({ pagesChanged: 0, pagesSkipped: 1 });
    expect(Number((await git('rev-list', '--count', 'HEAD')).trim())).toBe(commitsBefore + 1);
  });

  it('a space admin also renames in .agent and in restricted pages they own; the audit trail records the rename', async () => {
    const commitsBefore = Number((await git('rev-list', '--count', 'HEAD')).trim());
    const res = await rename('work', 'projects', ownerAuth);
    expect(res.json<RenameTagResult>()).toEqual({ pagesChanged: 3, pagesSkipped: 0 });
    expect(await read('.agent/notes.md')).toBe(before['.agent/notes.md'].replace('#work', '#projects'));
    expect(await read('hidden.md')).toBe(before['hidden.md'].replace('#work', '#projects'));
    expect(await read('readonly.md')).toBe(before['readonly.md'].replace('#work', '#projects'));
    expect(Number((await git('rev-list', '--count', 'HEAD')).trim())).toBe(commitsBefore + 1);
    await new Promise((resolve) => setTimeout(resolve, 100)); // the audit write is fire-and-forget
    const audit = await query<{ meta: { from: string; to: string; pagesChanged: number } }>(`SELECT meta FROM audit_log WHERE action = 'space.tag_rename' AND target = $1 ORDER BY id`, [slug]);
    expect(audit.map((a) => a.meta)).toEqual([
      { from: 'work', to: 'projects', pagesChanged: 6 },
      { from: 'work', to: 'projects', pagesChanged: 0 },
      { from: 'work', to: 'projects', pagesChanged: 3 },
    ]);
  });

  it('a hierarchical rename moves a subtree: projects/alpha -> archive/alpha, children follow, the parent stays', async () => {
    const res = await rename('projects/alpha', 'archive/alpha');
    expect(res.json<RenameTagResult>().pagesChanged).toBe(1);
    const a = await read('a.md');
    expect(a).toContain('Intro #archive/alpha and #projects, then #archive/alpha/sub: end.');
    expect((await tagPages('archive')).body.pages.map((p) => p.path)).toEqual(['a.md']);
    expect((await tagPages('projects')).body.pages.map((p) => p.path)).toContain('a.md');
  });

  it('a page whose front matter has labels: is renamed in place under labels:; tags: and labels: each keep their own key; a page without the tag is left alone', async () => {
    const files = ['lab1.md', 'lab2.md', 'lab3.md', 'lab4.md', 'lab5.md'];
    const snapshot: Record<string, string> = {};
    for (const rel of files) snapshot[rel] = await read(rel);
    const commitsBefore = Number((await git('rev-list', '--count', 'HEAD')).trim());

    const res = await rename('legacy', 'modern');
    expect(res.json<RenameTagResult>()).toEqual({ pagesChanged: 4, pagesSkipped: 0 });

    expect(await read('lab1.md')).toBe(snapshot['lab1.md'].replace('labels: [Legacy, keepme]', 'labels: [modern, keepme]'));
    expect(await read('lab2.md')).toBe(
      snapshot['lab2.md'].replace('labels:\n  - Legacy/Sub   # why\n  - other', 'labels:\n  - modern/Sub   # why\n  - other').replace('Body #legacy here.', 'Body #modern here.'),
    );
    expect(await read('lab3.md')).toBe(snapshot['lab3.md'].replace('tags: [keepme, Legacy]\nlabels: [Legacy, Legacy/new, other]\n', 'tags: [keepme, modern]\nlabels: [modern, modern/new, other]\n'));
    expect(await read('lab4.md')).toBe(snapshot['lab4.md'].replace('tags: [legacy]\n', 'tags: [modern]\n'));
    expect(await read('lab5.md')).toBe(snapshot['lab5.md']);

    // One commit with exactly the four files; the index sees the tags under their new name only (labels: and tags: were both indexed before).
    expect(Number((await git('rev-list', '--count', 'HEAD')).trim())).toBe(commitsBefore + 1);
    expect((await git('show', '--name-only', '--format=', 'HEAD')).split('\n').filter(Boolean).sort()).toEqual(['lab1.md', 'lab2.md', 'lab3.md', 'lab4.md']);
    expect((await tagPages('modern')).body.pages.map((p) => p.path).sort()).toEqual(['lab1.md', 'lab2.md', 'lab3.md', 'lab4.md']); // listed by title
    expect((await tagPages('legacy')).body.pages).toEqual([]);
    const rows = await query<{ tag: string }>(`SELECT t.tag FROM page_tags t JOIN pages_index p ON p.id = t.page_id WHERE p.space_slug = $1 AND p.path = 'lab3.md' ORDER BY t.tag`, [slug]);
    expect(rows.map((r) => r.tag)).toEqual(['keepme', 'modern', 'modern/new', 'other']);
  });

  it('works for tags in any script: listing by an encoded Cyrillic tag, and a rename that keeps the case after the prefix', async () => {
    const listed = await tagPages(encodeURIComponent('Проєкт'));
    expect(listed.status).toBe(200);
    expect(listed.body.tag).toBe('проєкт');
    expect(listed.body.pages.map((p) => p.path)).toEqual(['uk.md']);
    expect((await tagPages(encodeURIComponent('проєкт/альфа'))).body.pages.map((p) => p.path)).toEqual(['uk.md']);

    const before = await read('uk.md');
    const res = await rename('проєкт', 'проєкти');
    expect(res.json<RenameTagResult>()).toEqual({ pagesChanged: 1, pagesSkipped: 0 });
    expect(await read('uk.md')).toBe(before.replace('#Проєкт/Альфа і #проєкт тут', '#проєкти/Альфа і #проєкти тут'));
    expect(await read('uk.md')).toContain('#проєктний — інший тег');
  });

  it('a page open in a live room is renamed through the room: what was just typed is kept, the file and the commit follow', async () => {
    const id = (await storage.getEntryIdByExactPath(slug, 'live.md'))!;
    const liveDocs = (createRequire(import.meta.url)('y-websocket/bin/utils') as { docs: Map<string, Y.Doc> }).docs;
    const ydoc = new Y.Doc();
    await collab.bindState(id, ydoc);
    liveDocs.set(id, ydoc);
    try {
      const ytext = ydoc.getText('content');
      ytext.insert(ytext.length, '\nTyped just now #liveword/typed\n'); // in the room, not yet on disk
      expect(collab.isDocLive(id)).toBe(true);
      const commitsBefore = Number((await git('rev-list', '--count', 'HEAD')).trim());

      const res = await rename('liveword', 'lw');
      expect(res.json<RenameTagResult>()).toEqual({ pagesChanged: 1, pagesSkipped: 0 });
      expect(ytext.toString()).toContain('Text #lw and more #lw/sub');
      expect(ytext.toString()).toContain('Typed just now #lw/typed');
      const file = await read('live.md');
      expect(file).toContain('tags: [lw]');
      expect(file).toContain('Text #lw and more #lw/sub');
      expect(file).toContain('Typed just now #lw/typed'); // flushed to disk before the commit
      expect(Number((await git('rev-list', '--count', 'HEAD')).trim())).toBe(commitsBefore + 1);
      expect(await git('show', 'HEAD:live.md')).toBe(file);
      expect((await tagPages('lw')).body.pages.map((p) => p.path)).toEqual(['live.md']);
    } finally {
      liveDocs.delete(id);
      ydoc.destroy();
    }
  });

  it('a write-scope token may rename; a rename that finds nothing changes nothing', async () => {
    const writePat = await authStore.createApiToken(editor.id, 'write', ['read', 'write']);
    const commitsBefore = Number((await git('rev-list', '--count', 'HEAD')).trim());
    const res = await app.inject({ method: 'POST', url: `/api/spaces/${slug}/tags/rename`, headers: { authorization: `Bearer ${writePat.token}` }, payload: { from: 'nothing-here', to: 'x' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<RenameTagResult>()).toEqual({ pagesChanged: 0, pagesSkipped: 0 });
    expect(Number((await git('rev-list', '--count', 'HEAD')).trim())).toBe(commitsBefore);
  });
});
