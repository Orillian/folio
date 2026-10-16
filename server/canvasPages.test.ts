/**
 * Obsidian canvas pages (`.canvas`, JSON Canvas 1.0) end to end, real fs + real
 * PG + real git, no HTTP layer (same style as officePages.test.ts):
 *  - the scan makes a read-only kind:'canvas' page and never writes the file;
 *  - search (text cards), tags (text cards + sidecar), page links (file cards,
 *    links inside text cards), backlinks;
 *  - the read model resolves file cards per reader: a restricted page is
 *    "noAccess" with no title and no path; bad JSON / an oversized file is a
 *    readable error;
 *  - "Convert to Folio board": a new board in one commit by the caller, the
 *    canvas untouched;
 *  - a rename through Folio rewrites the canvas's file cards in a native space
 *    and in a light-footprint one (a vault) alike, touching only the path strings;
 *  - MCP read_page / fetch return the outline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { query } from './db/pool.js';
import * as storage from './storage.js';
import * as collab from './collab.js';
import * as links from './links.js';
import * as authStore from './auth/store.js';
import * as pageAccess from './pageAccess.js';
import { searchPages } from './search.js';
import { userViewer } from './accessSql.js';
import { buildCanvasPayload } from './canvasView.js';
import { convertCanvasPage, canvasConversionReport } from './canvasToBoard.js';
import { buildPageDoc } from './pageDoc.js';
import { buildFolioMcpServer, type McpActor } from './mcp.js';
import { decodeScenePayload, extractScenePayload } from './confluenceWhiteboard.js';
import { CANVAS_MAX_BYTES } from '../shared/canvas/index.js';
import type { User } from '../shared/contracts.js';

const AUTHOR = { name: 'Canvas Tester', email: 'canvas@example.test' };
const execFileAsync = promisify(execFile);

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: dir });
  return stdout;
}

async function write(dir: string, rel: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), content);
}

async function entryAt(space: string, relPath: string): Promise<storage.PageIndexEntry> {
  const entry = (await storage.listEntries(space)).find((e) => e.relPath === relPath);
  expect(entry, `entry ${relPath}`).toBeDefined();
  return entry!;
}

/** Tab-indented, as Obsidian writes a canvas — the bytes must survive everything but an explicit rename in a native space. */
function canvasText(): string {
  return JSON.stringify(
    {
      nodes: [
        { id: 'grp', type: 'group', x: -40, y: -60, width: 900, height: 420, label: 'Launch plan', color: '4' },
        { id: 'txt', type: 'text', text: '## Goals\nShip the zebracorn release #roadmap, see [[Spec]] and [old](Notes/Old.md).', x: 0, y: 0, width: 300, height: 160, color: '1' },
        { id: 'spec', type: 'file', file: 'Notes/Spec.md', subpath: '#Scope', x: 340, y: 0, width: 300, height: 200 },
        { id: 'secret', type: 'file', file: 'Private/Salaries.md', x: 0, y: 220, width: 200, height: 100 },
        { id: 'pic', type: 'file', file: 'img/diagram.png', x: 680, y: 0, width: 120, height: 120 },
        { id: 'gone', type: 'file', file: 'Notes/Nowhere.md', x: 680, y: 200, width: 120, height: 60 },
        { id: 'web', type: 'link', url: 'https://example.com/docs', x: 900, y: 0, width: 200, height: 80 },
      ],
      edges: [
        { id: 'e1', fromNode: 'txt', fromSide: 'right', toNode: 'spec', toSide: 'left', label: 'details' },
        { id: 'e2', fromNode: 'spec', toNode: 'web', toEnd: 'none', color: '6', futureKey: 1 },
      ],
      futureTopLevelKey: { kept: true },
    },
    null,
    '\t',
  );
}

async function connectedClient(actor: McpActor): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildFolioMcpServer(actor);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'canvas-test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: async () => client.close() };
}

function toolText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
}

