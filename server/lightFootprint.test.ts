/**
 * "Light footprint" — a space bound to a sub-folder (rootPath) of somebody's
 * product repository. Folio must not leave a mass diff there: no `id` stamped
 * into any doc (ids live in pages_index: claims, same path, orphan match,
 * deterministic path id), and its `.folio` metadata is a dotfile inside the
 * content root, not a foreign file at the product's root. Legacy rootPath
 * spaces (ids already in files, `<slug>.folio` at the repo root) keep working
 * unchanged, and rootPath '' spaces still get ids as before.
 *
 * Real PG + real git: the "remote" is a local bare repo (see gitNative.test.ts).
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
import * as collab from './collab.js';
import * as authStore from './auth/store.js';
import { query } from './db/pool.js';
import { restoreTrashItem, type TrashRow } from './trash/service.js';
import { getTrashRoot } from './trash/paths.js';
import { translitSlug } from './translit.js';
import { readSpaceExportSettings, writeSpaceExportSettings } from './export/spaceSettings.js';
import type { User } from '../shared/contracts.js';

git.__allowLocalRepoPathsForTests();
const execFileAsync = promisify(execFile);
const RUN = `light-${Date.now().toString(36)}`;
const createdSlugs = new Set<string>();
const tmpDirs: string[] = [];

const DOCUSAURUS = '---\ntitle: "Intro: start here"\nsidebar_position: 1\nslug: /\ntags: [a, b]\n# a comment\n---\n# Intro\n\nWelcome.\n';
const SEED: Record<string, string> = {
  'README.md': '# Product\n',
  'package.json': '{"name":"product"}\n',
  'docs/intro.md': DOCUSAURUS,
  'docs/plain.md': '# Plain\n\nNo front matter.\n',
  'docs/guide/index.md': '# Guide\n',
  'docs/guide/step-one.md': '# Step one\n',
  'docs/guide/step-two.md': '# Step two, a bit longer\n',
};

/** A bare repo seeded with `files`, returned as its path. */
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
  return { slug: info.slug, repo: storage.getRepoDir(info.slug), content: storage.getSpaceDir(info.slug) };
}

