/**
 * Folio app URLs in the page index, real PG + real files (prod 16.10.2026: the
 * graph of a space linked "the Folio way" showed 35 pages and 0 links). A page
 * links to others by `/s/<space>/p/<id>`, by the absolute URL "Copy link" gives,
 * by a bare pasted URL and by the space home; the index resolves them, across
 * spaces too, and every reader built on it follows: backlinks, page metadata
 * (a closed target reported like a missing one), the space and local graphs
 * (cross-space nodes, tree edges, the ACL), renames (a page of another space is
 * never rewritten), deletion, and the re-parse of rows written by the old parser.
 */
import * as fs from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '../shared/contracts.js';
import { INDEX_META_VERSION } from '../shared/contracts.js';
import { userViewer } from './accessSql.js';
import * as authStore from './auth/store.js';
import * as collab from './collab.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import * as graph from './graph.js';
import * as indexRead from './indexV2/read.js';
import * as storage from './storage.js';

const AUTHOR = { name: 'Tester', email: 't@example.test' };
const HOST = 'folio.example.com';

interface Row {
  link_path: string;
  kind: string;
  target_path: string;
  target_page_id: string | null;
  fragment: string | null;
  fragment_resolved: boolean | null;
}
const linksOf = (id: string) =>
  query<Row>('SELECT link_path, kind, target_path, target_page_id, fragment, fragment_resolved FROM page_links WHERE source_page_id = $1 ORDER BY line, id', [id]);

