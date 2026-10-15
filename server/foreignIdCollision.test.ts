/**
 * Another tool's front matter `id:` is not a Folio page id (docs-as-code
 * compatibility test, 14.10.2026, finding 1). Docusaurus and Jest docs carry
 * `id: intro`, `id: configuration`... — unique inside one docs folder at best.
 * Two connected folders with the same ids used to share one pages_index row:
 * every scan moved it to the space scanned last, the other space lost the
 * pages, and an edit made in one space was written into the other space's file.
 *
 * Real PG + real git: the "remote" is a local bare repo (see lightFootprint.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as git from './git.js';
import { query } from './db/pool.js';

git.__allowLocalRepoPathsForTests();
const execFileAsync = promisify(execFile);
const RUN = `fid-${Date.now().toString(36)}`;
const createdSlugs = new Set<string>();
const tmpDirs: string[] = [];

const INTRO = '---\nid: intro\ntitle: Introduction\n---\n# Getting started\n\nWelcome.\n';
const CONFIG = '---\nid: configuration\nsidebar_position: 2\n---\n# Configuration\n\nOptions.\n';
const JEST_DOCS: Record<string, string> = {
  'README.md': '# Product\n',
  'docs/intro.md': INTRO,
  'docs/configuration.md': CONFIG,
  'docs/plain.md': '# Plain\n',
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

async function connect(name: string, files: Record<string, string>, rootPath: string) {
  const bare = await seededBareRepo(files);
  const info = await storage.createSpaceFromRepo({ name, repoUrl: bare, branch: 'main', rootPath, createdBy: null });
  createdSlugs.add(info.slug);
  return { slug: info.slug, content: storage.getSpaceDir(info.slug) };
}

async function idsByPath(slug: string): Promise<Map<string, string>> {
  const rows = await query<{ id: string; path: string }>('SELECT id, path FROM pages_index WHERE space_slug = $1', [slug]);
  return new Map(rows.map((r) => [r.path, r.id]));
}

describe('a foreign front matter id never moves a page between spaces (real PG + git)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    for (const slug of createdSlugs) await deleteTestSpace(slug);
    for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await teardownSchema();
  });

  it('two docs folders with the same ids both keep every page, and a write in one never touches the other', async () => {
    const a = await connect(`${RUN} Jest A`, JEST_DOCS, 'docs');
    const b = await connect(`${RUN} Jest B`, JEST_DOCS, 'docs');
    const paths = ['configuration.md', 'intro.md', 'plain.md'];

    const idsA = await idsByPath(a.slug);
    const idsB = await idsByPath(b.slug);
    expect([...idsA.keys()].sort()).toEqual(paths);
    expect([...idsB.keys()].sort()).toEqual(paths);
    // The space connected first keeps the file's own id; the second one gets index-only ids.
    expect(idsA.get('intro.md')).toBe('intro');
    expect(idsB.get('intro.md')).toMatch(/^doc-[0-9a-f]{24}$/);
    expect(idsB.get('configuration.md')).not.toBe('configuration');

    // Rescans, in either order and after a change to every file, move nothing.
    for (const space of [b, a, b]) {
      for (const p of paths) {
        const abs = path.join(space.content, p);
        await fs.writeFile(abs, `${await fs.readFile(abs, 'utf8')}\n`, 'utf8');
      }
      await storage.scanSpace(space.slug);
    }
    expect(await idsByPath(a.slug)).toEqual(idsA);
    expect(await idsByPath(b.slug)).toEqual(idsB);

    // A write through space B's page lands in B's file only; A's bytes stay put,
    // and B's file keeps its own `id:` (another tool's key, not Folio's to rewrite).
    const aBefore = await fs.readFile(path.join(a.content, 'intro.md'));
    await storage.writeDocBody(idsB.get('intro.md')!, '# Getting started\n\nEdited in B.\n');
    expect(await fs.readFile(path.join(a.content, 'intro.md'))).toEqual(aBefore);
    expect(await fs.readFile(path.join(b.content, 'intro.md'), 'utf8')).toBe(INTRO.replace('Welcome.', 'Edited in B.'));
    expect((await storage.getEntry(idsB.get('intro.md')!))?.space).toBe(b.slug);
    expect((await storage.getEntry('intro'))?.space).toBe(a.slug);
  }, 90_000);

  it('the same id in two folders of one space gives two pages; the duplicate keeps its file untouched', async () => {
    const files = {
      'README.md': '# Wiki\n',
      'v1/intro.md': INTRO,
      'v2/intro.md': INTRO.replace('Welcome.', 'Welcome to v2.'),
    };

    // A light-footprint space (rootPath set) ...
    const light = await connect(`${RUN} Versions`, Object.fromEntries(Object.entries(files).map(([k, v]) => [`docs/${k}`, v])), 'docs');
    const lightIds = await idsByPath(light.slug);
    expect(lightIds.size).toBe(3);
    expect(new Set([lightIds.get('v1/intro.md'), lightIds.get('v2/intro.md')]).size).toBe(2);

    // ... and a whole-repository space, where Folio owns `id` and stamps it into new files:
    // the duplicate still gets a page of its own, and its foreign id is not overwritten.
    const whole = await connect(`${RUN} Versions Whole`, files, '');
    const wholeIds = await idsByPath(whole.slug);
    expect(new Set([wholeIds.get('v1/intro.md'), wholeIds.get('v2/intro.md')]).size).toBe(2);
    const duplicate = wholeIds.get('v1/intro.md') === 'intro' ? 'v2/intro.md' : 'v1/intro.md';
    const before = await fs.readFile(path.join(whole.content, duplicate), 'utf8');
    await storage.writeDocBody(wholeIds.get(duplicate)!, `${before.slice(before.indexOf('# '))}More.\n`);
    expect(await fs.readFile(path.join(whole.content, duplicate), 'utf8')).toBe(`${before}More.\n`);
    await storage.scanSpace(whole.slug);
    expect(await idsByPath(whole.slug)).toEqual(wholeIds);
  }, 90_000);

  it('a file carried from one space into another (outside Folio) takes its id along', async () => {
    const a = await connect(`${RUN} Move A`, { 'docs/moving.md': '---\nid: moving-page\n---\n# Moving\n' }, 'docs');
    const b = await connect(`${RUN} Move B`, { 'docs/stays.md': '# Stays\n' }, 'docs');
    expect((await idsByPath(a.slug)).get('moving.md')).toBe('moving-page');

    await fs.rename(path.join(a.content, 'moving.md'), path.join(b.content, 'moving.md'));
    await storage.scanSpace(b.slug);
    expect((await idsByPath(b.slug)).get('moving.md')).toBe('moving-page');
    await storage.scanSpace(a.slug);
    expect((await idsByPath(a.slug)).has('moving.md')).toBe(false);
    expect((await storage.getEntry('moving-page'))?.space).toBe(b.slug);
  }, 90_000);
});
