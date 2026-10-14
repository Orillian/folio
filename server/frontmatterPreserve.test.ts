/**
 * Front matter written by other tools (Docusaurus, MkDocs, Hugo, Jekyll)
 * survives every Folio write path: the first scan stamping an id, a body save
 * (direct and full-file PUT), icon/cover, order, H1 rename, copy and
 * duplicate. Real PG + real fs, a plain local space (rootPath '', so ids ARE
 * written into files here — see lightFootprint.test.ts for the other mode).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';

const FOREIGN = [
  '# Docusaurus page settings',
  'title: "Getting started: the basics"',
  "description: 'It''s quick'",
  'sidebar_position: 2',
  'slug: /getting-started',
  'tags:',
  '  - intro',
  '  - setup',
  'keywords: [docs, folio]',
  'summary: |',
  '  First line.',
  '',
  '  Second paragraph.',
  'nested:',
  '  deep: 1 # comment',
];
const FOREIGN_TEXT = FOREIGN.join('\n');

/** The block's lines minus Folio's own keys — must equal FOREIGN exactly. */
function foreignLines(raw: string): string[] {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  expect(m).not.toBeNull();
  return m![1].split('\n').filter((line) => !/^(id|order|status|icon|cover):/.test(line));
}

describe('front matter preservation (real PG + fs)', () => {
  let teardownSchema: () => Promise<void>;
  let slug: string;
  let dir: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const space = await storage.createSpace(`FM Preserve ${Date.now()}`, null);
    slug = space.slug;
    dir = storage.getSpaceDir(slug);
  });
  afterAll(async () => {
    await deleteTestSpace(slug);
    await teardownSchema();
  });

  async function seed(name: string): Promise<{ id: string; abs: string }> {
    const abs = path.join(dir, name);
    await fs.writeFile(abs, `---\n${FOREIGN_TEXT}\n---\n# Seeded\n\nBody.\n`, 'utf8');
    await storage.scanSpace(slug);
    const id = await storage.getEntryIdByExactPath(slug, name);
    expect(id).toBeTruthy();
    return { id: id!, abs };
  }

  it('the first scan appends an id to a foreign block and keeps every foreign line byte for byte', async () => {
    const { id, abs } = await seed('scan.md');
    const raw = await fs.readFile(abs, 'utf8');
    expect(raw).toBe(`---\n${FOREIGN_TEXT}\nid: ${id}\n---\n# Seeded\n\nBody.\n`);
  });

  it('writeDocBody / full-file PUT / icon / order / rename keep foreign keys', async () => {
    const { id, abs } = await seed('edits.md');

    await storage.writeDocBody(id, '# Seeded\n\nChanged body.\n');
    let raw = await fs.readFile(abs, 'utf8');
    expect(raw).toBe(`---\n${FOREIGN_TEXT}\nid: ${id}\n---\n# Seeded\n\nChanged body.\n`);

    // A client PUT of a whole file (block + body): only icon/cover are taken from its block.
    const split = storage.splitLeadingFrontmatter('---\nicon: star\ntitle: ignored\n---\n# Seeded\n\nPUT body.\n');
    await storage.writeDocBody(id, split.body, split.icon, split.cover);
    raw = await fs.readFile(abs, 'utf8');
    expect(foreignLines(raw)).toEqual(FOREIGN);
    expect(raw).toContain('icon: star\n');
    expect(raw.endsWith('---\n# Seeded\n\nPUT body.\n')).toBe(true);

    const entry = (await storage.getEntry(id))!;
    await storage.setDocIconCover(entry, undefined, 'https://example.com/c.png', '# Seeded\n\nPUT body.\n');
    await storage.setDocOrder(entry, 5, '# Seeded\n\nPUT body.\n');
    raw = await fs.readFile(abs, 'utf8');
    expect(foreignLines(raw)).toEqual(FOREIGN);
    expect(raw).not.toContain('icon:');
    expect(raw).toContain("cover: 'https://example.com/c.png'\n");
    expect(raw).toContain('order: 5\n');

    await storage.renameDocDirect(id, 'Renamed');
    raw = await fs.readFile(abs, 'utf8');
    expect(foreignLines(raw)).toEqual(FOREIGN);
    expect(raw).toContain('# Renamed');
    expect((await storage.getEntry(id))?.id).toBe(id);
  });

  it('copy and duplicate carry the foreign keys, with a fresh id and no order', async () => {
    const { id } = await seed('source.md');
    const entry = (await storage.getEntry(id))!;
    await storage.setDocOrder(entry, 3, entry.body ?? '');

    const copy = await storage.copyPage(id, slug, 'copies');
    const copyRaw = await fs.readFile(path.join(dir, copy.path), 'utf8');
    expect(copy.id).not.toBe(id);
    expect(foreignLines(copyRaw)).toEqual(FOREIGN);
    expect(copyRaw).toContain(`id: ${copy.id}\n`);
    expect(copyRaw).not.toContain('order:');

    const dup = await storage.duplicatePage(id, undefined, 'Source (copy)');
    const dupRaw = await fs.readFile(path.join(dir, dup.path), 'utf8');
    expect(foreignLines(dupRaw)).toEqual(FOREIGN);
    expect(dupRaw).toContain(`id: ${dup.id}\n`);
  });

  it('a subtree copy keeps the foreign keys of every page in it', async () => {
    await fs.mkdir(path.join(dir, 'tree'), { recursive: true });
    await fs.writeFile(path.join(dir, 'tree', 'index.md'), `---\n${FOREIGN_TEXT}\n---\n# Tree\n`, 'utf8');
    await fs.writeFile(path.join(dir, 'tree', 'leaf.md'), `---\n${FOREIGN_TEXT}\n---\n# Leaf\n`, 'utf8');
    await storage.scanSpace(slug);
    const rootId = (await storage.getEntryIdByExactPath(slug, 'tree/index.md'))!;
    const copy = await storage.copyPage(rootId, slug, '');
    const copyDir = path.dirname(path.join(dir, copy.path));
    expect(foreignLines(await fs.readFile(path.join(copyDir, 'index.md'), 'utf8'))).toEqual(FOREIGN);
    expect(foreignLines(await fs.readFile(path.join(copyDir, 'leaf.md'), 'utf8'))).toEqual(FOREIGN);
  });

  it('a file with unparseable front matter is still never rewritten by the scan', async () => {
    const abs = path.join(dir, 'broken.md');
    const raw = '---\ntitle: Fix: login\n---\n# Broken\n';
    await fs.writeFile(abs, raw, 'utf8');
    await storage.scanSpace(slug);
    expect(await fs.readFile(abs, 'utf8')).toBe(raw);
  });
});