describe('index: Folio app URLs resolve to pages, across spaces (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let savedPublicUrl: string | undefined;
  let owner: User;
  let reader: User;
  let outsider: User;
  const spaces: string[] = [];
  let A: string;
  let B: string;
  let C: string;
  const id: Record<string, string> = {};

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    savedPublicUrl = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = `https://${HOST}`;
    const stamp = Date.now();
    owner = await authStore.createUser({ email: `app-owner-${stamp}@example.com`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    reader = await authStore.createUser({ email: `app-reader-${stamp}@example.com`, name: 'Reader', passwordHash: 'x', isAdmin: false });
    outsider = await authStore.createUser({ email: `app-outsider-${stamp}@example.com`, name: 'Outsider', passwordHash: 'x', isAdmin: false });
    const mk = async (name: string, members: Array<[User, 'admin' | 'viewer']>) => {
      const slug = (await storage.createSpace(`${name} ${stamp}`, owner.id)).slug;
      spaces.push(slug);
      for (const [u, role] of members) await authStore.setMembership(slug, u.id, role);
      return slug;
    };
    A = await mk('Implementation', [[owner, 'admin'], [reader, 'viewer'], [outsider, 'viewer']]);
    B = await mk('Operations', [[owner, 'admin'], [reader, 'viewer']]);
    C = await mk('Closed', [[owner, 'admin']]);

    const page = async (space: string, parentPath: string, title: string) => (await storage.createPage({ space, parentPath, title, kind: 'doc' })).id;
    id.home = (await storage.resolve(A, '')).id;
    id.guide = await page(A, '', 'Guide');
    id.setup = await page(A, 'guide', 'Setup');
    id.install = await page(A, 'guide', 'Install');
    id.lonely = await page(A, '', 'Lonely');
    id.runbook = await page(B, '', 'Runbook');
    id.secret = await page(C, '', 'Secret');
    await storage.writeDocBody(id.setup, '# Setup\n\n## Intro\n\nText ^blk\n');
    await storage.writeDocBody(
      id.guide,
      [
        '# Guide',
        '',
        `Start with [setup](/s/${A}/p/${id.setup}#intro), then [install](https://${HOST}/s/${A}/p/${encodeURIComponent(id.install)}?tab=1#^nope).`,
        '',
        `Pasted: https://${HOST}/s/${A}/p/${id.setup}`,
        '',
        `Home: [space](https://${HOST}/s/${A}) and the [folder](/s/${A}/d/guide/).`,
        '',
        `Ops: [runbook](/s/${B}/p/${id.runbook}) and [secret](/s/${C}/p/${id.secret}).`,
        '',
        `Broken: [gone](/s/${A}/p/01NOTAPAGE0000000000000000) and elsewhere [x](https://other.example/s/${A}/p/${id.setup}).`,
        '',
      ].join('\n'),
    );
    // A page of another space linking back by app URL — and by a relative path that means a page of ITS space.
    await storage.writeDocBody(id.runbook, `# Runbook\n\nSee [the guide](https://${HOST}/s/${A}/p/${id.guide}), [its setup](/s/${A}/p/${id.setup}) and [a local note](guide/setup.md).\n`);
  });

  afterAll(async () => {
    if (savedPublicUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = savedPublicUrl;
    for (const slug of spaces) await deleteTestSpace(slug);
    await teardownSchema();
  });

  it('every form resolves: path-only and absolute page URLs, a pasted one, the space home, a folder route; other spaces by id; unknown ids unresolved; other hosts external', async () => {
    expect(INDEX_META_VERSION).toBe(3);
    const rows = await linksOf(id.guide);
    expect(rows.map((r) => [r.kind, r.target_page_id, r.target_path, r.fragment, r.fragment_resolved])).toEqual([
      ['page', id.setup, 'guide/setup.md', 'intro', true],
      ['page', id.install, 'guide/install.md', '^nope', false],
      ['page', id.setup, 'guide/setup.md', null, null],
      ['page', id.home, 'index.md', null, null],
      ['page', id.guide, 'guide.md', null, null],
      ['page', id.runbook, `/s/${B}/p/${id.runbook}`, null, null],
      ['page', id.secret, `/s/${C}/p/${id.secret}`, null, null],
      ['unresolved', null, `/s/${A}/p/01NOTAPAGE0000000000000000`, null, null],
      ['external', null, `https://other.example/s/${A}/p/${id.setup}`, null, null],
    ]);
    const back = await linksOf(id.runbook);
    expect(back.map((r) => [r.kind, r.target_page_id, r.target_path])).toEqual([
      ['page', id.guide, `/s/${A}/p/${id.guide}`],
      ['page', id.setup, `/s/${A}/p/${id.setup}`],
      ['unresolved', null, 'guide/setup.md'], // a path of B's own, which does not exist there
    ]);
  });

  it('backlinks include app links, from other spaces too — only sources the caller may read', async () => {
    const intoSetup = await indexRead.getVisibleBacklinks(id.setup, userViewer(reader));
    expect(intoSetup.map((b) => b.id)).toEqual([id.guide, id.guide, id.runbook]);
    const intoGuide = await indexRead.getVisibleBacklinks(id.guide, userViewer(reader));
    // the guide's own folder route links to itself; the runbook links in from space B
    expect(intoGuide.map((b) => [b.id, b.space])).toEqual([
      [id.guide, A],
      [id.runbook, B],
    ]);
    expect((await indexRead.getVisibleBacklinks(id.guide, userViewer(outsider))).map((b) => b.id)).toEqual([id.guide]); // not a member of B
    expect((await indexRead.listOrphans(A, userViewer(reader))).map((o) => o.id)).toEqual([id.lonely]);
  });

  it('page metadata reports a target the caller may not open like a missing one, by the URL as written', async () => {
    const links = await indexRead.getPageLinks(id.guide, userViewer(reader));
    const secret = links.find((l) => l.linkPath === `/s/${C}/p/${id.secret}`)!;
    expect(secret).toMatchObject({ kind: 'unresolved', targetPageId: null, targetPath: `/s/${C}/p/${id.secret}` });
    const runbook = links.find((l) => l.linkPath === `/s/${B}/p/${id.runbook}`)!;
    expect(runbook).toMatchObject({ kind: 'page', targetPageId: id.runbook });
    // the outsider cannot open B either
    const asOutsider = await indexRead.getPageLinks(id.guide, userViewer(outsider));
    expect(asOutsider.find((l) => l.linkPath === `/s/${B}/p/${id.runbook}`)).toMatchObject({ kind: 'unresolved', targetPageId: null });
  });

  it('space graph: app-link edges, cross-space targets the caller may open as marked nodes, tree edges on request', async () => {
    const g = await graph.getSpaceGraph(A, userViewer(reader), { ...graph.DEFAULT_GRAPH_OPTIONS, tree: true });
    const runbook = g.nodes.find((n) => n.id === id.runbook);
    expect(runbook).toMatchObject({ space: B, spaceName: expect.stringContaining('Operations'), title: 'Runbook' });
    expect(g.nodes.some((n) => n.id === id.secret)).toBe(false);
    expect(g.nodes.filter((n) => n.space === undefined).map((n) => n.id).sort()).toEqual([id.home, id.guide, id.setup, id.install, id.lonely].sort());
    expect(g.totalPages).toBe(5);
    const links = g.edges.filter((e) => e.kind === undefined).map((e) => `${e.source}>${e.target}`).sort();
    // the runbook's link back into the guide is drawn too (both ends are nodes)
    expect(links).toEqual([`${id.guide}>${id.setup}`, `${id.guide}>${id.install}`, `${id.guide}>${id.home}`, `${id.guide}>${id.runbook}`, `${id.runbook}>${id.guide}`, `${id.runbook}>${id.setup}`].sort());
    expect(g.edges.find((e) => e.target === id.setup && e.kind === undefined)?.count).toBe(2);
    const tree = g.edges.filter((e) => e.kind === 'tree').map((e) => `${e.source}>${e.target}`).sort();
    expect(tree).toEqual([`${id.home}>${id.guide}`, `${id.home}>${id.lonely}`, `${id.guide}>${id.setup}`, `${id.guide}>${id.install}`].sort());
    expect(g.nodes.find((n) => n.id === id.lonely)?.degree).toBe(1); // its parent only

    const flat = await graph.getSpaceGraph(A, userViewer(reader), graph.DEFAULT_GRAPH_OPTIONS);
    expect(flat.edges.some((e) => e.kind === 'tree')).toBe(false);
    expect(flat.nodes.find((n) => n.id === id.lonely)?.degree).toBe(0);
    // the outsider sees A but not B: no cross-space node at all
    const out = await graph.getSpaceGraph(A, userViewer(outsider), graph.DEFAULT_GRAPH_OPTIONS);
    expect(out.nodes.some((n) => n.space !== undefined)).toBe(false);
    expect(out.edges.some((e) => e.target === id.runbook)).toBe(false);
  });

  it('local graph: cross-space neighbours both ways (never walked on from), tree neighbours with the option', async () => {
    const opts = { depth: 1, direction: 'both' as const, options: { ...graph.DEFAULT_GRAPH_OPTIONS } };
    const ofRunbook = await graph.getLocalGraph({ id: id.runbook, space: B }, userViewer(reader), { ...opts, depth: 3 });
    // the guide (space A) links in; its own neighbours in A are not walked
    expect(ofRunbook.nodes.map((n) => [n.id, n.space ?? null]).sort()).toEqual(
      [
        [id.runbook, null],
        [id.guide, A],
        [id.setup, A],
      ].sort(),
    );

    const ofLonely = await graph.getLocalGraph({ id: id.lonely, space: A }, userViewer(reader), opts);
    expect(ofLonely.nodes.map((n) => n.id)).toEqual([id.lonely]);
    const ofLonelyTree = await graph.getLocalGraph({ id: id.lonely, space: A }, userViewer(reader), { ...opts, options: { ...opts.options, tree: true } });
    expect(ofLonelyTree.nodes.map((n) => n.id)).toEqual([id.lonely, id.home]);
    const depth2 = await graph.getLocalGraph({ id: id.setup, space: A }, userViewer(reader), { ...opts, depth: 2, options: { ...opts.options, tree: true } });
    // parent and (via the parent) the sibling, the home; the link source too
    expect(new Set(depth2.nodes.map((n) => n.id))).toEqual(new Set([id.setup, id.guide, id.install, id.home, id.runbook]));
    expect(depth2.edges.filter((e) => e.kind === 'tree').map((e) => `${e.source}>${e.target}`).sort()).toEqual(
      [`${id.guide}>${id.setup}`, `${id.guide}>${id.install}`, `${id.home}>${id.guide}`].sort(),
    );
    expect(depth2.nodes.find((n) => n.id === id.runbook)?.space).toBe(B);
  });

  it('a rename keeps the app links and never rewrites a page of another space', async () => {
    const runbookBefore = await fs.readFile((await storage.getEntry(id.runbook))!.absPath, 'utf8');
    await collab.renamePageSlug(id.setup, 'setting-up', AUTHOR);
    // `guide/setup.md` in the runbook is a path of space B: renaming A's page of that path must not touch it
    expect(await fs.readFile((await storage.getEntry(id.runbook))!.absPath, 'utf8')).toBe(runbookBefore);
    expect(runbookBefore).toContain('[a local note](guide/setup.md)');
    const rows = await linksOf(id.guide);
    expect(rows.slice(0, 3).map((r) => [r.kind, r.target_page_id, r.target_path])).toEqual([
      ['page', id.setup, 'guide/setting-up.md'],
      ['page', id.install, 'guide/install.md'],
      ['page', id.setup, 'guide/setting-up.md'],
    ]);
  });

  it('deleting a target turns its app links unresolved; rows of the old parser are re-parsed by the next scan', async () => {
    await storage.deletePage(id.install, owner.id);
    expect((await linksOf(id.guide))[1]).toMatchObject({ kind: 'unresolved', target_page_id: null, target_path: `/s/${A}/p/${id.install}` });

    // As prod has them: indexed by parser 2, the app link stored as 'external'.
    await query(`UPDATE page_links SET kind = 'external', target_page_id = NULL, target_path = link_path WHERE source_page_id = $1`, [id.guide]);
    await query('UPDATE pages_index SET meta_version = 2 WHERE id = $1', [id.guide]);
    await storage.scanSpace(A);
    const rows = await linksOf(id.guide);
    expect(rows[0]).toMatchObject({ kind: 'page', target_page_id: id.setup, fragment_resolved: true });
    expect(rows.filter((r) => r.kind === 'page')).toHaveLength(6);
    expect((await query<{ v: number }>('SELECT meta_version AS v FROM pages_index WHERE id = $1', [id.guide]))[0].v).toBe(INDEX_META_VERSION);
  });
});
