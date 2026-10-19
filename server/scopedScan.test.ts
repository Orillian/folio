/**
 * The scoped scan (storage.scanPaths): what the page writes (create, copy, duplicate, make template, from
 * template, upload) run instead of a whole-space scan. Real PG + real files.
 *
 * What matters: the rows it leaves are the rows a full scan would leave (checked by running the full scan right
 * after and comparing), it reads and removes nothing outside its scope, and a scope it cannot walk faithfully
 * falls back to the full scan. Also the batched page-meta write and the folder-prefix query it relies on.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authStore from './auth/store.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import * as pageIndex from './indexV2/store.js';
import * as storage from './storage.js';

interface Snapshot {
  pages: unknown[];
  headings: unknown[];
  blocks: unknown[];
  tags: unknown[];
  links: unknown[];
  files: unknown[];
}

/** Everything the index holds for the pages under `prefix` (ids replaced by paths), plus the space's files. */
async function snapshotOf(space: string, prefix: string): Promise<Snapshot> {
  const like = `${prefix}%`;
  const pages = await query(
    `SELECT path, kind, title, sort_order, status, is_index, plain_text, frontmatter, meta_version
       FROM pages_index WHERE space_slug = $1 AND path LIKE $2 ORDER BY path`,
    [space, like],
  );
  const headings = await query(
    `SELECT p.path, h.position, h.level, h.text, h.slug, h.line FROM page_headings h JOIN pages_index p ON p.id = h.page_id
      WHERE p.space_slug = $1 AND p.path LIKE $2 ORDER BY p.path, h.position`,
    [space, like],
  );
  const blocks = await query(
    `SELECT p.path, b.block_id, b.line FROM page_blocks b JOIN pages_index p ON p.id = b.page_id
      WHERE p.space_slug = $1 AND p.path LIKE $2 ORDER BY p.path, b.block_id`,
    [space, like],
  );
  const tags = await query(
    `SELECT p.path, t.tag, t.source, t.line FROM page_tags t JOIN pages_index p ON p.id = t.page_id
      WHERE p.space_slug = $1 AND p.path LIKE $2 ORDER BY p.path, t.tag, t.line`,
    [space, like],
  );
  const links = await query(
    `SELECT s.path, l.syntax, l.kind, l.link_path, l.target_path, t.path AS target_page_path, l.fragment, l.fragment_resolved, l.line
       FROM page_links l JOIN pages_index s ON s.id = l.source_page_id LEFT JOIN pages_index t ON t.id = l.target_page_id
      WHERE s.space_slug = $1 AND s.path LIKE $2 ORDER BY s.path, l.line, l.id`,
    [space, like],
  );
  const files = await query('SELECT path, size FROM space_files WHERE space_slug = $1 ORDER BY path', [space]);
  return { pages, headings, blocks, tags, links, files };
}