describe('canvas pages (real fs + real PG + real git)', () => {
  let teardownSchema: () => Promise<void>;
  let owner: User;
  let viewer: User;
  let space: string;
  let dir: string;
  let raw: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    owner = await authStore.createUser({ email: `canvas-owner-${stamp}@test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    viewer = await authStore.createUser({ email: `canvas-viewer-${stamp}@test.local`, name: 'Viewer', passwordHash: 'x', isAdmin: false });
    space = (await storage.createSpace(`Canvas ${stamp}`, null)).slug;
    await authStore.setMembership(space, owner.id, 'editor');
    await authStore.setMembership(space, viewer.id, 'viewer');
    dir = storage.getSpaceDir(space);
    await write(dir, 'Notes/Spec.md', '# Spec\n\nIntro text.\n\n## Scope\n\nOnly the zebracorn parts.\n\n## Later\n\nNot now.\n');
    await write(dir, 'Notes/Old.md', '# Old\n\nOld note.\n');
    await write(dir, 'Private/Salaries.md', '# Salaries\n\nTop secret.\n');
    await write(dir, 'img/diagram.png', Buffer.from('89504e470d0a1a0a', 'hex'));
    raw = canvasText();
    await write(dir, 'Boards/Launch.canvas', raw);
    await storage.scanSpace(space);
    await pageAccess.setAccess(owner, await entryAt(space, 'Private/Salaries.md'), 'restricted', []);
  });

  afterAll(async () => {
    await deleteTestSpace(space).catch(() => {});
    await teardownSchema();
  });

  it('a .canvas file is a canvas page titled by its name, and the scan never writes it', async () => {
    const entry = await entryAt(space, 'Boards/Launch.canvas');
    expect(entry.kind).toBe('canvas');
    expect(entry.title).toBe('Launch');
    expect(entry.id).toMatch(/^canvas-/);
    await storage.scanSpace(space);
    expect((await entryAt(space, 'Boards/Launch.canvas')).id).toBe(entry.id);
    expect(await fs.readFile(path.join(dir, 'Boards/Launch.canvas'), 'utf8')).toBe(raw);
    // It is a page now, not a file of the files index.
    expect(await query('SELECT 1 FROM space_files WHERE space_slug = $1 AND path = $2', [space, 'Boards/Launch.canvas'])).toEqual([]);
  });

  it('search finds it by its text cards; tags come from its text cards', async () => {
    const hits = await searchPages('zebracorn', { userId: owner.id, space, isInstanceAdmin: false });
    expect(hits.find((h) => h.path === 'Boards/Launch.canvas')).toMatchObject({ kind: 'canvas' });
    const canvasHit = await searchPages('kind:canvas', { userId: owner.id, space, isInstanceAdmin: false });
    expect(canvasHit.map((h) => h.path)).toEqual(['Boards/Launch.canvas']);
    const entry = await entryAt(space, 'Boards/Launch.canvas');
    const tags = await query<{ tag: string; line: number }>('SELECT tag, line FROM page_tags WHERE page_id = $1', [entry.id]);
    expect(tags).toEqual([{ tag: 'roadmap', line: 2 }]);
  });

  it('file cards and the links of text cards are page links: resolved by exact path, fragments checked, backlinks see the canvas', async () => {
    const entry = await entryAt(space, 'Boards/Launch.canvas');
    const spec = await entryAt(space, 'Notes/Spec.md');
    const rows = await query<{ syntax: string; link_path: string; kind: string; target_path: string; target_page_id: string | null; fragment: string | null; fragment_resolved: boolean | null; line: number }>(
      'SELECT syntax, link_path, kind, target_path, target_page_id, fragment, fragment_resolved, line FROM page_links WHERE source_page_id = $1 ORDER BY line, syntax, link_path',
      [entry.id],
    );
    expect(rows).toEqual([
      // text card (node 2): a wikilink and a relative md link — resolved from the canvas's folder, like a note's
      { syntax: 'md', link_path: 'Notes/Old.md', kind: 'unresolved', target_path: 'Boards/Notes/Old.md', target_page_id: null, fragment: null, fragment_resolved: null, line: 2 },
      { syntax: 'wikilink', link_path: 'Spec', kind: 'page', target_path: 'Notes/Spec.md', target_page_id: spec.id, fragment: null, fragment_resolved: null, line: 2 },
      { syntax: 'canvas', link_path: 'Notes/Spec.md', kind: 'page', target_path: 'Notes/Spec.md', target_page_id: spec.id, fragment: 'Scope', fragment_resolved: true, line: 3 },
      { syntax: 'canvas', link_path: 'Private/Salaries.md', kind: 'page', target_path: 'Private/Salaries.md', target_page_id: (await entryAt(space, 'Private/Salaries.md')).id, fragment: null, fragment_resolved: null, line: 4 },
      { syntax: 'canvas', link_path: 'img/diagram.png', kind: 'asset', target_path: 'img/diagram.png', target_page_id: null, fragment: null, fragment_resolved: null, line: 5 },
      { syntax: 'canvas', link_path: 'Notes/Nowhere.md', kind: 'unresolved', target_path: 'Notes/Nowhere.md', target_page_id: null, fragment: null, fragment_resolved: null, line: 6 },
      { syntax: 'md', link_path: 'https://example.com/docs', kind: 'external', target_path: 'https://example.com/docs', target_page_id: null, fragment: null, fragment_resolved: null, line: 7 },
    ]);
    expect((await links.getBacklinks(spec.id)).map((b) => b.path)).toContain('Boards/Launch.canvas');
  });

  it('sidecar properties index with the cards: a property change keeps the canvas’s links and adds its tags', async () => {
    const entry = await entryAt(space, 'Boards/Launch.canvas');
    const count = async () => (await query<{ n: string }>('SELECT count(*) AS n FROM page_links WHERE source_page_id = $1', [entry.id]))[0].n;
    const before = await count();
    await storage.reindexSidecarProperties(entry, { tags: ['planning'] });
    expect(await count()).toBe(before);
    const tags = await query<{ tag: string; source: string }>('SELECT tag, source FROM page_tags WHERE page_id = $1 ORDER BY tag', [entry.id]);
    expect(tags).toEqual([
      { tag: 'planning', source: 'frontmatter' },
      { tag: 'roadmap', source: 'body' },
    ]);
  });

  it('the read model resolves file cards for the reader: a restricted page is "noAccess" with no title and no path', async () => {
    const entry = await entryAt(space, 'Boards/Launch.canvas');
    const asOwner = await buildCanvasPayload(entry, userViewer(owner));
    expect(asOwner.files.secret).toMatchObject({ status: 'page', title: 'Salaries' });
    expect(asOwner.files.spec).toMatchObject({ status: 'page', kind: 'doc', title: 'Spec', path: 'Notes/Spec.md' });
    // The excerpt is the `#Scope` section, cut the way an embed is cut.
    expect((asOwner.files.spec as { excerpt: string }).excerpt).toBe('## Scope\n\nOnly the zebracorn parts.');
    expect(asOwner.files.pic).toEqual({ status: 'file', path: 'img/diagram.png', media: 'image' });
    expect(asOwner.files.gone).toEqual({ status: 'missing', path: 'Notes/Nowhere.md' });

    const asViewer = await buildCanvasPayload(entry, userViewer(viewer));
    expect(asViewer.files.secret).toEqual({ status: 'noAccess' });
    const secretNode = asViewer.document!.nodes.find((n) => n.id === 'secret')!;
    expect(secretNode).toEqual({ id: 'secret', type: 'file', file: '', x: 0, y: 220, width: 200, height: 100 });
    expect(JSON.stringify(asViewer)).not.toContain('Salaries');
    // The same through the page doc the routes send, and a share reader opens only its own pages.
    expect((await buildPageDoc(entry, userViewer(viewer))).canvas?.files.secret).toEqual({ status: 'noAccess' });
    const shared = await buildPageDoc(entry, { kind: 'share', pageIds: new Set([entry.id]) });
    expect(shared.canvas?.files.spec).toEqual({ status: 'noAccess' });
    expect(shared.canvas?.files.pic).toMatchObject({ status: 'file' });
  });

  it('a file that is not JSON, or is too large, opens as a readable error — and is still a page', async () => {
    await write(dir, 'Broken.canvas', '{"nodes": [ {"id": ');
    await write(dir, 'Huge.canvas', `{"nodes":[],"pad":"${'x'.repeat(CANVAS_MAX_BYTES)}"}`);
    await storage.scanSpace(space);
    const broken = await entryAt(space, 'Broken.canvas');
    expect(broken.kind).toBe('canvas');
    const payload = await buildCanvasPayload(broken, userViewer(owner));
    expect(payload.document).toBeNull();
    expect(payload.error).toMatch(/^The file is not valid JSON/);
    const huge = await buildCanvasPayload(await entryAt(space, 'Huge.canvas'), userViewer(owner));
    expect(huge.document).toBeNull();
    expect(huge.error).toMatch(/too large to show/);
    await fs.rm(path.join(dir, 'Broken.canvas'));
    await fs.rm(path.join(dir, 'Huge.canvas'));
    await storage.scanSpace(space);
  });

  it('MCP read_page and fetch return the outline, file cards as the caller may see them', async () => {
    const entry = await entryAt(space, 'Boards/Launch.canvas');
    const { client, close } = await connectedClient({ user: viewer, scopes: ['read'], tokenId: 'canvas-viewer' });
    try {
      const read = JSON.parse(toolText(await client.callTool({ name: 'read_page', arguments: { id: entry.id } }))) as { kind: string; outline: string };
      expect(read.kind).toBe('canvas');
      expect(read.outline).toContain('- [group grp] "Launch plan"');
      expect(read.outline).toContain('[file spec] "Spec" — doc page');
      expect(read.outline).toContain('[file secret] a page that is not available to you');
      expect(read.outline).toContain('-> spec ("Spec"): "details" [right to left]');
      expect(read.outline).toContain('- spec ("Spec") -- web (https://example.com/docs) · purple');
      expect(read.outline).not.toContain('Salaries');
      const fetched = JSON.parse(toolText(await client.callTool({ name: 'fetch', arguments: { id: entry.id } }))) as { text: string };
      expect(fetched.text).toBe(read.outline);
      // No MCP tool writes a canvas.
      const update = await client.callTool({ name: 'update_page', arguments: { id: entry.id, markdown: 'x' } });
      expect(update.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('converts to a new board in one commit by the caller; the canvas stays byte for byte', async () => {
    const entry = await entryAt(space, 'Boards/Launch.canvas');
    const repo = storage.getRepoDir(space);
    await git(repo, 'add', '-A');
    await git(repo, '-c', 'user.name=Setup', '-c', 'user.email=setup@test', 'commit', '-qm', 'setup', '--allow-empty');
    const before = (await git(repo, 'rev-list', '--count', 'HEAD')).trim();

    const report = await canvasConversionReport(entry, userViewer(viewer), 'https://folio.test');
    expect(report.losses.map((l) => l.code)).toContain('noAccessCards');

    const result = await convertCanvasPage(entry, userViewer(owner), {}, AUTHOR, 'https://folio.test');
    expect(result.board).toMatchObject({ kind: 'board', title: 'Launch (board)' });
    expect(result.board.path.startsWith('Boards/')).toBe(true);
    expect(await fs.readFile(path.join(dir, 'Boards/Launch.canvas'), 'utf8')).toBe(raw);
    expect((await git(repo, 'rev-list', '--count', 'HEAD')).trim()).toBe(String(Number(before) + 1));
    expect((await git(repo, 'log', '-1', '--format=%an <%ae>|%s')).trim()).toBe(`Canvas Tester <canvas@example.test>|docs: convert canvas Boards/Launch.canvas -> ${result.board.path}`);
    expect((await git(repo, 'show', '--name-only', '--format=', 'HEAD')).trim()).toBe(result.board.path);

    const svg = await fs.readFile(path.join(dir, result.board.path), 'utf8');
    const scene = decodeScenePayload(extractScenePayload(svg)!);
    const frame = scene.elements.find((e) => e.id === 'c-grp')!;
    expect(frame).toMatchObject({ type: 'frame', name: 'Launch plan', x: -40, y: -60, width: 900, height: 420 });
    expect(scene.elements.find((e) => e.id === 'c-spec')).toMatchObject({ type: 'rectangle', link: `https://folio.test/s/${space}/p/${(await entryAt(space, 'Notes/Spec.md')).id}#Scope` });
    // The picture rides inside the board.
    expect(scene.elements.find((e) => e.id === 'c-pic')).toMatchObject({ type: 'image' });
    expect(result.report.losses.map((l) => l.code)).not.toContain('noAccessCards'); // the owner sees every card

    await expect(convertCanvasPage(await entryAt(space, 'Notes/Spec.md'), userViewer(owner), {}, AUTHOR, '')).rejects.toThrow(/not a canvas/);
  });

  it('renaming a target through Folio rewrites the canvas’s file cards (and its text cards’ links) in a native space, every other byte kept', async () => {
    const spec = await entryAt(space, 'Notes/Spec.md');
    await collab.renamePageSlug(spec.id, 'spec-v2', AUTHOR);
    const after = await fs.readFile(path.join(dir, 'Boards/Launch.canvas'), 'utf8');
    expect(after).toBe(raw.replace('"file": "Notes/Spec.md"', '"file": "Notes/spec-v2.md"').replace('see [[Spec]] and', 'see [[spec-v2]] and'));
    const entry = await entryAt(space, 'Boards/Launch.canvas');
    const payload = await buildCanvasPayload(entry, userViewer(owner));
    expect(payload.files.spec).toMatchObject({ status: 'page', path: 'Notes/spec-v2.md' });
    raw = after;
  });

  it('in a light-footprint space (a vault) the canvas follows a rename too, only the changed path strings touched', async () => {
    const light = (await storage.createSpace(`Canvas Light ${Date.now()}`, null)).slug;
    try {
      await storage.setSpaceScanSettings(light, { lightFootprint: true });
      await authStore.setMembership(light, owner.id, 'editor');
      const ldir = storage.getSpaceDir(light);
      await write(ldir, 'Note.md', '# Note\n\nHello.\n');
      await write(ldir, 'Other.md', '# Other\n\nUnrelated.\n');
      const text = JSON.stringify(
        {
          nodes: [
            { id: 'n', type: 'file', file: 'Note.md', x: 0, y: 0, width: 100, height: 100 },
            { id: 'o', type: 'file', file: 'Other.md', x: 120, y: 0, width: 100, height: 100 },
            { id: 't', type: 'text', text: 'see [[Note]] and #tag', x: 0, y: 140, width: 200, height: 80 },
          ],
          edges: [{ id: 'e', fromNode: 'n', toNode: 'o' }],
          futureKey: { kept: true },
        },
        null,
        '\t',
      );
      await write(ldir, 'Map.canvas', text);
      await storage.scanSpace(light);
      const note = await entryAt(light, 'Note.md');
      await collab.renamePageSlug(note.id, 'renamed', AUTHOR);
      const renamedText = text.replace('"file": "Note.md"', '"file": "renamed.md"').replace('see [[Note]] and', 'see [[renamed]] and');
      expect(await fs.readFile(path.join(ldir, 'Map.canvas'), 'utf8')).toBe(renamedText);
      const payload = await buildCanvasPayload(await entryAt(light, 'Map.canvas'), userViewer(owner));
      expect(payload.files.n).toMatchObject({ status: 'page', path: 'renamed.md' });
      expect(payload.files.o).toMatchObject({ status: 'page', path: 'Other.md' });
      // The rewrite rode the rename's own commit.
      expect(await git(ldir, 'log', '-1', '--format=%s')).toContain('docs: rename Note.md -> renamed.md');
      expect(await git(ldir, 'show', '--stat', '--format=', 'HEAD')).toContain('Map.canvas');
      // Moving a note in a vault follows too.
      await write(ldir, 'Sub/placeholder.md', '# P\n');
      await storage.scanSpace(light);
      await collab.movePage((await entryAt(light, 'Other.md')).id, 'Sub', AUTHOR);
      expect(await fs.readFile(path.join(ldir, 'Map.canvas'), 'utf8')).toBe(renamedText.replace('"file": "Other.md"', '"file": "Sub/Other.md"'));
    } finally {
      await deleteTestSpace(light);
    }
  });
});
