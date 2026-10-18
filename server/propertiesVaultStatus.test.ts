/**
 * `status` in a light-footprint space (16.10.2026, owner's decision): in an
 * Obsidian vault / a repository with files of its own, `status` is an ordinary
 * property — any value, editable from the panel and a base cell, typed by
 * `.obsidian/types.json` like other keys, never "foreign". Folio's own page
 * status keeps reading the key: exactly draft / published / archived keep their
 * meaning, anything else is `published`. A native space keeps `status` as
 * Folio's key (draft | published | archived, anything else foreign and
 * refused). Search: `status:draft|published|archived` is Folio's page status,
 * any other value (`status:todo`) the front matter `status` — the same rule in
 * every space; the public site never matches front matter. Public visibility
 * does not depend on `status` at all, in either kind of space.
 *
 * Real PG + real git (a local bare repo as the vault's remote).
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PagePropertiesResponse, User } from '../shared/contracts.js';
import { parseBaseConfig } from '../shared/bases/parse.js';
import { userViewer } from './accessSql.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { queryBase } from './bases/query.js';
import { query, queryOne } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as git from './git.js';
import { registerPropertiesRoutes } from './propertiesRoutes.js';
import { publicReadablePageIds } from './publicSites.js';
import { searchPages, searchPublicSpace } from './search.js';
import * as storage from './storage.js';

git.__allowLocalRepoPathsForTests();
const execFileAsync = promisify(execFile);
const RUN = `vault-status-${Date.now().toString(36)}`;
const tmpDirs: string[] = [];

const VAULT: Record<string, string> = {
  '.obsidian/types.json': JSON.stringify({ types: { priority: 'number' } }),
  'tasks/todo.md': '---\nstatus: todo\npriority: 2\n---\n# Write the brief\n',
  'tasks/draft.md': '---\nstatus: draft\n---\n# Half an idea\n',
  'tasks/plain.md': '# No status at all\n',
};

async function seededBareRepo(files: Record<string, string>): Promise<string> {
  const bare = path.join(os.tmpdir(), `folio-${RUN}-${Math.random().toString(36).slice(2, 8)}.git`);
  const seed = `${bare}-seed`;
  tmpDirs.push(bare, seed);
  await execFileAsync('git', ['init', '--bare', '-b', 'main', bare]);
  await fs.mkdir(seed, { recursive: true });
  await git.initWithCommit(seed, 'seed placeholder');
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(seed, rel)), { recursive: true });
    await fs.writeFile(path.join(seed, rel), content, 'utf8');
  }
  await git.commitAll(seed, 'seed', { name: 'Tester', email: 't@example.test' });
  await execFileAsync('git', ['remote', 'add', 'origin', bare], { cwd: seed });
  await git.push(seed, 'main');
  return bare;
}

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

describe('status in a light-footprint space vs a native space (real PG + git)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let owner: User;
  let cookie: string;
  let vault: string;
  let native: string;
  const ids = new Map<string, string>();

  const idOf = async (space: string, rel: string): Promise<string> => {
    const row = await queryOne<{ id: string }>('SELECT id FROM pages_index WHERE space_slug = $1 AND path = $2', [space, rel]);
    expect(row, `${space}/${rel}`).toBeDefined();
    return row!.id;
  };
  const get = async (id: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/pages/${id}/properties`, headers: { cookie } });
    return res.json() as PagePropertiesResponse;
  };
  const put = async (id: string, properties: Record<string, unknown>, etag?: string | null) => {
    const res = await app.inject({ method: 'PUT', url: `/api/pages/${id}/properties`, headers: { cookie }, payload: { properties, ...(etag !== undefined ? { etag } : {}) } });
    return { status: res.statusCode, body: res.json() as PagePropertiesResponse & { error?: string } };
  };
  const pageStatus = async (id: string) => (await queryOne<{ status: string | null }>('SELECT status FROM pages_index WHERE id = $1', [id]))?.status ?? null;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    app = await buildApp();
    owner = await authStore.createUser({ email: `${RUN}@t.local`, name: 'Vault Owner', passwordHash: 'x', isAdmin: false });
    cookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(owner.id)).token}`;

    const bare = await seededBareRepo(VAULT);
    vault = (await storage.createSpaceFromRepo({ name: `Vault ${RUN}`, repoUrl: bare, branch: 'main', rootPath: '', createdBy: owner.id })).slug;
    await authStore.setMembership(vault, owner.id, 'admin');
    expect((await storage.getSpaceInfo(vault))?.lightFootprint).toBe(true);
    for (const rel of ['tasks/todo.md', 'tasks/draft.md', 'tasks/plain.md']) ids.set(`vault:${rel}`, await idOf(vault, rel));

    native = (await storage.createSpace(`Native ${RUN}`, owner.id)).slug;
    await authStore.setMembership(native, owner.id, 'admin');
    await fs.writeFile(path.join(storage.getSpaceDir(native), 'todo.md'), '---\nstatus: todo\n---\n# Native todo\n', 'utf8');
    await fs.writeFile(path.join(storage.getSpaceDir(native), 'drafted.md'), '---\nstatus: draft\n---\n# Native draft\n', 'utf8');
    await storage.scanSpace(native);
    ids.set('native:todo.md', await idOf(native, 'todo.md'));
    ids.set('native:drafted.md', await idOf(native, 'drafted.md'));
  });

  afterAll(async () => {
    await app.close();
    for (const slug of [vault, native]) if (slug) await deleteTestSpace(slug);
    for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await teardownSchema();
  });

  it('vault: status is an ordinary property — not foreign, any value, typed like other keys, saved byte-preserving', async () => {
    const id = ids.get('vault:tasks/todo.md')!;
    const got = await get(id);
    expect(got.properties.status).toBe('todo');
    expect(got.foreign).toEqual([]);
    expect(got.folioKeys).toEqual(['id', 'order', 'icon', 'cover']);
    expect(got.types.status).toBe('text');
    expect(got.canEdit).toBe(true);

    const res = await put(id, { ...got.properties, status: 'doing' }, got.etag);
    expect(res.status).toBe(200);
    expect(res.body.properties.status).toBe('doing');
    const file = await fs.readFile((await storage.requireEntry(id)).absPath, 'utf8');
    expect(file).toBe('---\nstatus: doing\npriority: 2\n---\n# Write the brief\n');
    // Folio's own page status: anything but its three values counts as published (no row status).
    expect(await pageStatus(id)).toBeNull();
    expect((await storage.requireEntry(id)).status).toBe('published');

    // An Obsidian-style value with spaces and capitals is just as fine; Folio's own values keep their meaning.
    expect((await put(id, { ...res.body.properties, status: 'In Review' })).status).toBe(200);
    expect((await put(id, { ...res.body.properties, status: 'archived' })).status).toBe(200);
    expect(await pageStatus(id)).toBe('archived');
    // Left out, it is removed like any other key (no "foreign value stays" rule here).
    const now = await get(id);
    const { status: _status, ...withoutStatus } = now.properties;
    expect((await put(id, withoutStatus, now.etag)).status).toBe(200);
    expect((await get(id)).properties).not.toHaveProperty('status');
    expect(await pageStatus(id)).toBeNull();
    await put(id, { ...withoutStatus, status: 'doing' });
  });

  it('vault: a type declared in .obsidian/types.json applies to status like to any key', async () => {
    const typesFile = path.join(storage.getSpaceDir(vault), '.obsidian', 'types.json');
    const before = await fs.readFile(typesFile, 'utf8');
    try {
      await fs.writeFile(typesFile, JSON.stringify({ types: { priority: 'number', status: 'multitext' } }), 'utf8');
      const id = ids.get('vault:tasks/plain.md')!;
      const got = await get(id);
      expect(got.types.status).toBe('list');
      const res = await put(id, { ...got.properties, status: 'blocked' }, got.etag);
      expect(res.status).toBe(200);
      expect(res.body.properties.status).toEqual(['blocked']);
      expect(await pageStatus(id)).toBeNull();
    } finally {
      await fs.writeFile(typesFile, before, 'utf8');
    }
  });

  it('a base over the vault lists status values and its cell edit (the properties PUT) writes `doing`', async () => {
    const id = ids.get('vault:tasks/draft.md')!;
    const config = parseBaseConfig('filters: \'file.inFolder("tasks")\'\nviews:\n  - type: table\n    name: Tasks\n    order:\n      - file.name\n      - status\n').config!;
    const before = await queryBase({ space: vault, config, viewer: userViewer(owner), spaceEditor: true, tokenMayWrite: true, thisPageId: null });
    const row = before.rows.find((r) => r.id === id)!;
    expect(row).toBeDefined();
    expect(row.canEdit).toBe(true);

    // What useCellCommit does: read, refuse a foreign key (there is none), PUT the whole map with the new value.
    const current = await get(id);
    expect(current.foreign).not.toContain('status');
    expect(current.properties.status).toBe('draft');
    expect((await put(id, { ...current.properties, status: 'doing' }, current.etag)).status).toBe(200);

    const after = await queryBase({ space: vault, config, viewer: userViewer(owner), spaceEditor: true, tokenMayWrite: true, thisPageId: null });
    const edited = after.rows.find((r) => r.id === id)!;
    const statusColumn = after.columns.find((c) => c.key === 'status')!;
    expect(statusColumn).toBeDefined();
    expect(edited.cells[statusColumn.id]).toMatchObject({ v: 'doing' });
    // It was `draft` (Folio's draft); now it is a vault value, so the page counts as published.
    expect(await pageStatus(id)).toBeNull();
  });

  it('native: status stays Folio\'s key — a vault value is foreign, kept by omission and refused as a new value', async () => {
    const id = ids.get('native:todo.md')!;
    const got = await get(id);
    expect(got.foreign).toEqual(['status']);
    expect(got.folioKeys).toEqual(['id', 'order', 'status', 'icon', 'cover']);
    const refused = await put(id, { ...got.properties, status: 'doing' }, got.etag);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/status must be draft, published or archived/);
    const { status: _status, ...rest } = got.properties;
    expect((await put(id, { ...rest, note: 'x' }, got.etag)).status).toBe(200);
    expect((await get(id)).properties.status).toBe('todo');
  });

  it('search: status:todo is the front matter value in both kinds of space; status:draft and status:published are Folio\'s page status', async () => {
    const titles = async (q: string, space: string) => (await searchPages(q, { userId: owner.id, space })).map((h) => h.path).sort();
    await fs.writeFile(path.join(storage.getSpaceDir(vault), 'tasks/todo2.md'), '---\nstatus: Todo\n---\n# Another todo\n', 'utf8');
    await storage.scanSpace(vault);

    expect(await titles('status:todo', vault)).toEqual(['tasks/todo2.md']);
    expect(await titles('status:doing', vault)).toEqual(['tasks/draft.md', 'tasks/todo.md']);
    expect(await titles('status:doing,todo', vault)).toEqual(['tasks/draft.md', 'tasks/todo.md', 'tasks/todo2.md']);
    // Folio's page status: a vault value counts as published.
    expect(await titles('status:published in:tasks/', vault)).toEqual(expect.arrayContaining(['tasks/todo.md', 'tasks/todo2.md']));
    expect(await titles('status:draft', vault)).toEqual([]);

    expect(await titles('status:todo', native)).toEqual(['todo.md']);
    expect(await titles('status:draft', native)).toEqual(['drafted.md']);
  });

  it('public site: visibility does not depend on status; front matter status values are never matched for anonymous readers', async () => {
    await authStore.setSpaceVisibility(vault, 'public');
    try {
      const readable = await publicReadablePageIds(vault);
      for (const rel of ['tasks/todo.md', 'tasks/draft.md', 'tasks/plain.md']) expect(readable.has(ids.get(`vault:${rel}`)!), rel).toBe(true);
      expect(await searchPublicSpace('status:doing', vault)).toEqual([]);
      expect((await searchPublicSpace('status:published brief', vault)).map((h) => h.path)).toEqual(['tasks/todo.md']);
    } finally {
      await authStore.setSpaceVisibility(vault, 'private');
    }
    const rows = await query<{ path: string }>('SELECT path FROM pages_index WHERE space_slug = $1 AND status IS NOT NULL', [vault]);
    expect(rows.map((r) => r.path).sort()).toEqual([]);
  });
});