async function write(space: string, rel: string, content: string | Buffer): Promise<void> {
  const abs = path.join(storage.getRepoDir(space), rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

describe('scoped scan (real PG + real files)', () => {
  let teardownSchema: () => Promise<void>;
  const spaces: string[] = [];
  let ownerId: string;

  async function newSpace(label: string): Promise<string> {
    const slug = (await storage.createSpace(`Scoped ${label} ${Date.now()}`, ownerId)).slug;
    spaces.push(slug);
    return slug;
  }

  async function idOf(space: string, rel: string): Promise<string> {
    const id = await storage.getEntryIdByExactPath(space, rel);
    if (!id) throw new Error(`no page at ${rel}`);
    return id;
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    ownerId = (await authStore.createUser({ email: `scoped-${Date.now()}@test.local`, name: 'Scoped', passwordHash: 'x', isAdmin: false })).id;
  });

  afterAll(async () => {
    for (const slug of spaces) await deleteTestSpace(slug);
    await teardownSchema();
  });

  async function seedGuide(space: string): Promise<void> {
    await write(space, 'guide/index.md', '# Guide\n\nStart with [the basics](./basics.md).\n');
    await write(
      space,
      'guide/basics.md',
      [
        '# Basics',
        '',
        'Intro with a #beginner tag and a [[Advanced]] wikilink, a [section link](./advanced.md#usage), a block link [b](./advanced.md#^key).',
        '',
        '## Setup',
        '',
        '![picture](assets/pic.png) and an [absent](./nothing.md) page and a [folder](reference/).',
        '',
      ].join('\n'),
    );
    await write(space, 'guide/advanced.md', '# Advanced\n\n## Usage\n\nA paragraph. ^key\n');
    await write(space, 'guide/assets/pic.png', Buffer.from([1, 2, 3, 4]));
    await write(space, 'guide/reference/api.md', '# API\n');
    await write(space, 'other/outside.md', '# Outside\n\nLinks to [[Basics]].\n');
    // The first scan stamps an id into every file (changing its mtime), the second one settles the index.
    await storage.scanSpace(space);
    await storage.scanSpace(space);
  }

  it('duplicating a folder page (scoped) leaves exactly the index a full scan leaves: headings, blocks, tags, links, fragments, files', async () => {
    const space = await newSpace('duplicate');
    await seedGuide(space);
    const copy = await storage.duplicatePage(await idOf(space, 'guide/index.md'));
    expect(copy.path).toMatch(/^guide-\w*\/index\.md$|^guide.+\/index\.md$/);
    const copyDir = copy.path.slice(0, copy.path.indexOf('/') + 1);

    const scoped = await snapshotOf(space, copyDir);
    expect(scoped.pages.map((p) => (p as { path: string }).path)).toEqual([`${copyDir}advanced.md`, `${copyDir}basics.md`, `${copyDir}index.md`, `${copyDir}reference/api.md`]);
    expect(scoped.headings.length).toBeGreaterThan(0);
    expect(scoped.tags).toEqual([expect.objectContaining({ tag: 'beginner' })]);
    // The copy's attachments are in the files index.
    expect(scoped.files).toContainEqual({ path: `${copyDir}assets/pic.png`, size: '4' });
    // ... and its own links point at its own pages and files.
    expect(scoped.links).toContainEqual(expect.objectContaining({ path: `${copyDir}basics.md`, kind: 'asset', link_path: 'assets/pic.png', target_path: `${copyDir}assets/pic.png` }));
    expect(scoped.links).toContainEqual(expect.objectContaining({ path: `${copyDir}basics.md`, kind: 'page', target_page_path: `${copyDir}advanced.md`, fragment: 'usage', fragment_resolved: true }));

    await storage.scanSpace(space);
    const full = await snapshotOf(space, copyDir);
    expect(full).toEqual(scoped);
  });

  it('a leaf copy and a page created next to it index the same rows as the full scan', async () => {
    const space = await newSpace('leaf');
    await seedGuide(space);
    const copy = await storage.copyPage(await idOf(space, 'guide/basics.md'), space, 'other');
    const created = await storage.createPage({ space, kind: 'doc', title: 'Created page', parentPath: 'other' });
    const scoped = await snapshotOf(space, 'other/');
    expect(scoped.pages.map((p) => (p as { path: string }).path)).toEqual(expect.arrayContaining([copy.path, created.path]));
    await storage.scanSpace(space);
    expect(await snapshotOf(space, 'other/')).toEqual(scoped);
  });

  it('a make-template of a folder page and a page made from it index like a full scan', async () => {
    const space = await newSpace('template');
    await seedGuide(space);
    const template = await storage.makeTemplate(await idOf(space, 'guide/index.md'));
    expect(template.path.startsWith('_templates/')).toBe(true);
    const made = await storage.createFromTemplate(template.id, space, 'other', { author: 'Tester', title: 'From template' });
    const afterOps = { templates: await snapshotOf(space, '_templates/'), made: await snapshotOf(space, made.path.slice(0, made.path.indexOf('/') + 1)) };
    await storage.scanSpace(space);
    expect(await snapshotOf(space, '_templates/')).toEqual(afterOps.templates);
    expect(await snapshotOf(space, made.path.slice(0, made.path.indexOf('/') + 1))).toEqual(afterOps.made);
  });

  it('reads nothing and removes nothing outside its scope', async () => {
    const space = await newSpace('scope');
    await seedGuide(space);
    // Changed and removed on disk behind the index's back.
    const outside = path.join(storage.getRepoDir(space), 'other/outside.md');
    await fs.writeFile(outside, (await fs.readFile(outside, 'utf8')).replace('# Outside', '# Outside, retitled'));
    await fs.rm(path.join(storage.getRepoDir(space), 'guide/advanced.md'));
    await write(space, 'other/late-arrival.md', '# Late arrival\n');

    await storage.createPage({ space, kind: 'doc', title: 'Unrelated', parentPath: 'other' });
    expect((await query<{ title: string }>('SELECT title FROM pages_index WHERE space_slug = $1 AND path = $2', [space, 'other/outside.md']))[0].title).toBe('Outside');
    expect(await query('SELECT 1 FROM pages_index WHERE space_slug = $1 AND path = $2', [space, 'guide/advanced.md'])).toHaveLength(1);
    expect(await query('SELECT 1 FROM pages_index WHERE space_slug = $1 AND path = $2', [space, 'other/late-arrival.md'])).toHaveLength(0);

    await storage.scanSpace(space);
    expect((await query<{ title: string }>('SELECT title FROM pages_index WHERE space_slug = $1 AND path = $2', [space, 'other/outside.md']))[0].title).toBe('Outside, retitled');
    expect(await query('SELECT 1 FROM pages_index WHERE space_slug = $1 AND path = $2', [space, 'guide/advanced.md'])).toHaveLength(0);
    expect(await query('SELECT 1 FROM pages_index WHERE space_slug = $1 AND path = $2', [space, 'other/late-arrival.md'])).toHaveLength(1);
  });

  it('a scope it cannot walk faithfully (an assets folder, a dot folder, a bad path) is the full scan', async () => {
    const space = await newSpace('fallback');
    await seedGuide(space);
    for (const scope of [{ dirs: ['guide/assets'] }, { dirs: ['.hidden'] }, { files: ['guide/../other/x.md'] }, { files: ['.agent/rules.md'] }]) {
      const rel = `other/fallback-${Math.abs(JSON.stringify(scope).length)}-${Date.now()}.md`;
      await write(space, rel, '# Found by the fallback\n');
      await storage.scanPaths(space, scope);
      expect(await query('SELECT 1 FROM pages_index WHERE space_slug = $1 AND path = $2', [space, rel])).toHaveLength(1);
    }
  });

  it('a scoped scan of unchanged files does not read them again', async () => {
    const space = await newSpace('unchanged');
    await seedGuide(space);
    const stats = await storage.scanPaths(space, { dirs: ['guide'], files: ['other/outside.md'] });
    expect(stats.filesRead).toBe(0);
    expect(stats.filesSkipped).toBe(5);
  });

  it('an uploaded file page is indexed by the scoped scan', async () => {
    const space = await newSpace('upload');
    await seedGuide(space);
    const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32, 7)]);
    const page = await storage.uploadFilePage(space, 'other', 'Spec sheet.pdf', '.pdf', bytes);
    expect(page.kind).toBe('pdf');
    expect(page.path.startsWith('other/')).toBe(true);
  });
});

