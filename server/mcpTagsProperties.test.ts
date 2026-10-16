/**
 * MCP list_tags, rename_tag, set_page_properties, list_properties and save_base (16.10.2026), real PG + real files + git,
 * through the SDK's in-memory transport (so the tool registration, the zod input schema and the outputSchema are all
 * exercised: the client and the server each validate every successful answer against the tool's outputSchema).
 *
 * What is proven here is the wiring: role and scope gates, the page ACL (a closed page never shows in a count, a sample or
 * a preview; a page the caller cannot edit is skipped, never written), the 409 answers, and that each tool reaches the
 * same code as the web app's route. The rules themselves (tag rewriting, property write rules, the base parser) have
 * their own suites: tags.test.ts, properties*.test.ts, bases/bases.test.ts.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { User } from '../shared/contracts.js';
import { userViewer } from './accessSql.js';
import * as authStore from './auth/store.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { listSpaceTags } from './indexV2/read.js';
import { buildFolioMcpServer, type McpActor } from './mcp.js';
import { mergePropertyPatch } from './properties.js';
import * as pageAccess from './pageAccess.js';
import * as storage from './storage.js';

const execFileAsync = promisify(execFile);

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

async function connect(actor: McpActor): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildFolioMcpServer(actor);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: async () => client.close() };
}

async function call(actor: McpActor, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const { client, close } = await connect(actor);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await close();
  }
}

const text = (r: ToolResult): string => (r.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
/** The structured answer of a successful call (also proves the call succeeded and carries structuredContent). */
function ok<T = Record<string, any>>(r: ToolResult): T {
  expect(r.isError, text(r)).toBeFalsy();
  expect(r.structuredContent).toBeTruthy();
  return r.structuredContent as T;
}

interface TagNode {
  tag: string;
  name: string;
  pages: number;
  total: number;
  children: TagNode[];
}
const flatten = (nodes: TagNode[]): TagNode[] => nodes.flatMap((n) => [n, ...flatten(n.children)]);
const tagOf = (nodes: TagNode[], tag: string): TagNode | undefined => flatten(nodes).find((n) => n.tag === tag);

