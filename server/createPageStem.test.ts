/**
 * POST /api/pages `fileStem` (wave 2, Obsidian): "Create page “Note”" on an
 * unresolved `[[Note]]` names the new file exactly `Note.md`, so the link
 * resolves to it. Real PG + real files, through the route.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PageMeta, User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { registerRoutes } from './routes.js';
import * as storage from './storage.js';
import { translitSlug } from './translit.js';

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

describe('createPage fileStem (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let owner: User;
  let auth: Record<string, string>;
  let slug: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    owner = await authStore.createUser({ email: `stem-owner-${Date.now()}@example.com`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    slug = (await storage.createSpace(`Stem ${Date.now()}`, owner.id)).slug;
    await authStore.setMembership(slug, owner.id, 'admin');
    auth = { cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(owner.id)).token}` };
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await deleteTestSpace(slug);
    await teardownSchema();
  });

  const create = async (body: Record<string, unknown>) => {
    const res = await app.inject({ method: 'POST', url: '/api/pages', headers: auth, payload: { space: slug, parentPath: '', kind: 'doc', ...body } });
    return { status: res.statusCode, body: res.json() as any };
  };

  it('names the file exactly after the stem, keeps the `# title` starter, and a taken name gets a suffix', async () => {
    const first = await create({ title: 'Some title', fileStem: 'My New Note' });
    expect(first.status).toBe(201);
    expect((first.body as PageMeta).path).toBe('My New Note.md');
    expect((first.body as PageMeta).title).toBe('Some title');
    expect(await fs.readFile(path.join(storage.getSpaceDir(slug), 'My New Note.md'), 'utf8')).toContain('# Some title\n');

    const second = await create({ title: 'Some title', fileStem: 'My New Note' });
    expect(second.status).toBe(201);
    expect(second.body.path).toBe('My New Note-2.md');
    expect(second.body.id).not.toBe(first.body.id);
  });

  it('trims the stem, drops a trailing .md, works in a folder and with non-latin names', async () => {
    expect((await create({ title: 'T', fileStem: '  Spaced out.md  ' })).body.path).toBe('Spaced out.md');
    expect((await create({ title: 'T', parentPath: 'Folder/Sub', fileStem: 'Inside' })).body.path).toBe('Folder/Sub/Inside.md');
    expect((await create({ title: 'T', fileStem: '\u041d\u043e\u0442\u0430\u0442\u043a\u0430 \u043f\u0440\u043e \u0441\u0430\u0434' })).body.path).toBe('\u041d\u043e\u0442\u0430\u0442\u043a\u0430 \u043f\u0440\u043e \u0441\u0430\u0434.md');
  });

  it('without a stem the name is still the transliterated title', async () => {
    expect((await create({ title: 'Plain Title Here' })).body.path).toBe(`${translitSlug('Plain Title Here')}.md`);
  });

  it('refuses a stem a link cannot carry, a dotfile, a blank one and a stem the scan would take for a table or form - and creates nothing', async () => {
    const before = (await storage.listEntries(slug)).length;
    const bad = ['a/b', 'a\\b', 'x#y', 'p|q', 'c^d', 'e:f', 'g[h', 'i]j', '100%', '.hidden', '.md', '   ', 'tab\there', 'ctl\u0001x', 'x.table', 'y.FORM', 'z'.repeat(250), '\u044f'.repeat(130), ''];
    for (const fileStem of bad) {
      const res = await create({ title: 'Never', fileStem });
      expect(res.status, JSON.stringify(fileStem)).toBe(400);
      expect(typeof res.body.error).toBe('string');
    }
    expect((await storage.listEntries(slug)).length).toBe(before);
  });

  it('is ignored for every other kind - even an invalid one does not fail a board or a table', async () => {
    const board = await create({ title: 'My Board', kind: 'board', fileStem: 'a/b' });
    expect(board.status).toBe(201);
    expect(board.body.path).toBe(`${translitSlug('My Board')}.excalidraw.svg`);
    const table = await create({ title: 'My Table', kind: 'table', fileStem: 'Chosen' });
    expect(table.status).toBe(201);
    expect(table.body.path).toBe(`${translitSlug('My Table')}.table.md`);
  });

  it('an unresolved [[wikilink]] resolves to the page created from its name', async () => {
    const source = await storage.createPage({ space: slug, parentPath: '', title: 'Linker', kind: 'doc' });
    await storage.writeDocBody(source.id, '# Linker\n\nSee [[Fresh Linked Note]].\n');
    const linkOf = async () => ((await app.inject({ method: 'GET', url: `/api/pages/${source.id}/meta`, headers: auth })).json() as any).links[0];
    expect(await linkOf()).toMatchObject({ linkPath: 'Fresh Linked Note', kind: 'unresolved', targetPageId: null });
    const made = await create({ title: 'Fresh Linked Note', fileStem: 'Fresh Linked Note' });
    expect(made.body.path).toBe('Fresh Linked Note.md');
    expect(await linkOf()).toMatchObject({ linkPath: 'Fresh Linked Note', kind: 'page', targetPageId: made.body.id });
  });
});