describe('indexPagesMeta (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let space: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const owner = await authStore.createUser({ email: `batch-${Date.now()}@test.local`, name: 'Batch', passwordHash: 'x', isAdmin: false });
    space = (await storage.createSpace(`Batch ${Date.now()}`, owner.id)).slug;
    await write(space, 'one.md', '# One\n\n#alpha text\n');
    await write(space, 'two.md', '# Two\n\n## Part\n\nSee [one](./one.md) and [[Three]] ^blk\n');
    await write(space, 'three.md', '# Three\n');
    await storage.scanSpace(space);
  });

  afterAll(async () => {
    await deleteTestSpace(space);
    await teardownSchema();
  });

  it('writes the same rows as indexing the pages one by one, and a page that cannot be written costs only itself', async () => {
    const ids = {
      one: (await storage.getEntryIdByExactPath(space, 'one.md'))!,
      two: (await storage.getEntryIdByExactPath(space, 'two.md'))!,
      three: (await storage.getEntryIdByExactPath(space, 'three.md'))!,
    };
    const bodies: Record<string, string> = {
      'one.md': '# One\n\n#alpha text\n',
      'two.md': '# Two\n\n## Part\n\nSee [one](./one.md) and [[Three]] ^blk\n',
      'three.md': '# Three\n\n#gamma\n',
    };
    const single = async () => (await snapshotOf(space, '')).tags.concat((await snapshotOf(space, '')).headings, (await snapshotOf(space, '')).blocks);
    // One by one.
    for (const [rel, id] of [['one.md', ids.one], ['two.md', ids.two], ['three.md', ids.three]] as const) {
      await pageIndex.indexPageMeta({ id, space, relPath: rel }, bodies[rel], {});
    }
    const oneByOne = await single();

    // Batched, with a page that is in no index in the middle.
    await query('DELETE FROM page_headings WHERE page_id = ANY($1::text[])', [Object.values(ids)]);
    await query('DELETE FROM page_tags WHERE page_id = ANY($1::text[])', [Object.values(ids)]);
    await query('DELETE FROM page_blocks WHERE page_id = ANY($1::text[])', [Object.values(ids)]);
    const failures: string[] = [];
    await pageIndex.indexPagesMeta(
      [
        { page: { id: ids.one, space, relPath: 'one.md' }, body: bodies['one.md'], frontmatter: {} },
        { page: { id: 'no-such-page', space, relPath: 'ghost.md' }, body: '# Ghost\n\n## Heading\n', frontmatter: {} },
        { page: { id: ids.two, space, relPath: 'two.md' }, body: bodies['two.md'], frontmatter: {} },
        { page: { id: ids.three, space, relPath: 'three.md' }, body: bodies['three.md'], frontmatter: {} },
      ],
      (page) => failures.push(page.relPath),
    );
    expect(failures).toEqual(['ghost.md']);
    expect(await single()).toEqual(oneByOne);
  });
});

