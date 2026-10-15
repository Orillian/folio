/**
 * Properties of non-document pages (15.10.2026): data tables and forms keep
 * them in their own front matter next to the reserved keys (never shown,
 * never edited, never lost — not by a properties save, not by a table or
 * form save); boards, PDFs and Office files keep them in a sidecar
 * `.folio/<path>.props.yaml` (one commit per save, created by the first
 * property, deleted with the last, moved / trashed / restored with the page,
 * picked up from git on a scan). All of them feed the page index: tags,
 * `prop:` / `tag:` search, get_page_metadata, the space's known keys.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PagePropertiesResponse, User } from '../shared/contracts.js';
import { parseTableFile, isTableParseError } from '../shared/tables/index.js';
import { userViewer } from './accessSql.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { query, queryOne } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { carryFrontmatterKeys } from './frontmatter.js';
import { getPageMetadata } from './indexV2/read.js';
import { registerPropertiesRoutes } from './propertiesRoutes.js';
import { editSidecarText, pageRelOfSidecar, parseSidecar, sidecarRelPath } from './propsSidecar.js';
import { readSpacePropertyTypes } from './propertyTypes.js';
import { searchPages } from './search.js';
import { readAppearance } from './spaceAppearance.js';
import * as storage from './storage.js';
import { renameTag } from './tags.js';
import { restoreTrashItem, type TrashRow } from './trash/service.js';

const execFileAsync = promisify(execFile);

describe('carryFrontmatterKeys (pure)', () => {
  const keepOwn = (key: string) => !['folio', 'id', 'columns'].includes(key);

  it('carries the own keys of the old block byte for byte, after the rebuilt ones', () => {
    const prev = "---\nfolio: table\ndue: 2024-05-01   # deadline\nid: T1\ntags:\n  - a\n  - b\ncolumns: []\n---\nBody\n";
    const next = '---\nfolio: table\nid: T1\ncolumns:\n  - id: x\n---\nBody 2\n';
    expect(carryFrontmatterKeys(next, prev, keepOwn)).toBe(
      '---\nfolio: table\nid: T1\ncolumns:\n  - id: x\ndue: 2024-05-01   # deadline\ntags:\n  - a\n  - b\n---\nBody 2\n',
    );
  });

  it('leaves the text alone when there is nothing to carry, and the rebuilt value wins over the old one', () => {
    const next = '---\nfolio: table\nid: T1\n---\nB\n';
    expect(carryFrontmatterKeys(next, undefined, keepOwn)).toBe(next);
    expect(carryFrontmatterKeys(next, '---\nfolio: table\nid: T0\n---\nB\n', keepOwn)).toBe(next);
    expect(carryFrontmatterKeys('---\nfolio: table\nowner: new\n---\nB\n', '---\nowner: old\n---\nB\n', keepOwn)).toBe('---\nfolio: table\nowner: new\n---\nB\n');
  });
});

describe('property sidecar text (pure)', () => {
  it('maps page paths to sidecar paths and back', () => {
    expect(sidecarRelPath('docs/report.pdf')).toBe('.folio/docs/report.pdf.props.yaml');
    expect(pageRelOfSidecar('.folio/docs/report.pdf.props.yaml')).toBe('docs/report.pdf');
    expect(pageRelOfSidecar('.folio/site.json')).toBeNull();
    expect(pageRelOfSidecar('.folio/../x.props.yaml')).toBeNull();
  });

  it('parses a mapping; a list, a scalar or a second document is unparseable', () => {
    expect(parseSidecar(null)).toEqual({ data: {}, parseable: true });
    expect(parseSidecar('owner: ann\ntags: [a]\n').data).toEqual({ owner: 'ann', tags: ['a'] });
    expect(parseSidecar('- a\n- b\n').parseable).toBe(false);
    expect(parseSidecar('just text\n').parseable).toBe(false);
    expect(parseSidecar('a: 1\n---\nb: 2\n').parseable).toBe(false);
  });

  it('edits in place keeping comments; empty when the last key goes', () => {
    const text = '# about this file\nowner: ann   # who\nstatus: draft\n';
    expect(editSidecarText(text, new Map([['status', { set: 'final' }]]))).toBe('# about this file\nowner: ann   # who\nstatus: final\n');
    expect(editSidecarText(null, new Map([['owner', { set: 'bob' }]]))).toBe('owner: bob\n');
    expect(editSidecarText('owner: bob\n', new Map([['owner', { remove: true }]]))).toBe('');
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

describe('properties of tables, forms, boards and files (real PG + git)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let owner: User;
  let editor: User;
  let reader: User;
  let slug: string;
  let dir: string;
  const auth: Record<string, Record<string, string>> = {};

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    app = await buildApp();
    const stamp = Date.now();
    owner = await authStore.createUser({ email: `pnd-owner-${stamp}@example.com`, name: 'Owner', passwordHash: 'x', isAdmin: true });
    editor = await authStore.createUser({ email: `pnd-editor-${stamp}@example.com`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    reader = await authStore.createUser({ email: `pnd-reader-${stamp}@example.com`, name: 'Reader', passwordHash: 'x', isAdmin: false });
    slug = (await storage.createSpace(`PropsNonDoc ${stamp}`, owner.id)).slug;
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

  const get = async (id: string, who = 'editor') => {
    const res = await app.inject({ method: 'GET', url: `/api/pages/${id}/properties`, headers: auth[who] });
    return { status: res.statusCode, body: res.json() as PagePropertiesResponse & { error?: string } };
  };
  const put = async (id: string, body: unknown, who = 'editor') => {
    const res = await app.inject({ method: 'PUT', url: `/api/pages/${id}/properties`, headers: auth[who], payload: body as object });
    return { status: res.statusCode, body: res.json() as PagePropertiesResponse & { error?: string } };
  };
  const git = async (...args: string[]) => (await execFileAsync('git', args, { cwd: storage.getRepoDir(slug) })).stdout.trim();
  const search = async (q: string) => (await searchPages(q, { userId: editor.id, space: slug })).map((h) => h.id);
  const blockOf = (raw: string) => raw.slice(0, raw.indexOf('\n---\n', 3) + 5);

  it('a data table: own keys only, reserved keys hidden and byte-identical, kept across table saves, indexed', async () => {
    const page = await storage.createPage({ space: slug, parentPath: '', title: 'Plan', kind: 'table' });
    const entry = (await storage.getEntry(page.id))!;
    const before = await fs.readFile(entry.absPath, 'utf8');

    const first = await get(page.id);
    expect(first.status).toBe(200);
    expect(first.body.properties).toEqual({});
    expect(first.body.canEdit).toBe(true);
    expect(first.body.readOnly).toEqual([]);
    expect(first.body.sidecar).toBeUndefined();

    // a reserved key is refused, nothing written
    expect((await put(page.id, { properties: { columns: [] } })).status).toBe(400);
    expect((await put(page.id, { properties: { id: 'X' } })).status).toBe(400);
    expect(await fs.readFile(entry.absPath, 'utf8')).toBe(before);

    const saved = await put(page.id, { properties: { owner: 'ann', due: '2024-05-01', tags: ['planning', '#q3'] }, etag: first.body.etag });
    expect(saved.status).toBe(200);
    expect(saved.body.properties).toEqual({ owner: 'ann', due: '2024-05-01', tags: ['planning', 'q3'] });
    const after = await fs.readFile(entry.absPath, 'utf8');
    // every reserved line stays, the new keys are appended to the block, the body is untouched
    const reservedBlock = blockOf(before);
    expect(after.startsWith(reservedBlock.slice(0, -5))).toBe(true);
    expect(after).toContain('owner: ann\ndue: 2024-05-01\ntags:\n  - planning\n  - q3\n---\n');
    expect(after.slice(blockOf(after).length)).toBe(before.slice(reservedBlock.length));
    const parsed = parseTableFile(after);
    expect(isTableParseError(parsed)).toBe(false);

    // a stale etag is a 409; a reader cannot edit
    expect((await put(page.id, { properties: {}, etag: first.body.etag })).status).toBe(409);
    expect((await get(page.id, 'reader')).body.canEdit).toBe(false);
    expect((await put(page.id, { properties: {} }, 'reader')).status).toBe(403);

    // an ordinary table save (the codec rebuilds the block) keeps the own keys, byte for byte
    if (isTableParseError(parsed)) throw new Error('unreachable');
    await storage.writeTableDoc(page.id, { ...parsed, head: `${parsed.head}More prose.\n\n` });
    const resaved = await fs.readFile(entry.absPath, 'utf8');
    expect(resaved).toContain('owner: ann\ndue: 2024-05-01\ntags:\n  - planning\n  - q3\n');
    expect(resaved).toContain('More prose.');
    // the tree's order keeps them too
    await storage.setTableOrder((await storage.getEntry(page.id))!, 7);
    expect(await fs.readFile(entry.absPath, 'utf8')).toContain('due: 2024-05-01\n');

    // the index: tags, prop:, get_page_metadata (own keys only), the space's known keys
    expect(await search('tag:q3')).toContain(page.id);
    expect(await search('prop:owner=ann')).toContain(page.id);
    const meta = await getPageMetadata((await storage.getEntry(page.id))!, userViewer(editor));
    // (the index keeps a YAML date as jsonb does for documents: an ISO timestamp)
    expect(meta.properties).toEqual({ owner: 'ann', due: '2024-05-01T00:00:00.000Z', tags: ['planning', 'q3'] });
    expect(meta.tags.map((t) => t.tag).sort()).toEqual(['planning', 'q3']);
    const known = (await readSpacePropertyTypes(slug, userViewer(editor))).known.map((k) => k.key);
    expect(known).toEqual(expect.arrayContaining(['owner', 'due']));
    expect(known).not.toContain('columns');

    // a full rescan from the file gives the same index (indexTableFile)
    await query('UPDATE pages_index SET file_mtime = NULL WHERE id = $1', [page.id]);
    await storage.scanSpace(slug);
    expect((await getPageMetadata((await storage.getEntry(page.id))!, userViewer(editor))).properties).toEqual({ owner: 'ann', due: '2024-05-01T00:00:00.000Z', tags: ['planning', 'q3'] });

    // removing every own key leaves the reserved block as the codec wrote it
    expect((await put(page.id, { properties: {} })).status).toBe(200);
    const cleared = await fs.readFile(entry.absPath, 'utf8');
    expect(cleared).not.toContain('owner:');
    expect(isTableParseError(parseTableFile(cleared))).toBe(false);
  });

  it('a form: title / fields / table stay reserved; a definition save keeps the own keys', async () => {
    const table = await storage.createPage({ space: slug, parentPath: '', title: 'Requests', kind: 'table' });
    const form = await storage.createFormFromTable(table.id);
    const entry = (await storage.getEntry(form.id))!;
    const got = await get(form.id);
    expect(got.body.properties).toEqual({});
    expect((await put(form.id, { properties: { title: 'Hijack' } })).status).toBe(400);
    expect((await put(form.id, { properties: { audience: 'staff', tags: ['intake'] } })).status).toBe(200);
    const doc = await storage.readFreshFormDoc(form.id);
    await storage.writeFormDoc(form.id, { ...doc, title: 'Requests form', description: 'Tell us' });
    const raw = await fs.readFile(entry.absPath, 'utf8');
    expect(raw).toContain('title: Requests form');
    expect(raw).toContain('audience: staff\ntags:\n  - intake\n');
    expect((await get(form.id)).body.properties).toEqual({ audience: 'staff', tags: ['intake'] });
    expect(await search('tag:intake')).toContain(form.id);
  });

  it('a board: a sidecar created by the first property in its own commit, edited in place, deleted with the last', async () => {
    const board = await storage.createPage({ space: slug, parentPath: '', title: 'Flow', kind: 'board' });
    const entry = (await storage.getEntry(board.id))!;
    const svgBefore = await fs.readFile(entry.absPath, 'utf8');
    const sidecar = path.join(dir, '.folio', `${entry.relPath}.props.yaml`);

    const first = await get(board.id);
    expect(first.body).toMatchObject({ properties: {}, canEdit: true, etag: null, sidecar: `.folio/${entry.relPath}.props.yaml` });
    await expect(fs.stat(sidecar)).rejects.toThrow();

    const headBefore = await git('rev-parse', 'HEAD');
    const saved = await put(board.id, { properties: { owner: 'ann', tags: ['arch'] }, etag: null });
    expect(saved.status).toBe(200);
    expect(await fs.readFile(sidecar, 'utf8')).toBe('owner: ann\ntags:\n  - arch\n');
    expect(await fs.readFile(entry.absPath, 'utf8')).toBe(svgBefore);
    // one commit with exactly that file
    expect(await git('rev-list', '--count', `${headBefore}..HEAD`)).toBe('1');
    const rel = path.posix.join(storage.getRootPath(slug) || '', '.folio', `${entry.relPath}.props.yaml`);
    expect((await git('show', '--name-only', '--format=%s', 'HEAD')).split('\n').filter(Boolean)).toEqual([`settings: update ${rel}`, rel]);
    expect(await git('log', '-1', '--format=%an')).toBe('Editor');

    // hand comments survive an edit; the etag is the file's
    await fs.writeFile(sidecar, '# set by hand\nowner: ann\ntags:\n  - arch\n', 'utf8');
    const now = await get(board.id);
    expect((await put(board.id, { properties: { owner: 'bob', tags: ['arch'] }, etag: first.body.etag })).status).toBe(409);
    expect((await put(board.id, { properties: { owner: 'bob', tags: ['arch'] }, etag: now.body.etag })).status).toBe(200);
    expect(await fs.readFile(sidecar, 'utf8')).toBe('# set by hand\nowner: bob\ntags:\n  - arch\n');
    expect(await search('tag:arch')).toContain(board.id);
    expect(await search('prop:owner=bob')).toContain(board.id);

    // the sidecar is no page and no file of the space
    expect((await storage.listEntries(slug)).some((e) => e.relPath.includes('.props.yaml'))).toBe(false);
    expect(await queryOne('SELECT 1 FROM space_files WHERE space_slug = $1 AND path LIKE $2', [slug, '%.props.yaml'])).toBeUndefined();
    // the site/PDF settings still read
    await expect(readAppearance(slug)).resolves.toBeTruthy();

    // the last property removed: the file goes (a comment alone is kept — nothing to delete then)
    await fs.writeFile(sidecar, 'owner: bob\n', 'utf8');
    expect((await put(board.id, { properties: {} })).status).toBe(200);
    await expect(fs.stat(sidecar)).rejects.toThrow();
    expect((await git('show', '--name-only', '--format=%s', 'HEAD')).split('\n').filter(Boolean)).toEqual([`settings: remove ${rel}`, rel]);
    expect(await search('tag:arch')).not.toContain(board.id);
  });

  it('a PDF: the sidecar follows a move and a slug rename, goes to the trash with the page and comes back on restore', async () => {
    await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(dir, 'docs', 'report.pdf'), '%PDF-1.4\n%%EOF\n');
    await storage.scanSpace(slug);
    const id = (await storage.getEntryIdByExactPath(slug, 'docs/report.pdf'))!;
    expect(id).toBeTruthy();
    expect((await put(id, { properties: { reviewed: true, tags: ['finance'] } })).status).toBe(200);
    expect(await fs.readFile(path.join(dir, '.folio/docs/report.pdf.props.yaml'), 'utf8')).toBe('reviewed: true\ntags:\n  - finance\n');

    await fs.mkdir(path.join(dir, 'archive'), { recursive: true });
    await storage.movePage(id, 'archive');
    await expect(fs.stat(path.join(dir, '.folio/docs'))).rejects.toThrow(); // emptied folders pruned
    expect(await fs.readFile(path.join(dir, '.folio/archive/report.pdf.props.yaml'), 'utf8')).toBe('reviewed: true\ntags:\n  - finance\n');
    expect((await get(id)).body.properties).toEqual({ reviewed: true, tags: ['finance'] });

    await storage.renamePageSlug(id, 'q3-report');
    const moved = (await storage.getEntry(id))!;
    expect(moved.relPath).toBe('archive/q3-report.pdf');
    expect(await fs.readFile(path.join(dir, '.folio/archive/q3-report.pdf.props.yaml'), 'utf8')).toContain('reviewed: true');
    expect(await search('tag:finance')).toContain(id);

    await storage.deletePage(id, owner.id);
    await expect(fs.stat(path.join(dir, '.folio/archive/q3-report.pdf.props.yaml'))).rejects.toThrow();
    const row = await queryOne<TrashRow>('SELECT * FROM trash_items WHERE page_id = $1', [id]);
    expect((row!.payload as { props?: unknown }).props).toEqual([{ path: 'archive/q3-report.pdf', content: 'reviewed: true\ntags:\n  - finance\n' }]);
    await restoreTrashItem(owner, row!.id);
    expect(await fs.readFile(path.join(dir, '.folio/archive/q3-report.pdf.props.yaml'), 'utf8')).toBe('reviewed: true\ntags:\n  - finance\n');
    expect((await get(id)).body.properties).toEqual({ reviewed: true, tags: ['finance'] });
  });

  it('a folder moving with its boards takes their sidecars along', async () => {
    const folder = await storage.createPage({ space: slug, parentPath: '', title: 'Area', kind: 'doc' });
    const folderEntry = (await storage.getEntry(folder.id))!;
    const stem = folderEntry.relPath.replace(/\.md$/, '');
    await fs.mkdir(path.join(dir, stem), { recursive: true });
    const board = await storage.createPage({ space: slug, parentPath: stem, title: 'Inner', kind: 'board' });
    const inner = (await storage.getEntry(board.id))!;
    expect((await put(board.id, { properties: { area: 'x' } })).status).toBe(200);
    await fs.mkdir(path.join(dir, 'target'), { recursive: true });
    await storage.movePage(folder.id, 'target');
    const after = (await storage.getEntry(board.id))!;
    expect(after.relPath).toBe(`target/${inner.relPath}`);
    expect(await fs.readFile(path.join(dir, '.folio', `${after.relPath}.props.yaml`), 'utf8')).toBe('area: x\n');
  });

  it('a sidecar changed outside Folio (git) is indexed on the next scan; removed, its properties go', async () => {
    const board = await storage.createPage({ space: slug, parentPath: '', title: 'External', kind: 'board' });
    const entry = (await storage.getEntry(board.id))!;
    const sidecar = path.join(dir, '.folio', `${entry.relPath}.props.yaml`);
    await fs.mkdir(path.dirname(sidecar), { recursive: true });
    await fs.writeFile(sidecar, 'stage: review\ntags: [ext]\n', 'utf8');
    await storage.scanSpace(slug);
    expect(await search('tag:ext')).toContain(board.id);
    expect((await getPageMetadata(entry, userViewer(editor))).properties).toEqual({ stage: 'review', tags: ['ext'] });
    await fs.rm(sidecar);
    await storage.scanSpace(slug);
    expect(await search('tag:ext')).not.toContain(board.id);
    expect((await getPageMetadata(entry, userViewer(editor))).properties).toEqual({});
  });

  it('tag rename reaches a table\'s own tags and a board\'s sidecar in the same commit', async () => {
    const table = await storage.createPage({ space: slug, parentPath: '', title: 'Tagged table', kind: 'table' });
    const board = await storage.createPage({ space: slug, parentPath: '', title: 'Tagged board', kind: 'board' });
    expect((await put(table.id, { properties: { tags: ['old-tag'] } })).status).toBe(200);
    expect((await put(board.id, { properties: { tags: ['old-tag', 'keep'] } })).status).toBe(200);
    const result = await renameTag({ space: slug, from: 'old-tag', to: 'new-tag', user: editor, actor: { name: 'Editor', email: 'e@example.com' } });
    expect(result.pagesChanged).toBe(2);
    expect((await get(table.id)).body.properties).toEqual({ tags: ['new-tag'] });
    expect((await get(board.id)).body.properties).toEqual({ tags: ['new-tag', 'keep'] });
    expect(await search('tag:new-tag')).toEqual(expect.arrayContaining([table.id, board.id]));
    const files = (await git('show', '--name-only', '--format=%s', 'HEAD')).split('\n').filter(Boolean);
    expect(files[0]).toBe('docs: rename tag #old-tag -> #new-tag');
    expect(files.slice(1).sort()).toHaveLength(2);
  });
});
