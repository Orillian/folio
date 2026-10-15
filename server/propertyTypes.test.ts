/**
 * Property types of a space (Obsidian brief, wave 3), real PG + real git:
 * `.folio/properties.json` wins, `.obsidian/types.json` is the default
 * (`multitext` read as `list`), `known` is inferred from the front matter the
 * caller may read, and PUT writes Folio's file as ONE commit of that path.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpacePropertyTypesResponse, User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as pageAccess from './pageAccess.js';
import { registerPropertiesRoutes } from './propertiesRoutes.js';
import { inferPropertyType, normalizePropertyType, parseTypesFile, renderTypesFile } from './propertyTypes.js';
import * as storage from './storage.js';

const execFileAsync = promisify(execFile);

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
    registerPropertiesRoutes(scope);
  });
  await app.ready();
  return app;
}

describe('property type helpers (pure)', () => {
  it('reads either file leniently: multitext is a list, unknown types and non-objects are dropped', () => {
    expect(normalizePropertyType('multitext')).toBe('list');
    expect(normalizePropertyType('aliases')).toBe('aliases');
    expect(normalizePropertyType('rating')).toBeNull();
    expect(parseTypesFile('{"types":{"due":"date","cats":"multitext","x":"weird","":"text"},"extra":1}')).toEqual({ types: { cats: 'list', due: 'date' }, rest: { extra: 1 } });
    expect(parseTypesFile('[1,2]')).toBeNull();
    expect(parseTypesFile('not json')).toBeNull();
    expect(renderTypesFile({ z: 'text', a: 'number' }, '{"v":1,"types":{"old":"text"},"note":"kept"}')).toBe('{\n  "v": 1,\n  "types": {\n    "a": "number",\n    "z": "text"\n  },\n  "note": "kept"\n}\n');
  });

  it('infers a type from a value', () => {
    expect(inferPropertyType('labels', 'a b')).toBe('tags');
    expect(inferPropertyType('aliases', ['x'])).toBe('aliases');
    expect(inferPropertyType('n', 3)).toBe('number');
    expect(inferPropertyType('b', false)).toBe('checkbox');
    expect(inferPropertyType('l', ['a'])).toBe('list');
    expect(inferPropertyType('d', '2024-05-01')).toBe('date');
    expect(inferPropertyType('d', new Date('2024-05-01T00:00:00Z'))).toBe('date');
    expect(inferPropertyType('t', '2024-05-01T10:30:00')).toBe('datetime');
    expect(inferPropertyType('s', 'hello')).toBe('text');
    expect(inferPropertyType('s', null)).toBe('text');
  });
});

describe('GET/PUT /api/spaces/:space/property-types (real PG + git)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let owner: User;
  let editor: User;
  let slug: string;
  let dir: string;
  const auth: Record<string, Record<string, string>> = {};

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    app = await buildApp();
    const stamp = Date.now();
    owner = await authStore.createUser({ email: `ptypes-owner-${stamp}@example.com`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    editor = await authStore.createUser({ email: `ptypes-editor-${stamp}@example.com`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    slug = (await storage.createSpace(`PTypes ${stamp}`, owner.id)).slug;
    dir = storage.getSpaceDir(slug);
    await authStore.setMembership(slug, owner.id, 'admin');
    await authStore.setMembership(slug, editor.id, 'editor');
    for (const [name, user] of [['owner', owner], ['editor', editor]] as const) {
      auth[name] = { cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` };
    }
    const put = async (rel: string, text: string) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), text, 'utf8');
    };
    await put('a.md', '---\nid: 01PTYPESA0000000000000000A\ntags: [x]\ndue: 2024-05-01\nrating: 4\ndone: true\nauthors: [ann, bob]\nmeeting: 2024-05-01T10:30:00\nnote: hi\nempty:\n---\n# A\n');
    await put('b.md', '---\nid: 01PTYPESB0000000000000000B\nlabels: y\naliases: [Bee]\nrating: "five"\ndue: 2024-06-01\nnote: there\n---\n# B\n');
    await put('c.md', '---\nid: 01PTYPESC0000000000000000C\nrating: 5\nsecret_key: s\n---\n# C\n');
    await put('_templates/t.md', '---\nid: 01PTYPEST0000000000000000T\ntemplate_only: 1\n---\n# T\n');
    await storage.scanSpace(slug);
    await pageAccess.setAccess(owner, (await storage.getEntry('01PTYPESC0000000000000000C'))!, 'restricted', []);
  });
  afterAll(async () => {
    await app.close();
    await deleteTestSpace(slug);
    await teardownSchema();
  });

  const get = async (who = 'editor') => {
    const res = await app.inject({ method: 'GET', url: `/api/spaces/${slug}/property-types`, headers: auth[who] });
    return { status: res.statusCode, body: res.json() as SpacePropertyTypesResponse };
  };
  const git = async (...args: string[]) => (await execFileAsync('git', args, { cwd: storage.getRepoDir(slug) })).stdout.trim();

  it('known: every front matter key of the readable documents, its most common inferred type and page count (id and templates left out)', async () => {
    const res = await get('editor');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('none');
    expect(res.body.types).toEqual({});
    const known = Object.fromEntries(res.body.known.map((k) => [k.key, [k.inferred, k.pages]]));
    expect(known).toEqual({
      tags: ['tags', 1],
      labels: ['tags', 1],
      aliases: ['aliases', 1],
      due: ['date', 2],
      rating: ['number', 2], // 4 on a, "five" on b (c is hidden from the editor): a 1:1 tie goes to the more specific type
      done: ['checkbox', 1],
      authors: ['list', 1],
      meeting: ['datetime', 1],
      note: ['text', 2],
      empty: ['text', 1],
    });
    // the owner also sees the restricted page
    const ownerKnown = Object.fromEntries((await get('owner')).body.known.map((k) => [k.key, [k.inferred, k.pages]]));
    expect(ownerKnown.rating).toEqual(['number', 3]);
    expect(ownerKnown.secret_key).toEqual(['text', 1]);
  });

  it('.obsidian/types.json is the default (multitext -> list); .folio/properties.json wins when present', async () => {
    await fs.mkdir(path.join(dir, '.obsidian'), { recursive: true });
    await fs.writeFile(path.join(dir, '.obsidian', 'types.json'), JSON.stringify({ types: { authors: 'multitext', due: 'date', bogus: 'rating' } }), 'utf8');
    let res = await get();
    expect(res.body).toMatchObject({ source: 'obsidian', types: { authors: 'list', due: 'date' } });
    expect(res.body.types).not.toHaveProperty('bogus');

    await fs.mkdir(path.join(dir, '.folio'), { recursive: true });
    await fs.writeFile(path.join(dir, '.folio', 'properties.json'), JSON.stringify({ v: 1, types: { rating: 'number' } }), 'utf8');
    res = await get();
    expect(res.body).toMatchObject({ source: 'folio', types: { rating: 'number' } });
    expect(res.body.types).not.toHaveProperty('due');
    await fs.rm(path.join(dir, '.folio', 'properties.json'));
    expect((await get()).body.source).toBe('obsidian');
  });

  it('PUT: space admin only, writes .folio/properties.json as ONE commit of that path (other dirty files stay uncommitted), nothing when unchanged', async () => {
    expect((await app.inject({ method: 'PUT', url: `/api/spaces/${slug}/property-types`, headers: auth.editor, payload: { types: { due: 'date' } } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `/api/spaces/${slug}/property-types`, headers: auth.owner, payload: { types: { due: 'rating' } } })).statusCode).toBe(400);

    await fs.writeFile(path.join(dir, 'a.md'), `${await fs.readFile(path.join(dir, 'a.md'), 'utf8')}\nAn unsaved edit.\n`, 'utf8');
    const headBefore = await git('rev-parse', 'HEAD');
    const res = await app.inject({ method: 'PUT', url: `/api/spaces/${slug}/property-types`, headers: auth.owner, payload: { types: { rating: 'number', authors: 'list' } } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as SpacePropertyTypesResponse).source).toBe('folio');
    expect(await fs.readFile(path.join(dir, '.folio', 'properties.json'), 'utf8')).toBe('{\n  "v": 1,\n  "types": {\n    "authors": "list",\n    "rating": "number"\n  }\n}\n');
    expect(await git('rev-list', '--count', `${headBefore}..HEAD`)).toBe('1');
    expect(await git('log', '-1', '--format=%s')).toBe('settings: update .folio/properties.json');
    expect(await git('show', '--name-only', '--format=', 'HEAD')).toBe('.folio/properties.json');
    expect(await git('status', '--porcelain', '--', 'a.md')).not.toBe(''); // still not committed

    const again = await app.inject({ method: 'PUT', url: `/api/spaces/${slug}/property-types`, headers: auth.owner, payload: { types: { authors: 'list', rating: 'number' } } });
    expect(again.statusCode).toBe(200);
    expect(await git('rev-list', '--count', `${headBefore}..HEAD`)).toBe('1');
  });
});