describe('MCP tags, properties and bases (real PG + git)', () => {
  let teardownSchema: () => Promise<void>;
  let owner: User;
  let editor: User;
  let viewer: User;
  let granted: User;
  let outsider: User;
  let slug: string;
  let dir: string;
  const ids: Record<string, string> = {};

  const as = (user: User, scopes: Array<'read' | 'write'> = ['read', 'write']): McpActor => ({ user, scopes, tokenId: `test-${user.id}` });
  const read = (rel: string): Promise<string> => fs.readFile(path.join(dir, rel), 'utf8');
  const git = async (...args: string[]): Promise<string> => (await execFileAsync('git', args, { cwd: storage.getRepoDir(slug) })).stdout.trim();

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    const mk = (name: string, isAdmin = false) => authStore.createUser({ email: `mtp-${name}-${stamp}@example.com`, name, passwordHash: 'x', isAdmin });
    owner = await mk('Owner');
    editor = await mk('Editor');
    viewer = await mk('Viewer');
    granted = await mk('Granted');
    outsider = await mk('Outsider');
    slug = (await storage.createSpace(`MCP Tags ${stamp}`, owner.id)).slug;
    await authStore.setMembership(slug, owner.id, 'admin');
    await authStore.setMembership(slug, editor.id, 'editor');
    await authStore.setMembership(slug, viewer.id, 'viewer');
    await authStore.setMembership(slug, granted.id, 'editor');
    dir = storage.getSpaceDir(slug);

    const put = async (rel: string, body: string | Buffer): Promise<void> => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), body);
    };
    await put('a.md', '---\nstatus: published\nowner: ann\ndue: 2026-10-01\ntags: [work/alpha, shared]\n---\n# Alpha\n\nBody #work/beta and #shared here.\n');
    await put('b.md', '---\nlabels: [work/alpha]\nowner: bob\n---\n# Bee\n\nNo tags in the body.\n');
    await put('c.md', '---\nstatus: deprecated\nowner: ann\n---\n# Cee\n\nOnly a body tag #solo.\n');
    // Restricted to the owner, editable by `granted`: a tag, a key and a value nobody else may learn about.
    await put('secret.md', '---\nclearance: top\nowner: eve\ntags: [secretonly, work/alpha]\n---\n# Secret\n\n#work/alpha and #secretbody.\n');
    // Restricted: the editor may read it, not edit it.
    await put('readonly.md', '---\ntags: [work/alpha]\n---\n# Read only\n');
    await put('_templates/t.md', '---\ntags: [tplonly]\ntplkey: x\n---\n# Template\n');
    await put('a.pdf', Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'));
    await put('board.canvas', '{"nodes":[],"edges":[]}\n');
    await put('Tasks.base', 'filters:\n  and:\n    - file.ext == "md"\nviews:\n  - type: table\n    name: All\n    order: [file.name, owner]\n');
    await put('.folio/properties.json', JSON.stringify({ v: 1, types: { due: 'date', declaredunused: 'checkbox' } }));
    await storage.scanSpace(slug);
    await storage.scanSpace(slug);
    for (const rel of ['a.md', 'b.md', 'c.md', 'secret.md', 'readonly.md', 'a.pdf', 'board.canvas', 'Tasks.base']) {
      const id = await storage.getEntryIdByExactPath(slug, rel);
      if (!id) throw new Error(`no page ${rel}`);
      ids[rel] = id;
    }
    ids.table = (await storage.createPage({ space: slug, parentPath: '', title: 'Plan', kind: 'table' })).id;
    await pageAccess.setAccess(owner, (await storage.getEntry(ids['secret.md']))!, 'restricted', [{ userId: granted.id, role: 'editor' }]);
    await pageAccess.setAccess(owner, (await storage.getEntry(ids['readonly.md']))!, 'restricted', [{ userId: editor.id, role: 'viewer' }]);
    await git('add', '-A');
    await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixtures', '--allow-empty');
  });
  afterAll(async () => {
    await deleteTestSpace(slug);
    await teardownSchema();
  });

  // -------------------------------------------------------------------------
  describe('list_tags', () => {
    it('lists the tag tree with exact and subtree counts; a read-scoped token is enough', async () => {
      const r = ok<{ tags: TagNode[]; totalTags: number; truncated: boolean }>(await call(as(editor, ['read']), 'list_tags', { space: slug }));
      expect(r.truncated).toBe(false);
      const work = tagOf(r.tags, 'work')!;
      expect(work.name).toBe('work');
      expect(work.pages).toBe(0); // no page carries `work` itself, only its children
      expect(work.children.map((c) => c.tag)).toEqual(['work/alpha', 'work/beta']);
      // a.md (tags:), b.md (labels:), readonly.md (an editor grant of viewer level) — the restricted secret.md is not counted
      expect(tagOf(r.tags, 'work/alpha')).toMatchObject({ name: 'alpha', pages: 3, total: 3 });
      expect(tagOf(r.tags, 'work/beta')).toMatchObject({ pages: 1, total: 1 });
      expect(work.total).toBe(3 + 0); // a.md, b.md, readonly.md carry a child; a.md carries both children: counted once
      expect(tagOf(r.tags, 'shared')).toMatchObject({ pages: 1, children: [] });
      expect(tagOf(r.tags, 'solo')!.pages).toBe(1);
      // roots are the top-level tags only
      expect(r.tags.map((t) => t.tag)).toEqual(['shared', 'solo', 'work']);
    });

    it('a tag used only on pages the caller cannot open is not listed; the same counts as GET /api/spaces/:space/tags', async () => {
      const asEditor = ok<{ tags: TagNode[] }>(await call(as(editor), 'list_tags', { space: slug }));
      const names = flatten(asEditor.tags).map((t) => t.tag);
      for (const hidden of ['secretonly', 'secretbody', 'tplonly']) expect(names).not.toContain(hidden);
      expect(JSON.stringify(asEditor)).not.toContain('secret');
      // the exact counts equal the REST list (tags that have pages of their own)
      const rest = await listSpaceTags(slug, userViewer(editor));
      for (const row of rest) expect(tagOf(asEditor.tags, row.tag)!.pages, row.tag).toBe(row.pages);

      const asGranted = ok<{ tags: TagNode[] }>(await call(as(granted), 'list_tags', { space: slug }));
      expect(tagOf(asGranted.tags, 'secretonly')).toMatchObject({ pages: 1 });
      expect(tagOf(asGranted.tags, 'secretbody')).toMatchObject({ pages: 1 });
      expect(tagOf(asGranted.tags, 'work/alpha')!.pages).toBe(3); // a.md, b.md and secret.md; readonly.md is closed to `granted`
      expect(flatten(asGranted.tags).map((t) => t.tag)).not.toContain('tplonly'); // templates are never content
    });

    it('prefix keeps the tags starting with it (case-insensitive, # ignored); limit truncates and says so', async () => {
      const sub = ok<{ tags: TagNode[]; totalTags: number }>(await call(as(editor), 'list_tags', { space: slug, prefix: '#Work/' }));
      expect(flatten(sub.tags).map((t) => t.tag)).toEqual(['work/alpha', 'work/beta']);
      expect(sub.tags.map((t) => t.tag)).toEqual(['work/alpha', 'work/beta']); // parent not in the answer: both are roots
      expect(sub.totalTags).toBe(2);

      const cut = ok<{ tags: TagNode[]; totalTags: number; truncated: boolean }>(await call(as(editor), 'list_tags', { space: slug, limit: 2 }));
      expect(flatten(cut.tags)).toHaveLength(2);
      expect(cut.truncated).toBe(true);
      expect(cut.totalTags).toBe(5); // shared, solo, work, work/alpha, work/beta
      expect(ok<{ tags: TagNode[] }>(await call(as(editor), 'list_tags', { space: slug, prefix: 'zzz' })).tags).toEqual([]);
    });

    it('refuses a space the caller is not a member of as "not found"', async () => {
      const r = await call(as(outsider), 'list_tags', { space: slug });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe('space not found');
      expect((await call(as(editor), 'list_tags', { space: 'no-such-space' })).isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('list_properties', () => {
    type Row = { key: string; type: string; declared: boolean; pages: number; samples: unknown[] };
    const rowOf = (rows: Row[], key: string): Row | undefined => rows.find((x) => x.key === key);

    it('lists keys with type, page count and samples over the pages the caller can open', async () => {
      const r = ok<{ properties: Row[]; source: string; truncated: boolean }>(await call(as(editor, ['read']), 'list_properties', { space: slug }));
      expect(r.source).toBe('folio');
      expect(r.truncated).toBe(false);
      expect(rowOf(r.properties, 'owner')).toMatchObject({ type: 'text', declared: false, pages: 3 }); // a, b, c — not eve's secret page
      expect(rowOf(r.properties, 'owner')!.samples).toEqual(expect.arrayContaining(['ann', 'bob']));
      expect(rowOf(r.properties, 'owner')!.samples).not.toContain('eve');
      expect(rowOf(r.properties, 'due')).toMatchObject({ type: 'date', declared: true, pages: 1 });
      expect(rowOf(r.properties, 'tags')).toMatchObject({ type: 'tags' });
      // declared by the space but used nowhere the caller can see: still listed, with no pages
      expect(rowOf(r.properties, 'declaredunused')).toMatchObject({ type: 'checkbox', declared: true, pages: 0, samples: [] });
      // never a key of a closed page or of a template, never the document's own id
      expect(rowOf(r.properties, 'clearance')).toBeUndefined();
      expect(rowOf(r.properties, 'tplkey')).toBeUndefined();
      expect(rowOf(r.properties, 'id')).toBeUndefined();
      // most used first
      const pages = r.properties.map((p) => p.pages);
      expect(pages).toEqual([...pages].sort((a, b) => b - a));
    });

    it('a reader with a grant on the closed page sees its key and value', async () => {
      const r = ok<{ properties: Row[] }>(await call(as(granted), 'list_properties', { space: slug }));
      expect(rowOf(r.properties, 'clearance')).toMatchObject({ pages: 1, samples: ['top'] });
      expect(rowOf(r.properties, 'owner')!.pages).toBe(4);
      expect(rowOf(r.properties, 'owner')!.samples).toContain('eve');
    });

    it('is refused for a stranger, as "space not found"', async () => {
      const r = await call(as(outsider), 'list_properties', { space: slug });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe('space not found');
    });
  });

  // -------------------------------------------------------------------------
  describe('set_page_properties', () => {
    it('whole-map mode: replaces the map like the properties API, returns the properties and the new etag', async () => {
      const r = ok<{ id: string; written: boolean; changedKeys: string[]; etag: string; properties: Record<string, unknown>; foreign: string[]; readOnly: string[] }>(
        await call(as(editor), 'set_page_properties', { id: ids['a.md'], properties: { owner: 'ann', status: 'published', due: '2026-10-01', tags: ['work/alpha', 'shared'], reviewed: true } }),
      );
      expect(r.id).toBe(ids['a.md']);
      expect(r.written).toBe(true);
      expect(r.changedKeys).toEqual(['reviewed']); // everything else was already as asked: left byte for byte
      expect(r.properties).toMatchObject({ owner: 'ann', reviewed: true, due: '2026-10-01', tags: ['work/alpha', 'shared'] });
      expect(r.readOnly).toEqual(['id']);
      expect(r.etag).toMatch(/^[0-9a-f]{40}$/);
      const file = await read('a.md');
      expect(file).toContain('reviewed: true');
      expect(file).toContain('due: 2026-10-01\n'); // unquoted, as it was
      expect(file).toContain('# Alpha\n\nBody #work/beta and #shared here.\n'); // the body is untouched

      // sending the same map again writes nothing
      const again = ok<{ written: boolean; changedKeys: string[]; etag: string }>(
        await call(as(editor), 'set_page_properties', { id: ids['a.md'], properties: r.properties }),
      );
      expect(again).toMatchObject({ written: false, changedKeys: [], etag: r.etag });
    });

    it('whole-map mode removes the keys left out and null; a foreign Folio value stays unless named', async () => {
      const r = ok<{ properties: Record<string, unknown>; foreign: string[]; changedKeys: string[] }>(
        await call(as(editor), 'set_page_properties', { id: ids['c.md'], properties: { team: 'core' } }),
      );
      expect(r.properties).toEqual(expect.objectContaining({ team: 'core', status: 'deprecated' })); // `status: deprecated` is not Folio's: kept
      expect(r.properties).not.toHaveProperty('owner');
      expect(r.foreign).toEqual(['status']);
      expect(r.changedKeys.sort()).toEqual(['owner', 'team']);
      // naming the foreign key replaces it; `null` on an ordinary key writes an empty property (as the properties API does), omitting removes
      const named = ok<{ properties: Record<string, unknown> }>(await call(as(editor), 'set_page_properties', { id: ids['c.md'], properties: { team: null, status: 'draft' } }));
      expect(named.properties).toEqual(expect.objectContaining({ status: 'draft', team: null }));
      const omitted = ok<{ properties: Record<string, unknown> }>(await call(as(editor), 'set_page_properties', { id: ids['c.md'], properties: { status: 'draft' } }));
      expect(omitted.properties).not.toHaveProperty('team');
    });

    it('merge mode: only the given keys change, null removes a key, the rest stays (labels: included)', async () => {
      const set = ok<{ properties: Record<string, unknown>; changedKeys: string[] }>(
        await call(as(editor), 'set_page_properties', { id: ids['b.md'], properties: { priority: 2 }, merge: true }),
      );
      expect(set.changedKeys).toEqual(['priority']);
      expect(set.properties).toMatchObject({ priority: 2, owner: 'bob', labels: ['work/alpha'] });
      // tags on a page whose only list is `labels:` edits that list in place instead of adding a `tags:` next to it
      const tags = ok<{ properties: Record<string, unknown> }>(await call(as(editor), 'set_page_properties', { id: ids['b.md'], properties: { tags: ['work/alpha', 'extra'] }, merge: true }));
      expect(tags.properties).toMatchObject({ labels: ['work/alpha', 'extra'] });
      expect(tags.properties).not.toHaveProperty('tags');
      expect(await read('b.md')).toContain('labels:');
      const removed = ok<{ properties: Record<string, unknown>; changedKeys: string[] }>(await call(as(editor), 'set_page_properties', { id: ids['b.md'], properties: { priority: null }, merge: true }));
      expect(removed.changedKeys).toEqual(['priority']);
      expect(removed.properties).not.toHaveProperty('priority');
      expect(removed.properties).toMatchObject({ owner: 'bob' });
      // a document's id cannot be changed or removed, in either mode
      const noId = await call(as(editor), 'set_page_properties', { id: ids['b.md'], properties: { id: null }, merge: true });
      expect(noId.isError).toBe(true);
      expect(text(noId)).toContain('id cannot be changed');
      expect((await call(as(editor), 'set_page_properties', { id: ids['b.md'], properties: { id: 'OTHER' } })).isError).toBe(true);
    });

    it('mergePropertyPatch (pure): the patch on top of the current map', () => {
      const current = { owner: 'ann', tags: ['a'], status: 'deprecated' };
      expect(mergePropertyPatch('doc', current, { owner: null, due: '2026-01-01' })).toEqual({ tags: ['a'], status: 'deprecated', due: '2026-01-01' });
      expect(mergePropertyPatch('doc', { labels: ['x'] }, { tags: ['y'] })).toEqual({ tags: ['y'] });
      expect(mergePropertyPatch('doc', { labels: ['x'], tags: ['z'] }, { tags: ['y'] })).toEqual({ labels: ['x'], tags: ['y'] });
      expect(mergePropertyPatch('board', { id: 'plain key' }, { id: 'new' })).toEqual({ id: 'new' }); // no Folio keys on a sidecar
      expect(() => mergePropertyPatch('doc', { id: 'A' }, { id: 'B' })).toThrow('id cannot be changed');
    });

    it('a stale etag is refused with the current etag and properties; the returned etag works; merge mode guards itself', async () => {
      const first = ok<{ etag: string }>(await call(as(editor), 'set_page_properties', { id: ids['a.md'], properties: { stage: 'one' }, merge: true }));
      const second = ok<{ etag: string }>(await call(as(editor), 'set_page_properties', { id: ids['a.md'], properties: { stage: 'two' }, merge: true, etag: first.etag }));
      expect(second.etag).not.toBe(first.etag);

      const stale = await call(as(editor), 'set_page_properties', { id: ids['a.md'], properties: { stage: 'three' }, merge: true, etag: first.etag });
      expect(stale.isError).toBe(true);
      expect(text(stale)).toContain(`current etag: ${second.etag}`);
      expect(text(stale)).toContain('"stage":"two"');
      const staleWhole = await call(as(editor), 'set_page_properties', { id: ids['a.md'], properties: { stage: 'three' }, etag: first.etag });
      expect(staleWhole.isError).toBe(true);
      expect(text(staleWhole)).toContain(`current etag: ${second.etag}`);
      expect(await read('a.md')).toContain('stage: two');

      // concurrent merges without an etag all land (each re-reads on a conflict)
      await Promise.all(['k1', 'k2', 'k3'].map((k) => call(as(editor), 'set_page_properties', { id: ids['a.md'], properties: { [k]: k }, merge: true })));
      const file = await read('a.md');
      for (const k of ['k1', 'k2', 'k3']) expect(file).toContain(`${k}: ${k}`);
    });

    it('works for every page kind: table (reserved keys refused), board / pdf / canvas / base (sidecar)', async () => {
      // data table: own keys next to the reserved ones, which are refused in both modes (null too)
      const table = ok<{ properties: Record<string, unknown> }>(await call(as(editor), 'set_page_properties', { id: ids.table, properties: { owner: 'ann' }, merge: true }));
      expect(table.properties).toEqual({ owner: 'ann' });
      for (const args of [{ properties: { columns: [] } }, { properties: { columns: null }, merge: true }, { properties: { folio: 'doc' }, merge: true }]) {
        const refused = await call(as(editor), 'set_page_properties', { id: ids.table, ...args });
        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain('reserved');
      }
      expect((await storage.readFreshTableDoc(ids.table)).columns).toBeTruthy();

      // sidecar kinds
      const board = await storage.createPage({ space: slug, parentPath: '', title: 'Sketch', kind: 'board' });
      for (const [id, rel] of [[board.id, (await storage.requireEntry(board.id)).relPath], [ids['a.pdf'], 'a.pdf'], [ids['board.canvas'], 'board.canvas'], [ids['Tasks.base'], 'Tasks.base']] as const) {
        const r = ok<{ properties: Record<string, unknown>; etag: string }>(await call(as(editor), 'set_page_properties', { id, properties: { reviewer: 'ann', tags: ['sidecar'] }, merge: true }));
        expect(r.properties, rel).toEqual({ reviewer: 'ann', tags: ['sidecar'] });
        expect(await read(`.folio/${rel}.props.yaml`), rel).toContain('reviewer: ann');
        // whole-map: replaces
        const whole = ok<{ properties: Record<string, unknown> }>(await call(as(editor), 'set_page_properties', { id, properties: { reviewer: 'bob' }, etag: r.etag }));
        expect(whole.properties, rel).toEqual({ reviewer: 'bob' });
      }
      // the properties of a sidecar page show up in list_properties
      const listed = ok<{ properties: Array<{ key: string; pages: number }> }>(await call(as(editor), 'list_properties', { space: slug }));
      expect(listed.properties.find((p) => p.key === 'reviewer')!.pages).toBe(4);
    });

    it('gates: write scope, editor role on the page, the page ACL, unknown page', async () => {
      const readOnly = await call(as(editor, ['read']), 'set_page_properties', { id: ids['a.md'], properties: { x: 1 }, merge: true });
      expect(readOnly.isError).toBe(true);
      expect(text(readOnly)).toContain('write scope');
      const asViewer = await call(as(viewer), 'set_page_properties', { id: ids['a.md'], properties: { x: 1 }, merge: true });
      expect(asViewer.isError).toBe(true);
      expect(text(asViewer)).toContain('requires editor+');
      // a closed page does not exist for the editor; a viewer grant on a restricted page does not allow an edit
      expect(text(await call(as(editor), 'set_page_properties', { id: ids['secret.md'], properties: { x: 1 }, merge: true }))).toBe('page not found');
      const grantedViewer = await call(as(editor), 'set_page_properties', { id: ids['readonly.md'], properties: { x: 1 }, merge: true });
      expect(grantedViewer.isError).toBe(true);
      expect(await read('secret.md')).not.toContain('x: 1');
      expect(await read('readonly.md')).not.toContain('x: 1');
      expect(text(await call(as(outsider), 'set_page_properties', { id: ids['a.md'], properties: { x: 1 } }))).toBe('page not found');
      expect(text(await call(as(editor), 'set_page_properties', { id: 'NOPE', properties: { x: 1 } }))).toBe('page not found');
      // a grant holder edits the closed page
      expect(ok<{ properties: Record<string, unknown> }>(await call(as(granted), 'set_page_properties', { id: ids['secret.md'], properties: { reviewed: 'yes' }, merge: true })).properties).toMatchObject({ clearance: 'top', reviewed: 'yes' });
    });

    it('records the audit row of a change with the tool name', async () => {
      await call(as(editor), 'set_page_properties', { id: ids['c.md'], properties: { audited: 1 }, merge: true });
      // the audit row is written without being awaited
      await vi.waitFor(async () => {
        const rows = await query<{ meta: { keys: string[]; source: string; tool: string } }>(`SELECT meta FROM audit_log WHERE action = 'page.properties' AND target = $1 ORDER BY id DESC LIMIT 1`, [ids['c.md']]);
        expect(rows[0]!.meta).toMatchObject({ keys: ['audited'], source: 'mcp', tool: 'set_page_properties' });
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('save_base', () => {
    const YAML = 'filters:\n  and:\n    - file.ext == "md"\nx-custom:\n  keep: me\nviews:\n  - type: table\n    name: Owners\n    order: [file.name, owner]\n';
    type Saved = { id: string; space: string; path: string; created: boolean; written: boolean; etag: string; warnings: string[]; preview: { view: string | null; columns: Array<{ id: string }>; rows: Array<{ path: string }>; total: number } };
    let createdId: string;
    let etag: string;

    it('creates a base at a path: the YAML is stored as written, unknown keys included; the preview is the first view', async () => {
      const r = ok<Saved>(await call(as(editor), 'save_base', { space: slug, path: 'views/owners.base', yaml: YAML }));
      expect(r).toMatchObject({ space: slug, path: 'views/owners.base', created: true, written: true });
      expect(r.etag).toMatch(/^[0-9a-f]{40}$/);
      createdId = r.id;
      etag = r.etag;
      expect(await read('views/owners.base')).toBe(YAML);
      const entry = (await storage.getEntry(createdId))!;
      expect(entry.kind).toBe('base');
      expect(r.preview.view).toBe('Owners');
      expect(r.preview.columns.map((c) => c.id)).toContain('owner');
      // the preview is what query_base answers, capped at 10 rows; a closed page is not in it for this caller
      const rows = r.preview.rows.map((x) => x.path);
      expect(rows).toEqual(expect.arrayContaining(['a.md', 'b.md', 'c.md']));
      expect(rows).not.toContain('secret.md');
      expect(rows).not.toContain('_templates/t.md');
      expect(rows.length).toBeLessThanOrEqual(10);
      const viaQuery = ok<{ total: number }>(await call(as(editor), 'query_base', { id: createdId }));
      expect(viaQuery.total).toBe(r.preview.total);
      // the grant holder's preview does include the closed page
      expect(ok<Saved>(await call(as(granted), 'save_base', { space: slug, id: createdId, yaml: YAML })).preview.rows.map((x) => x.path)).toContain('secret.md');
    });

    it('creates one commit-worthy change: a single file written, folders created', async () => {
      const r = ok<Saved>(await call(as(editor), 'save_base', { space: slug, path: 'deep/er/folder/x.base', yaml: 'views:\n  - type: table\n    name: T\n' }));
      expect(r.path).toBe('deep/er/folder/x.base');
      expect((await git('status', '--porcelain', '-uall')).split('\n').filter((l) => l.includes('x.base'))).toHaveLength(1);
    });

    it('updates by id: etag-guarded, written false when nothing changes, 409 carries the current etag', async () => {
      const next = YAML.replace('Owners', 'People');
      const same = ok<Saved>(await call(as(editor), 'save_base', { space: slug, id: createdId, yaml: YAML, etag }));
      expect(same).toMatchObject({ created: false, written: false, etag });

      const updated = ok<Saved>(await call(as(editor), 'save_base', { space: slug, id: createdId, yaml: next, etag }));
      expect(updated).toMatchObject({ id: createdId, created: false, written: true, path: 'views/owners.base' });
      expect(updated.etag).not.toBe(etag);
      expect(updated.preview.view).toBe('People');
      expect(await read('views/owners.base')).toBe(next);

      const stale = await call(as(editor), 'save_base', { space: slug, id: createdId, yaml: YAML, etag });
      expect(stale.isError).toBe(true);
      expect(text(stale)).toContain(`current etag: ${updated.etag}`);
      expect(await read('views/owners.base')).toBe(next);
      // without an etag the write goes through
      expect(ok<Saved>(await call(as(editor), 'save_base', { space: slug, id: createdId, yaml: YAML })).written).toBe(true);
    });

    it('invalid YAML comes back as an error with the line number and writes nothing', async () => {
      const bad = 'views:\n  - type: table\n   name: x\n';
      const created = await call(as(editor), 'save_base', { space: slug, path: 'views/bad.base', yaml: bad });
      expect(created.isError).toBe(true);
      expect(text(created)).toMatch(/not a valid base: .*\(line \d+\)/);
      await expect(fs.access(path.join(dir, 'views/bad.base'))).rejects.toThrow();
      const before = await read('views/owners.base');
      const updated = await call(as(editor), 'save_base', { space: slug, id: createdId, yaml: bad });
      expect(updated.isError).toBe(true);
      expect(text(updated)).toMatch(/\(line \d+\)/);
      expect(await read('views/owners.base')).toBe(before);
      // a YAML list is not a base either
      expect((await call(as(editor), 'save_base', { space: slug, path: 'views/list.base', yaml: '- a\n- b\n' })).isError).toBe(true);
    });

    it('leniently read parts are reported as warnings and kept as written', async () => {
      const odd = 'views:\n  - type: table\n    name: Odd\n    filters: 12\nfilters:\n  nope: [1]\n';
      const r = ok<Saved>(await call(as(editor), 'save_base', { space: slug, path: 'views/odd.base', yaml: odd }));
      expect(r.warnings.length).toBeGreaterThan(0);
      expect(await read('views/odd.base')).toBe(odd);
    });

    it('refuses: a path that exists, a bad path, both or neither of path and id, a non-base id, another space, scope and roles', async () => {
      const exists = await call(as(editor), 'save_base', { space: slug, path: 'views/owners.base', yaml: YAML });
      expect(exists.isError).toBe(true);
      expect(text(exists)).toContain('already exists');
      for (const p of ['views/notes.md', 'views/.base', '../escape.base', '/abs/../../x.base']) expect((await call(as(editor), 'save_base', { space: slug, path: p, yaml: YAML })).isError, p).toBe(true);
      expect(text(await call(as(editor), 'save_base', { space: slug, yaml: YAML }))).toContain('exactly one of path');
      expect(text(await call(as(editor), 'save_base', { space: slug, path: 'x.base', id: createdId, yaml: YAML }))).toContain('exactly one of path');
      expect(text(await call(as(editor), 'save_base', { space: slug, path: 'x.base', etag: 'abc', yaml: YAML }))).toContain('etag only applies');
      expect(text(await call(as(editor), 'save_base', { space: slug, id: ids['a.md'], yaml: YAML }))).toContain('not a base');
      expect((await call(as(editor), 'save_base', { space: 'other-space', id: createdId, yaml: YAML })).isError).toBe(true);

      expect(text(await call(as(editor, ['read']), 'save_base', { space: slug, path: 'ro.base', yaml: YAML }))).toContain('write scope');
      expect(text(await call(as(viewer), 'save_base', { space: slug, path: 'v.base', yaml: YAML }))).toContain('requires editor+');
      expect(text(await call(as(viewer), 'save_base', { space: slug, id: createdId, yaml: YAML }))).toContain('requires editor+');
      expect(text(await call(as(outsider), 'save_base', { space: slug, path: 'o.base', yaml: YAML }))).toBe('space not found');
      expect(text(await call(as(outsider), 'save_base', { space: slug, id: createdId, yaml: YAML }))).toBe('page not found');
      await expect(fs.access(path.join(dir, 'ro.base'))).rejects.toThrow();
    });

    it('the .agent folder is admin-only', async () => {
      const r = await call(as(editor), 'save_base', { space: slug, path: '.agent/rules.base', yaml: YAML });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('.agent');
    });
  });

  // -------------------------------------------------------------------------
  // Last: these rewrite the tags the tests above counted.
  describe('rename_tag', () => {
    it('is refused for a read-scoped token, a viewer and a stranger; bad names are errors', async () => {
      const readOnly = await call(as(editor, ['read']), 'rename_tag', { space: slug, from: 'work/alpha', to: 'project/alpha' });
      expect(readOnly.isError).toBe(true);
      expect(text(readOnly)).toContain('write scope');
      expect(text(await call(as(viewer), 'rename_tag', { space: slug, from: 'work/alpha', to: 'project/alpha' }))).toContain('requires editor+');
      expect(text(await call(as(outsider), 'rename_tag', { space: slug, from: 'work/alpha', to: 'project/alpha' }))).toBe('space not found');
      for (const [from, to] of [['work/alpha', 'work/alpha'], ['#Work/Alpha', 'work/alpha'], ['work/alpha', ''], ['work/alpha', '123'], ['work/alpha', '#fff'], ['', 'x']]) {
        expect((await call(as(editor), 'rename_tag', { space: slug, from, to })).isError, `${from} -> ${to}`).toBe(true);
      }
      expect(await read('a.md')).toContain('work/alpha');
    });

    it('renames across bodies, tags:, labels: and the closed pages the caller may edit; counts the skipped; one commit by the token\'s user', async () => {
      const commitsBefore = Number(await git('rev-list', '--count', 'HEAD'));
      const r = ok<{ from: string; to: string; pagesChanged: number; pagesSkipped: number }>(
        await call(as(editor), 'rename_tag', { space: slug, from: '#Work/Alpha', to: 'project/alpha' }),
      );
      expect(r.from).toBe('work/alpha');
      expect(r.to).toBe('project/alpha');
      // a.md (tags:), b.md (labels:) changed; readonly.md (viewer grant: can open, cannot edit) is skipped and counted;
      // secret.md (closed to the editor) is untouched and NOT counted — a count would reveal that it exists
      expect(r.pagesChanged).toBe(2);
      expect(r.pagesSkipped).toBe(1);
      expect(await read('a.md')).toContain('tags: [project/alpha, shared]');
      expect(await read('a.md')).toContain('#work/beta'); // another tag: untouched
      const b = await read('b.md');
      expect(b).toContain('labels:');
      expect(b).toContain('project/alpha');
      expect(b).not.toContain('work/alpha');
      expect(await read('readonly.md')).toContain('work/alpha');
      expect(await read('secret.md')).toContain('work/alpha');

      expect(Number(await git('rev-list', '--count', 'HEAD'))).toBe(commitsBefore + 1);
      expect(await git('log', '-1', '--format=%s')).toBe('docs: rename tag #work/alpha -> #project/alpha');
      expect(await git('log', '-1', '--format=%an')).toBe('Editor');
      await vi.waitFor(async () => {
        const audit = await query<{ meta: { from: string; to: string; pagesChanged: number; tool: string } }>(`SELECT meta FROM audit_log WHERE action = 'space.tag_rename' AND target = $1 ORDER BY id DESC LIMIT 1`, [slug]);
        expect(audit[0]!.meta).toMatchObject({ from: 'work/alpha', to: 'project/alpha', pagesChanged: 2, tool: 'rename_tag' });
      });

      // the tree follows
      const tree = ok<{ tags: TagNode[] }>(await call(as(editor), 'list_tags', { space: slug }));
      expect(tagOf(tree.tags, 'project/alpha')!.pages).toBe(2);
      expect(tagOf(tree.tags, 'work/alpha')!.pages).toBe(1); // readonly.md still carries it
    });

    it('a grant holder renames the closed page too; renaming again finds nothing and commits nothing', async () => {
      const r = ok<{ pagesChanged: number; pagesSkipped: number }>(await call(as(granted), 'rename_tag', { space: slug, from: 'work/alpha', to: 'project/alpha' }));
      expect(r).toEqual({ from: 'work/alpha', to: 'project/alpha', pagesChanged: 1, pagesSkipped: 0 }); // secret.md changed; readonly.md is closed to `granted`: untouched and not counted
      expect(await read('secret.md')).toContain('project/alpha');
      const commits = Number(await git('rev-list', '--count', 'HEAD'));
      const again = ok<{ pagesChanged: number }>(await call(as(owner), 'rename_tag', { space: slug, from: 'work/alpha', to: 'project/alpha' }));
      expect(again.pagesChanged).toBe(1); // the owner (space admin) can edit readonly.md
      expect(Number(await git('rev-list', '--count', 'HEAD'))).toBe(commits + 1);
      const none = ok<{ pagesChanged: number; pagesSkipped: number }>(await call(as(owner), 'rename_tag', { space: slug, from: 'work/alpha', to: 'project/alpha' }));
      expect(none).toMatchObject({ pagesChanged: 0, pagesSkipped: 0 });
      expect(Number(await git('rev-list', '--count', 'HEAD'))).toBe(commits + 1);
    });
  });
});