describe('folder test of the link resolver (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let space: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const owner = await authStore.createUser({ email: `folders-${Date.now()}@test.local`, name: 'Folders', passwordHash: 'x', isAdmin: false });
    space = (await storage.createSpace(`Folders ${Date.now()}`, owner.id)).slug;
  });

  afterAll(async () => {
    await deleteTestSpace(space);
    await teardownSchema();
  });

  it('a folder link resolves when a page or a file lives under exactly that folder, not under a folder with a similar name', async () => {
    // Siblings that sort around `team/` in byte order and in a locale's: `team-b/` ('-' < '/'), `team0/` ('0' > '/').
    await write(space, 'team-b/x.md', '# X\n');
    await write(space, 'team0/y.md', '# Y\n');
    await write(space, 'links.md', '# Links\n\n[team](team/) and [files](bundle/) and [deep](ünï/code/)\n');
    await storage.scanSpace(space);
    const source = (await storage.getEntryIdByExactPath(space, 'links.md'))!;
    const kinds = async () => (await query<{ link_path: string; kind: string }>('SELECT link_path, kind FROM page_links WHERE source_page_id = $1 ORDER BY line, id', [source])).map((r) => `${r.link_path}:${r.kind}`);
    await pageIndex.resolveLinks(space, { sourceIds: [source] });
    expect(await kinds()).toEqual(['team/:unresolved', 'bundle/:unresolved', 'ünï/code/:unresolved']);

    await write(space, 'team/member.md', '# Member\n');
    await write(space, 'bundle/data.csv', 'a,b\n');
    await write(space, 'ünï/code/main.md', '# Main\n');
    await storage.scanSpace(space);
    await pageIndex.resolveLinks(space, { sourceIds: [source] });
    expect(await kinds()).toEqual(['team/:asset', 'bundle/:asset', 'ünï/code/:asset']);
  });
});
