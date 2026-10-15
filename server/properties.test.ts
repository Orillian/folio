/**
 * Page properties (Obsidian brief, wave 3): the front matter writer
 * (frontmatter.ts writeFrontmatterKeys, pure) and GET/PUT
 * /api/pages/:id/properties on real PG + real files — the response shape,
 * byte-preserving edits, the `tags:` / `labels:` synonym rules, the immutable id,
 * foreign Folio values, the etag 409, the audit row, and a properties save
 * while the page's collab room is open with unflushed typing.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PagePropertiesResponse, User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import * as collab from './collab.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { UnparseableFrontmatterError, writeFrontmatterKeys, type FrontmatterKeyEdit } from './frontmatter.js';
import { registerPropertiesRoutes } from './propertiesRoutes.js';
import * as storage from './storage.js';

const edits = (entries: Array<[string, FrontmatterKeyEdit]>) => new Map(entries);

describe('writeFrontmatterKeys (pure)', () => {
  it('sets in place, appends, removes — comments, quoting, flow lists and untouched keys stay byte for byte', () => {
    const raw = "---\n# leading comment\ntitle: 'Quoted: yes'   # why\nlist: [a, b]\nkeep: 1\nold: x\nmulti:\n  - one\n  - two\nafter: z\n---\nBody\n";
    const out = writeFrontmatterKeys(
      raw,
      edits([
        ['keep', { set: 2 }],
        ['old', { remove: true }],
        ['multi', { remove: true }],
        ['new', { set: 'Fix: login' }],
        ['tags', { set: ['x', 'w'] }],
        ['empty', { set: null }],
      ]),
    );
    expect(out).toBe("---\n# leading comment\ntitle: 'Quoted: yes'   # why\nlist: [a, b]\nkeep: 2\nafter: z\nnew: 'Fix: login'\ntags:\n  - x\n  - w\nempty:\n---\nBody\n");
  });

  it('returns the very same text when nothing changes', () => {
    const raw = '---\nkeep: 1\nlist: [a, b]\n---\nBody';
    expect(writeFrontmatterKeys(raw, edits([['keep', { set: 1 }], ['list', { set: ['a', 'b'] }], ['gone', { remove: true }]]))).toBe(raw);
  });

  it('keeps CRLF, creates a block when there is none, and drops a block left empty (a comment keeps it)', () => {
    expect(writeFrontmatterKeys('---\r\na: 1\r\n---\r\nBody\r\n', edits([['b', { set: 2 }]]))).toBe('---\r\na: 1\r\nb: 2\r\n---\r\nBody\r\n');
    expect(writeFrontmatterKeys('Body only', edits([['a', { set: 1 }]]))).toBe('---\na: 1\n---\nBody only');
    expect(writeFrontmatterKeys('---\na: 1\n---\nBody\n', edits([['a', { remove: true }]]))).toBe('Body\n');
    expect(writeFrontmatterKeys('---\n# note\na: 1\n---\nBody\n', edits([['a', { remove: true }]]))).toBe('---\n# note\n---\nBody\n');
  });

  it('uses the caller\'s own lines (an unquoted date) and re-serializes a block it cannot edit line by line, never losing data or a body byte', () => {
    expect(writeFrontmatterKeys('---\na: 1\n---\nB', edits([['due', { set: '2024-05-01', lines: ['due: 2024-05-01'] }]]))).toBe('---\na: 1\ndue: 2024-05-01\n---\nB');
    // a flow mapping as the whole block: no key line to edit
    expect(writeFrontmatterKeys('---\n{a: 1, b: 2}\n---\nB', edits([['b', { set: 3 }]]))).toBe('---\na: 1\nb: 3\n---\nB');
  });

  it('refuses a block YAML cannot read', () => {
    expect(() => writeFrontmatterKeys('---\ntitle: Fix: login\n---\nB', edits([['x', { set: 1 }]]))).toThrow(UnparseableFrontmatterError);
    expect(() => writeFrontmatterKeys('---\ntitle: never closed\nB', edits([['x', { set: 1 }]]))).toThrow(UnparseableFrontmatterError);
  });
});

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

const sha1 = (s: string) => createHash('sha1').update(s, 'utf8').digest('hex');

describe('GET/PUT /api/pages/:id/properties (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let owner: User;
  let editor: User;
  let reader: User;
  let slug: string;
  let dir: string;
  const auth: Record<string, Record<string, string>> = {};
  let counter = 0;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    app = await buildApp();
    const stamp = Date.now();
    owner = await authStore.createUser({ email: `props-owner-${stamp}@example.com`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    editor = await authStore.createUser({ email: `props-editor-${stamp}@example.com`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    reader = await authStore.createUser({ email: `props-reader-${stamp}@example.com`, name: 'Reader', passwordHash: 'x', isAdmin: false });
    slug = (await storage.createSpace(`Props ${stamp}`, owner.id)).slug;
    dir = storage.getSpaceDir(slug);
    await authStore.setMembership(slug, owner.id, 'admin');
    await authStore.setMembership(slug, editor.id, 'editor');
    await authStore.setMembership(slug, reader.id, 'viewer');
    for (const [name, user] of [['owner', owner], ['editor', editor], ['reader', reader]] as const) {
      auth[name] = { cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` };
    }
  });
  afterAll(async () => {
    await app.close();
    await deleteTestSpace(slug);
    await teardownSchema();
  });

  /** A page whose file is exactly `text` (with `id: <ID>` replaced by a fresh own id, so the scan writes nothing). */
  async function page(name: string, text: string): Promise<{ id: string; abs: string; text: string }> {
    const id = `01PROPS${Date.now().toString(36).toUpperCase()}${(counter++).toString().padStart(3, '0')}`;
    const content = text.replace('<ID>', id);
    const abs = path.join(dir, `${name}.md`);
    await fs.writeFile(abs, content, 'utf8');
    await storage.scanSpace(slug);
    const indexed = await storage.getEntryIdByExactPath(slug, `${name}.md`);
    if (text.includes('<ID>')) {
      expect(indexed).toBe(id);
      expect(await fs.readFile(abs, 'utf8')).toBe(content);
    }
    expect(indexed).toBeTruthy();
    return { id: indexed!, abs, text: await fs.readFile(abs, 'utf8') };
  }

  const get = async (id: string, who = 'editor') => {
    const res = await app.inject({ method: 'GET', url: `/api/pages/${id}/properties`, headers: auth[who] });
    return { status: res.statusCode, body: res.json() as PagePropertiesResponse & { error?: string } };
  };
  const put = async (id: string, body: unknown, who = 'editor') => {
    const res = await app.inject({ method: 'PUT', url: `/api/pages/${id}/properties`, headers: auth[who], payload: body as object });
    return { status: res.statusCode, body: res.json() as PagePropertiesResponse & { error?: string } };
  };

  const DOC = [
    '---',
    'id: <ID>',
    '# Docusaurus settings',
    'title: "Fix: login"   # quoted on purpose',
    'sidebar_position: 3',
    'status: deprecated',
    'tags:',
    '  - alpha',
    '  - beta',
    'due: 2024-05-01',
    'owner:   someone   # odd spacing',
    '---',
    '# Page',
    '',
    'Body text without a trailing newline',
  ].join('\n');

  it('GET: the whole front matter as parsed, effective types, foreign Folio values, read-only id, canEdit by role, the etag of the block', async () => {
    const p = await page('get-shape', DOC);
    const res = await get(p.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      properties: { id: p.id, title: 'Fix: login', sidebar_position: 3, status: 'deprecated', tags: ['alpha', 'beta'], due: '2024-05-01', owner: 'someone' },
      types: { id: 'text', title: 'text', sidebar_position: 'number', status: 'text', tags: 'tags', due: 'date', owner: 'text' },
      foreign: ['status'],
      readOnly: ['id'],
      canEdit: true,
      etag: sha1(p.text.slice(0, p.text.indexOf('# Page'))),
    });
    expect((await get(p.id, 'reader')).body.canEdit).toBe(false);
    const nothing = await page('no-block', '# No block\n');
    expect((await get(nothing.id)).body).toMatchObject({ etag: expect.any(String), properties: { id: nothing.id } }); // the scan gave it its id
  });

  it('PUT: sets, adds, removes and renames keys in place — comments, quoting and untouched keys byte for byte, the body untouched', async () => {
    const p = await page('put-edit', DOC);
    const current = (await get(p.id)).body;
    const { sidebar_position: _gone, due: _renamed, ...rest } = current.properties;
    const res = await put(p.id, { properties: { ...rest, owner: 'me', reviewed: true, priority: '2', deadline: '2024-06-01' }, etag: current.etag });
    expect(res.status).toBe(200);
    expect(await fs.readFile(p.abs, 'utf8')).toBe(
      [
        '---',
        `id: ${p.id}`,
        '# Docusaurus settings',
        'title: "Fix: login"   # quoted on purpose',
        'status: deprecated',
        'tags:',
        '  - alpha',
        '  - beta',
        'owner: me',
        'reviewed: true',
        "priority: '2'",
        'deadline: 2024-06-01',
        '---',
        '# Page',
        '',
        'Body text without a trailing newline',
      ].join('\n'),
    );
    expect(res.body.properties).toEqual({ id: p.id, title: 'Fix: login', status: 'deprecated', tags: ['alpha', 'beta'], owner: 'me', reviewed: true, priority: '2', deadline: '2024-06-01' });
    expect(res.body.types).toMatchObject({ reviewed: 'checkbox', deadline: 'date' });
    // the index follows the file
    const row = await query<{ frontmatter: Record<string, unknown> }>('SELECT frontmatter FROM pages_index WHERE id = $1', [p.id]);
    expect(row[0].frontmatter).toMatchObject({ owner: 'me', reviewed: true });
    expect(row[0].frontmatter).not.toHaveProperty('due');
    // the audit row names the keys that changed
    let audit: Array<{ meta: { keys: string[] } }> = [];
    for (let i = 0; i < 50 && audit.length === 0; i++) {
      audit = await query(`SELECT meta FROM audit_log WHERE action = 'page.properties' AND target = $1`, [p.id]);
      if (audit.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(audit[0].meta.keys.sort()).toEqual(['deadline', 'due', 'owner', 'priority', 'reviewed', 'sidebar_position']);

    // nothing changed: no write at all
    const before = await fs.stat(p.abs);
    const again = await put(p.id, { properties: res.body.properties });
    expect(again.status).toBe(200);
    expect((await fs.stat(p.abs)).mtimeMs).toBe(before.mtimeMs);
  });

  it('an unchanged foreign Folio value sent back as GET returned it is accepted and left untouched; left out it stays too; null removes it; a changed value is validated', async () => {
    const p = await page('foreign', ['---', 'id: <ID>', 'status: deprecated', 'order: high', 'icon: ""', 'note: n', '---', 'Body', ''].join('\n'));
    const got = (await get(p.id)).body;
    expect(got.foreign.sort()).toEqual(['icon', 'order', 'status']);

    // the whole map exactly as GET returned it, one other key changed
    const res = await put(p.id, { properties: { ...got.properties, note: 'changed' } });
    expect(res.status).toBe(200);
    expect(await fs.readFile(p.abs, 'utf8')).toBe(['---', `id: ${p.id}`, 'status: deprecated', 'order: high', 'icon: ""', 'note: changed', '---', 'Body', ''].join('\n'));

    // left out: a foreign value is never removed by omission
    expect((await put(p.id, { properties: { id: p.id, note: 'changed' } })).status).toBe(200);
    expect(await fs.readFile(p.abs, 'utf8')).toBe(['---', `id: ${p.id}`, 'status: deprecated', 'order: high', 'icon: ""', 'note: changed', '---', 'Body', ''].join('\n'));

    // a changed Folio value must be one Folio writes
    expect((await put(p.id, { properties: { ...got.properties, status: 'bogus' } })).status).toBe(400);
    expect((await put(p.id, { properties: { ...got.properties, order: 'higher' } })).status).toBe(400);

    // null removes it; a valid value replaces it and reaches the index row
    expect((await put(p.id, { properties: { id: p.id, note: 'changed', order: null, icon: null, status: 'draft' } })).status).toBe(200);
    expect(await fs.readFile(p.abs, 'utf8')).toBe(['---', `id: ${p.id}`, 'status: draft', 'note: changed', '---', 'Body', ''].join('\n'));
    expect((await storage.getEntry(p.id))?.explicitStatus).toBe('draft');
    // a Folio value Folio wrote goes when it is left out
    expect((await put(p.id, { properties: { id: p.id, note: 'changed' } })).status).toBe(200);
    expect(await fs.readFile(p.abs, 'utf8')).toBe(['---', `id: ${p.id}`, 'note: changed', '---', 'Body', ''].join('\n'));
    expect((await storage.getEntry(p.id))?.explicitStatus).toBeUndefined();
  });

  it('labels: alone is the tags row — sent unchanged it stays; an edited tags row is written in place under labels:', async () => {
    const p = await page('labels', ['---', 'id: <ID>', 'labels: [one, two]', 'note: keep me', '---', 'Body', ''].join('\n'));
    const got = (await get(p.id)).body;
    expect(got.types.labels).toBe('tags');
    const same = await put(p.id, { properties: got.properties });
    expect(same.status).toBe(200);
    expect(await fs.readFile(p.abs, 'utf8')).toBe(p.text);

    const { labels, ...rest } = got.properties;
    expect((await put(p.id, { properties: { ...rest, tags: [...(labels as string[]), '#three', 'one'] } })).status).toBe(200);
    expect(await fs.readFile(p.abs, 'utf8')).toBe(['---', `id: ${p.id}`, 'labels:', '  - one', '  - two', '  - three', 'note: keep me', '---', 'Body', ''].join('\n'));
    const tags = await query<{ tag: string }>(`SELECT tag FROM page_tags WHERE page_id = $1 AND source = 'frontmatter' ORDER BY tag`, [p.id]);
    expect(tags.map((t) => t.tag)).toEqual(['one', 'three', 'two']);
  });

  it('tags: and labels: together — editing another key, or tags, never touches labels:; left out it stays; only labels: null removes it', async () => {
    const lines = ['---', 'id: <ID>', 'tags: [a, b]', 'labels: [x, y]', 'effort: 2', 'nested:', '  deep: [1, 2]', '---', 'Body', ''];
    const p = await page('both', lines.join('\n'));
    const got = (await get(p.id)).body;
    expect(got.properties.labels).toEqual(['x', 'y']);

    // The panel's flow: the whole map back with one key changed.
    expect((await put(p.id, { properties: { ...got.properties, effort: 3 } })).status).toBe(200);
    expect(await fs.readFile(p.abs, 'utf8')).toBe(p.text.replace('effort: 2', 'effort: 3'));

    // Tags edited: tags: changes, labels: stays byte for byte.
    const now = (await get(p.id)).body;
    expect((await put(p.id, { properties: { ...now.properties, tags: ['a', 'b', 'c'] } })).status).toBe(200);
    const afterTags = await fs.readFile(p.abs, 'utf8');
    expect(afterTags).toContain('labels: [x, y]\neffort: 3\nnested:\n  deep: [1, 2]\n');
    expect(afterTags).not.toContain('tags: [a, b]');

    // labels left out (an external caller): kept.
    const { labels: _l, ...noLabels } = (await get(p.id)).body.properties;
    expect((await put(p.id, { properties: noLabels })).status).toBe(200);
    expect(await fs.readFile(p.abs, 'utf8')).toBe(afterTags);

    // labels changed explicitly: in place, under labels:.
    expect((await put(p.id, { properties: { ...noLabels, labels: ['x', 'z'] } })).status).toBe(200);
    const afterLabels = await fs.readFile(p.abs, 'utf8');
    expect(afterLabels).toMatch(/labels:\n  - x\n  - z\neffort: 3/);

    // only an explicit null removes it.
    expect((await put(p.id, { properties: { ...noLabels, labels: null } })).status).toBe(200);
    expect(await fs.readFile(p.abs, 'utf8')).not.toContain('labels');
  });

  it('id is immutable; a stale etag is a 409 with the current state; a reader, a non-document page and an unreadable block cannot be edited', async () => {
    const p = await page('guards', ['---', 'id: <ID>', 'a: 1', '---', 'Body', ''].join('\n'));
    const got = (await get(p.id)).body;
    expect((await put(p.id, { properties: { ...got.properties, id: 'SOMETHINGELSE' } })).status).toBe(400);
    // leaving id out keeps it
    expect((await put(p.id, { properties: { a: 2 } })).status).toBe(200);
    expect(await fs.readFile(p.abs, 'utf8')).toBe(['---', `id: ${p.id}`, 'a: 2', '---', 'Body', ''].join('\n'));

    const stale = await put(p.id, { properties: { ...got.properties, a: 3 }, etag: got.etag });
    expect(stale.status).toBe(409);
    expect(stale.body.properties).toEqual({ id: p.id, a: 2 });
    expect(stale.body.etag).not.toBe(got.etag);
    expect((await put(p.id, { properties: { ...got.properties, a: 3 }, etag: stale.body.etag })).status).toBe(200);

    expect((await put(p.id, { properties: { a: 4 } }, 'reader')).status).toBe(403);

    const broken = await page('broken', '---\ntitle: Fix: login\n---\n# Broken\n');
    const brokenGet = (await get(broken.id)).body;
    expect(brokenGet.canEdit).toBe(false);
    expect((await put(broken.id, { properties: { a: 1 } })).status).toBe(400);
    expect(await fs.readFile(broken.abs, 'utf8')).toBe(broken.text);
  });

  it('an open collab room keeps the new front matter on its next flush; a save racing the flush loses neither side', async () => {
    const p = await page('room', ['---', 'id: <ID>', 'status: published', 'owner: someone', '---', '# Room', '', 'Line one.', ''].join('\n'));
    const room = new Y.Doc();
    await collab.bindState(p.id, room);
    const text = room.getText('content');
    expect(text.toString()).toBe('# Room\n\nLine one.\n'); // the room holds the body only
    text.insert(text.length, 'Typed in the room.\n'); // not flushed yet

    const res = await put(p.id, { properties: { id: p.id, status: 'draft', owner: 'someone', reviewer: 'ann' } });
    expect(res.status).toBe(200);
    // the save rewrote the block only: the room's unflushed typing is not on disk yet
    expect(await fs.readFile(p.abs, 'utf8')).toBe(['---', `id: ${p.id}`, 'status: draft', 'owner: someone', 'reviewer: ann', '---', '# Room', '', 'Line one.', ''].join('\n'));

    await collab.flushDoc(p.id); // the room's own writer (what y-websocket runs on close)
    expect(await fs.readFile(p.abs, 'utf8')).toBe(
      ['---', `id: ${p.id}`, 'status: draft', 'owner: someone', 'reviewer: ann', '---', '# Room', '', 'Line one.', 'Typed in the room.', ''].join('\n'),
    );
    expect((await storage.getEntry(p.id))?.explicitStatus).toBe('draft');

    // racing: a properties save and the room's flush at once
    text.insert(text.length, 'Second line.\n');
    const [raced] = await Promise.all([put(p.id, { properties: { id: p.id, status: 'archived', owner: 'someone' } }), collab.flushDoc(p.id)]);
    expect(raced.status).toBe(200);
    await collab.flushDoc(p.id);
    expect(await fs.readFile(p.abs, 'utf8')).toBe(
      ['---', `id: ${p.id}`, 'status: archived', 'owner: someone', '---', '# Room', '', 'Line one.', 'Typed in the room.', 'Second line.', ''].join('\n'),
    );
    room.destroy();
  });
});