async function gitStatus(repo: string): Promise<string> {
  return (await execFileAsync('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim();
}

async function idsByPath(slug: string): Promise<Map<string, string>> {
  const rows = await query<{ id: string; path: string }>('SELECT id, path FROM pages_index WHERE space_slug = $1', [slug]);
  return new Map(rows.map((r) => [r.path, r.id]));
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

describe('light footprint for rootPath spaces (real PG + git)', () => {
  let teardownSchema: () => Promise<void>;
  let admin: User;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    admin = await authStore.createUser({ email: `${RUN}-admin@t.local`, name: 'Light Admin', passwordHash: 'x', isAdmin: true });
  });
  afterAll(async () => {
    for (const slug of createdSlugs) await deleteTestSpace(slug);
    // Only this run's trash stamps (every child is one of our slugs).
    const root = getTrashRoot();
    for (const stamp of await fs.readdir(root).catch(() => [] as string[])) {
      const children = await fs.readdir(path.join(root, stamp)).catch(() => [] as string[]);
      if (children.length > 0 && children.every((c) => createdSlugs.has(c))) await fs.rm(path.join(root, stamp), { recursive: true, force: true });
    }
    for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await teardownSchema();
  });

  it('connecting leaves every file as it was, puts .folio inside docs/ as a dotfile, and ids survive rescans and an index rebuild', async () => {
    const { slug, repo, content } = await connect(`${RUN} Docs`, SEED, 'docs');

    for (const [rel, text] of Object.entries(SEED)) expect(await fs.readFile(path.join(repo, rel), 'utf8')).toBe(text);
    expect(await gitStatus(repo)).toBe('');
    expect(await exists(path.join(repo, `${slug}.folio`))).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(content, `.${slug}.folio`), 'utf8')).name).toBe(`${RUN} Docs`);
    expect(await storage.folioMetaPath(slug)).toBe(path.join(content, `.${slug}.folio`));
    // the only commit Folio made is the metadata dotfile
    const show = (await execFileAsync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: repo })).stdout.trim();
    expect(show).toBe(`docs/.${slug}.folio`);

    const ids = await idsByPath(slug);
    expect([...ids.keys()].sort()).toEqual(['guide/index.md', 'guide/step-one.md', 'guide/step-two.md', 'intro.md', 'plain.md']);
    expect(ids.get('plain.md')).toMatch(/^doc-[0-9a-f]{24}$/);

    await storage.scanSpace(slug);
    expect(await idsByPath(slug)).toEqual(ids);
    // Rebuilt from scratch: the deterministic path ids come back.
    await query('DELETE FROM pages_index WHERE space_slug = $1', [slug]);
    await storage.scanSpace(slug);
    expect(await idsByPath(slug)).toEqual(ids);
    expect(await gitStatus(repo)).toBe('');

    // renameSpace writes the dotfile, not a root file
    await storage.renameSpace(slug, 'Renamed Docs');
    expect(JSON.parse(await fs.readFile(path.join(content, `.${slug}.folio`), 'utf8')).name).toBe('Renamed Docs');
    expect(await exists(path.join(repo, `${slug}.folio`))).toBe(false);
    // export settings follow the same file
    await writeSpaceExportSettings(slug, { headerHtml: '<b>H</b>' });
    expect((await readSpaceExportSettings(slug)).headerHtml).toBe('<b>H</b>');
    expect(JSON.parse(await fs.readFile(path.join(content, `.${slug}.folio`), 'utf8')).export.headerHtml).toBe('<b>H</b>');
  }, 60_000);

  it('editing, icon, order and creating pages never add an id; foreign keys stay', async () => {
    const { slug, content } = await connect(`${RUN} Edit`, SEED, 'docs');
    const ids = await idsByPath(slug);
    const introId = ids.get('intro.md')!;

    await storage.writeDocBody(introId, '# Intro\n\nWelcome, edited.\n');
    expect(await fs.readFile(path.join(content, 'intro.md'), 'utf8')).toBe(DOCUSAURUS.replace('Welcome.', 'Welcome, edited.'));

    const entry = (await storage.getEntry(introId))!;
    await storage.setDocIconCover(entry, 'star', undefined, '# Intro\n\nWelcome, edited.\n');
    await storage.setDocOrder(entry, 2, '# Intro\n\nWelcome, edited.\n');
    const raw = await fs.readFile(path.join(content, 'intro.md'), 'utf8');
    expect(raw).toBe(DOCUSAURUS.replace('# a comment\n', '# a comment\nicon: star\norder: 2\n').replace('Welcome.', 'Welcome, edited.'));

    const plainId = ids.get('plain.md')!;
    await storage.writeDocBody(plainId, '# Plain\n\nEdited.\n');
    expect(await fs.readFile(path.join(content, 'plain.md'), 'utf8')).toBe('# Plain\n\nEdited.\n');

    const created = await storage.createPage({ space: slug, parentPath: 'guide', title: 'New Page', kind: 'doc' });
    expect(await fs.readFile(path.join(content, created.path), 'utf8')).toBe('# New Page\n');
    await storage.scanSpace(slug);
    expect((await idsByPath(slug)).get(created.path)).toBe(created.id);
    expect((await storage.getEntry(introId))?.relPath).toBe('intro.md');
  }, 60_000);

  it('ids follow a Folio move, a folder move, a slug rename and an external rename', async () => {
    const { slug, content } = await connect(`${RUN} Move`, SEED, 'docs');
    const ids = await idsByPath(slug);

    const moved = await storage.movePage(ids.get('plain.md')!, 'guide');
    expect(moved.id).toBe(ids.get('plain.md'));
    expect(moved.path).toBe('guide/plain.md');

    // a directory-index page moves its whole folder; children keep their ids
    await fs.mkdir(path.join(content, 'archive'), { recursive: true });
    await fs.writeFile(path.join(content, 'archive', 'index.md'), '# Archive\n', 'utf8');
    await storage.scanSpace(slug);
    await storage.movePage(ids.get('guide/index.md')!, 'archive');
    const afterFolderMove = await idsByPath(slug);
    expect(afterFolderMove.get('archive/guide/index.md')).toBe(ids.get('guide/index.md'));
    expect(afterFolderMove.get('archive/guide/step-one.md')).toBe(ids.get('guide/step-one.md'));
    expect(afterFolderMove.get('archive/guide/step-two.md')).toBe(ids.get('guide/step-two.md'));
    expect(afterFolderMove.get('archive/guide/plain.md')).toBe(ids.get('plain.md'));

    const renamed = await storage.renamePageSlug(ids.get('intro.md')!, 'welcome');
    expect(renamed.meta.id).toBe(ids.get('intro.md'));
    expect(renamed.meta.path).toBe('welcome.md');
    expect(await fs.readFile(path.join(content, 'welcome.md'), 'utf8')).toBe(DOCUSAURUS);

    // an external `git mv` (no claim): the orphaned row of the same size hands its id over
    await fs.rename(path.join(content, 'welcome.md'), path.join(content, 'hello.md'));
    await storage.scanSpace(slug);
    expect((await idsByPath(slug)).get('hello.md')).toBe(ids.get('intro.md'));

    // a new file at a path whose deterministic id is held by a page that moved away gets another one
    const reborn = await storage.createPage({ space: slug, parentPath: '', title: 'Plain', kind: 'doc' });
    expect(reborn.path).toBe('plain.md');
    expect(reborn.id).not.toBe(ids.get('plain.md'));
    expect((await storage.getEntry(ids.get('plain.md')!))?.relPath).toBe('archive/guide/plain.md');
  }, 60_000);

  it('copy gives the copy its own id without writing one; trash restore brings the ids back', async () => {
    const { slug, repo, content } = await connect(`${RUN} Copy`, SEED, 'docs');
    const ids = await idsByPath(slug);

    const copy = await storage.copyPage(ids.get('intro.md')!, slug, 'guide');
    expect(copy.id).not.toBe(ids.get('intro.md'));
    expect(await fs.readFile(path.join(content, copy.path), 'utf8')).toBe(DOCUSAURUS);
    const folderCopy = await storage.copyPage(ids.get('guide/index.md')!, slug, '');
    expect(folderCopy.id).not.toBe(ids.get('guide/index.md'));
    expect(await fs.readFile(path.join(content, folderCopy.path), 'utf8')).toBe('# Guide\n');
    await storage.scanSpace(slug);
    expect((await idsByPath(slug)).get(copy.path)).toBe(copy.id);

    // trash a folder and bring it back
    const guideId = ids.get('guide/index.md')!;
    await storage.deletePage(guideId, admin.id);
    const row = (await query<TrashRow>('SELECT * FROM trash_items WHERE page_id = $1', [guideId]))[0];
    expect(row).toBeDefined();
    await restoreTrashItem(admin, row.id);
    const restored = await idsByPath(slug);
    expect(restored.get('guide/index.md')).toBe(guideId);
    expect(restored.get('guide/step-one.md')).toBe(ids.get('guide/step-one.md'));
    expect(restored.get('guide/step-two.md')).toBe(ids.get('guide/step-two.md'));
    expect(await fs.readFile(path.join(content, 'guide', 'step-one.md'), 'utf8')).toBe(SEED['docs/guide/step-one.md']);
    expect(await exists(path.join(repo, `${slug}.folio`))).toBe(false);
  }, 60_000);

  it('a legacy rootPath space (root <slug>.folio, ids in files) keeps both, with no migration', async () => {
    const name = `${RUN} Legacy`;
    const expectedSlug = translitSlug(name);
    const files = {
      ...SEED,
      [`${expectedSlug}.folio`]: '{"v":1,"name":"Old"}\n',
      'docs/plain.md': '---\nid: 01LEGACYID00000000000000AA\n---\n# Plain\n',
    };
    const { slug, repo, content } = await connect(name, files, 'docs');
    expect(slug).toBe(expectedSlug);
    expect(await storage.folioMetaPath(slug)).toBe(path.join(repo, `${slug}.folio`));
    expect(JSON.parse(await fs.readFile(path.join(repo, `${slug}.folio`), 'utf8')).name).toBe(name);
    expect(await exists(path.join(content, `.${slug}.folio`))).toBe(false);

    expect((await idsByPath(slug)).get('plain.md')).toBe('01LEGACYID00000000000000AA');
    await storage.writeDocBody('01LEGACYID00000000000000AA', '# Plain\n\nEdited.\n');
    expect(await fs.readFile(path.join(content, 'plain.md'), 'utf8')).toBe('---\nid: 01LEGACYID00000000000000AA\n---\n# Plain\n\nEdited.\n');
    // a copy of it does not inherit the id
    const copy = await storage.copyPage('01LEGACYID00000000000000AA', slug, 'guide');
    expect(await fs.readFile(path.join(content, copy.path), 'utf8')).toBe('# Plain\n\nEdited.\n');
  }, 60_000);

  it("a rootPath '' space still stamps ids into files (keeping foreign keys)", async () => {
    const { slug, repo } = await connect(`${RUN} Whole`, { 'intro.md': DOCUSAURUS, 'plain.md': '# Plain\n' }, '');
    const ids = await idsByPath(slug);
    expect(await fs.readFile(path.join(repo, 'plain.md'), 'utf8')).toBe(`---\nid: ${ids.get('plain.md')}\n---\n# Plain\n`);
    expect(await fs.readFile(path.join(repo, 'intro.md'), 'utf8')).toBe(DOCUSAURUS.replace('# a comment\n', `# a comment\nid: ${ids.get('intro.md')}\n`));
    expect(await exists(path.join(repo, `${slug}.folio`))).toBe(true);
  }, 60_000);

  it('moving a page in a light space rewrites its links and the incoming ones in one commit, keeping foreign front matter and adding no id', async () => {
    const intro = '---\ntitle: "Intro: start here"\nsidebar_position: 1\n# a comment\n---\n# Intro\n\nSee [step one](guide/step-one.md) and ![diagram](assets/d.png).\n';
    const { slug, repo, content } = await connect(`${RUN} Flow`, {
      'docs/intro.md': intro,
      'docs/assets/d.png': 'png',
      'docs/guide/index.md': '# Guide\n',
      'docs/guide/step-one.md': '# Step one\n\nBack to [intro](../intro.md).\n',
    }, 'docs');
    const id = (await idsByPath(slug)).get('intro.md')!;

    await collab.movePage(id, 'guide', { name: 'Tester', email: 't@example.test' });

    expect(await fs.readFile(path.join(content, 'guide/intro.md'), 'utf8')).toBe(intro.replace('(guide/step-one.md)', '(step-one.md)').replace('(assets/d.png)', '(../assets/d.png)'));
    expect(await fs.readFile(path.join(content, 'guide/step-one.md'), 'utf8')).toBe('# Step one\n\nBack to [intro](intro.md).\n');
    expect((await idsByPath(slug)).get('guide/intro.md')).toBe(id);
    expect(await gitStatus(repo)).toBe('');
    const show = (await execFileAsync('git', ['show', '--name-status', '--format=%s', 'HEAD'], { cwd: repo })).stdout.trim().split('\n');
    expect(show[0]).toBe('docs: move intro.md -> guide/intro.md');
    expect(show.slice(1).filter(Boolean).map((l) => l.split('\t').pop()).sort()).toEqual(['docs/guide/intro.md', 'docs/guide/step-one.md']);
  }, 60_000);
});
