/**
 * Obsidian vault compatibility, wave 1a — real PG + real git (the "remote" is a
 * local bare repo, as in lightFootprint.test.ts): the per-space scan-ignore
 * list, `.obsidian/` autodetect with light footprint, wikilinks in the link
 * index, and wikilinks following a rename / move. All fixtures are written
 * here; the third-party help vault is only used by obsidianCorpus.test.ts.
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
import * as links from './links.js';
import { query } from './db/pool.js';
import { updateScanSettingsBodySchema } from '../shared/contracts.js';

git.__allowLocalRepoPathsForTests();
const execFileAsync = promisify(execFile);
const RUN = `vault-${Date.now().toString(36)}`;
const AUTHOR = { name: 'Tester', email: 't@example.test' };
const createdSlugs = new Set<string>();
const tmpDirs: string[] = [];

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

async function connect(name: string, files: Record<string, string>, extra: { rootPath?: string; lightFootprint?: boolean } = {}) {
  const bare = await seededBareRepo(files);
  const info = await storage.createSpaceFromRepo({ name, repoUrl: bare, branch: 'main', rootPath: extra.rootPath ?? '', lightFootprint: extra.lightFootprint, createdBy: null });
  createdSlugs.add(info.slug);
  return { info, slug: info.slug, repo: storage.getRepoDir(info.slug), content: storage.getSpaceDir(info.slug) };
}

async function gitStatus(repo: string): Promise<string> {
  return (await execFileAsync('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim();
}

async function pagePaths(slug: string): Promise<string[]> {
  const rows = await query<{ path: string }>('SELECT path FROM pages_index WHERE space_slug = $1 ORDER BY path', [slug]);
  return rows.map((r) => r.path);
}

async function linkRows(sourceId: string) {
  return query<{ kind: string; target_path: string; target_page_id: string | null }>(
    'SELECT kind, target_path, target_page_id FROM links WHERE source_page_id = $1 ORDER BY id',
    [sourceId],
  );
}

/** A file's text without the `id:` front matter a normal (non-light) space stamps into it. */
async function bodyOnDisk(file: string): Promise<string> {
  return (await fs.readFile(file, 'utf8')).replace(/^---\nid: [^\n]+\n---\n/, '');
}

async function idOf(slug: string, relPath: string): Promise<string> {
  const id = await storage.getEntryIdByExactPath(slug, relPath);
  if (!id) throw new Error(`no page ${slug}/${relPath}`);
  return id;
}

describe('Obsidian vault compatibility, wave 1a (real PG + git)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    for (const slug of createdSlugs) await deleteTestSpace(slug);
    for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await teardownSchema();
  });

  it('the per-space ignore list is honoured by the scan, applies to top-level entries only, and changing it rescans', async () => {
    const files = {
      'keep.md': '# Keep\n',
      'Templates/t1.md': '# T1\n',
      'Templates/sub/t2.md': '# T2\n',
      'draft-one.md': '# Draft one\n',
      'draft-two.md': '# Draft two\n',
      'notes/Templates/nested.md': '# Nested stays\n',
      '.obsidian/hidden.md': '# Never a page\n',
      '.trash/gone.md': '# Never a page\n',
    };
    const { slug, info } = await connect(`${RUN} Ignore`, files, { lightFootprint: true });
    expect(info.scanIgnore).toEqual([]);
    expect(await pagePaths(slug)).toEqual(['Templates/sub/t2.md', 'Templates/t1.md', 'draft-one.md', 'draft-two.md', 'keep.md', 'notes/Templates/nested.md']);

    // Zod: a folder-name list, normalized, de-duplicated, bounded.
    const parsed = updateScanSettingsBodySchema.parse({ scanIgnore: ['./Templates/', 'Templates/', 'draft-*', '/other'] });
    expect(parsed.scanIgnore).toEqual(['Templates/', 'draft-*', 'other']);
    for (const bad of [['../up'], ['a/b'], ['*'], ['x/../y'], [''], Array.from({ length: 51 }, (_, i) => `e${i}`)]) {
      expect(updateScanSettingsBodySchema.safeParse({ scanIgnore: bad }).success).toBe(false);
    }
    expect(updateScanSettingsBodySchema.safeParse({}).success).toBe(false);

    const changed = await storage.setSpaceScanSettings(slug, { scanIgnore: parsed.scanIgnore });
    expect(changed.scanIgnore).toEqual(['Templates/', 'draft-*', 'other']);
    expect(await pagePaths(slug)).toEqual(['keep.md', 'notes/Templates/nested.md']);
    // files are never touched, only the index changes
    expect(await fs.readFile(path.join(storage.getSpaceDir(slug), 'Templates/t1.md'), 'utf8')).toBe('# T1\n');

    // a "folders only" entry does not hide a FILE of that name; case does not matter
    await fs.writeFile(path.join(storage.getSpaceDir(slug), 'templates.md'), '# A file named like the folder\n', 'utf8');
    await storage.setSpaceScanSettings(slug, { scanIgnore: ['TEMPLATES/'] });
    expect(await pagePaths(slug)).toEqual(['draft-one.md', 'draft-two.md', 'keep.md', 'notes/Templates/nested.md', 'templates.md']);

    // released again: the pages come back
    await storage.setSpaceScanSettings(slug, { scanIgnore: [] });
    expect(await pagePaths(slug)).toContain('Templates/t1.md');
    expect((await storage.getSpaceInfo(slug))?.scanIgnore).toEqual([]);
  });

  it('a repository with .obsidian/ is detected, connected as light footprint, and nothing is written into it', async () => {
    const note = 'Plain note, no front matter.\n\nLinks to [[Other note]].\n';
    const withProps = '---\ntags: [a, b]\naliases:\n  - Alt name\ncustom: "kept as is"\n# a comment\n---\n# Heading\n\nBody with `code`.\n';
    const files = {
      '.obsidian/app.json': '{"alwaysUpdateLinks":true}\n',
      'Note.md': note,
      'Other note.md': withProps,
      'Folder/Inner.md': 'Inner without a trailing newline',
    };
    const { slug, info, repo, content } = await connect(`${RUN} Vault`, files);
    expect(info.vaultDetected).toBe(true);
    expect(info.lightFootprint).toBe(true);
    expect(storage.isLightFootprintSpace(slug)).toBe(true);
    expect((await storage.getSpaceInfo(slug))?.lightFootprint).toBe(true);

    for (const [rel, text] of Object.entries(files)) expect(await fs.readFile(path.join(repo, rel), 'utf8')).toBe(text);
    expect(await gitStatus(repo)).toBe('');
    // the metadata is a dotfile at the vault root, not a visible `<slug>.folio`
    expect(await storage.folioMetaPath(slug)).toBe(path.join(content, `.${slug}.folio`));
    await expect(fs.access(path.join(repo, `${slug}.folio`))).rejects.toThrow();
    expect(await pagePaths(slug)).toEqual(['Folder/Inner.md', 'Note.md', 'Other note.md']);

    // the ids are index-only and survive a rescan; editing a page keeps its front matter and still writes no id
    const ids = new Map((await storage.listEntries(slug)).map((e) => [e.relPath, e.id]));
    await storage.scanSpace(slug);
    for (const e of await storage.listEntries(slug)) expect(e.id).toBe(ids.get(e.relPath));
    await storage.writeDocBody(ids.get('Other note.md')!, '# Heading\n\nEdited body.\n');
    const edited = await fs.readFile(path.join(repo, 'Other note.md'), 'utf8');
    expect(edited).toBe('---\ntags: [a, b]\naliases:\n  - Alt name\ncustom: "kept as is"\n# a comment\n---\n# Heading\n\nEdited body.\n');
    expect(edited).not.toMatch(/^id:/m);

    // not a vault (or `.obsidian` gitignored), no flag: light all the same — the repository's own files get no id;
    // an explicit false keeps the native mode (ids are written)
    const plain = await connect(`${RUN} Plain`, { 'a.md': '# A\n' });
    expect(plain.info.vaultDetected).toBeUndefined();
    expect(plain.info.lightFootprint).toBe(true);
    expect(await fs.readFile(path.join(plain.repo, 'a.md'), 'utf8')).toBe('# A\n');
    const native = await connect(`${RUN} Native`, { 'a.md': '# A\n' }, { lightFootprint: false });
    expect(native.info.lightFootprint).toBeUndefined();
    expect(await fs.readFile(path.join(native.repo, 'a.md'), 'utf8')).toMatch(/^---\nid: /);
    const manual = await connect(`${RUN} Manual`, { 'a.md': '# A\n' }, { lightFootprint: true });
    expect(manual.info.lightFootprint).toBe(true);
    expect(manual.info.vaultDetected).toBeUndefined();
    expect(await fs.readFile(path.join(manual.repo, 'a.md'), 'utf8')).toBe('# A\n');

    // the admin can flip the flag later; scan settings round-trip
    const flipped = await storage.setSpaceScanSettings(manual.slug, { lightFootprint: false });
    expect(flipped.lightFootprint).toBeUndefined();
    expect(storage.isLightFootprintSpace(manual.slug)).toBe(false);
  });

  it('wikilinks are indexed: alias, heading, block, embed, the basename and path rules, asset and broken kinds, none inside code', async () => {
    const space = await storage.createSpace(`${RUN} Wiki Index`, null);
    createdSlugs.add(space.slug);
    const slug = space.slug;
    const dir = storage.getSpaceDir(slug);
    const put = async (rel: string, text: string) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), text, 'utf8');
    };
    await put('Home.md', '# Home\n');
    await put('Guide/Install.md', '# Install\n');
    await put('Guide/Setup/Install.md', '# Setup install\n');
    await put('Notes/My Note.md', '# My Note\n');
    // Wave 3: an embed resolves to an asset only when the file exists — found here by the attachment basename rule.
    await put('Attachments/photo.png', 'png bytes');
    await put(
      'Source.md',
      [
        '# Source',
        '',
        'Plain [[Home]], alias [[Home|the home page]], heading [[Home#Some heading]], block [[Home#^abc123]].',
        'Embed ![[Home]], encoded [[My%20Note]], case [[my note]], path [[Guide/Install]], trailing path [[Setup/Install]].',
        'Missing [[Not there]] and [[Folder/Also not there.md]], image ![[photo.png|300]], same page [[#Local heading]].',
        'In code `[[Home]]` and',
        '```',
        '[[Notes/My Note]] ![[hidden.png]]',
        '```',
      ].join('\n') + '\n',
    );
    await put('Guide/Setup/Deep.md', '# Deep\n\nNearest install: [[Install]]; root-level: [[Home]]\n');
    await put('Guide/Sibling.md', '# Sibling\n\n[[Install]]\n');
    await storage.scanSpace(slug);

    const homeId = await idOf(slug, 'Home.md');
    const sourceId = await idOf(slug, 'Source.md');
    const rows = await linkRows(sourceId);
    const pageTargets = rows.filter((r) => r.kind === 'page').map((r) => r.target_path);
    expect(pageTargets.sort()).toEqual(
      [
        'Home.md', 'Home.md', 'Home.md', 'Home.md', 'Home.md', // plain, alias, heading, block, embed
        'Notes/My Note.md', 'Notes/My Note.md', // %20 and case-insensitive
        'Guide/Install.md', // path from the space root
        'Guide/Setup/Install.md', // trailing path
      ].sort(),
    );
    expect(rows.filter((r) => r.kind === 'page').every((r) => r.target_page_id !== null)).toBe(true);
    expect(rows.filter((r) => r.kind === 'broken').map((r) => r.target_path).sort()).toEqual(['Folder/Also not there.md', 'Not there.md']);
    expect(rows.filter((r) => r.kind === 'asset').map((r) => r.target_path)).toEqual(['Attachments/photo.png']);
    // 9 page + 2 broken + 1 asset: no row for `[[#Local heading]]`, the inline code or the fence
    expect(rows.length).toBe(12);

    // the ambiguous bare name goes to the nearest page
    expect((await linkRows(await idOf(slug, 'Guide/Setup/Deep.md'))).map((r) => r.target_path).sort()).toEqual(['Guide/Setup/Install.md', 'Home.md']);
    expect((await linkRows(await idOf(slug, 'Guide/Sibling.md'))).map((r) => r.target_path)).toEqual(['Guide/Install.md']);

    // backlinks include wikilink sources
    const backlinkIds = (await links.getBacklinks(homeId)).map((b) => b.id);
    expect(backlinkIds).toContain(sourceId);
    expect(backlinkIds).toContain(await idOf(slug, 'Guide/Setup/Deep.md'));

    // a save (not a scan) indexes wikilinks too, through the single-page loader
    const fresh = await storage.createPage({ space: slug, parentPath: '', title: 'Fresh', kind: 'doc' });
    await storage.writeDocBody(fresh.id, '# Fresh\n\nSee [[Home|h]] and ![[Guide/Setup/Install]] and [[Nope]].\n');
    expect((await linkRows(fresh.id)).map((r) => `${r.kind}:${r.target_path}`).sort()).toEqual(['broken:Nope.md', 'page:Guide/Setup/Install.md', 'page:Home.md']);

    // a page that appears later resolves a broken wikilink on the next scan
    await put('Not there.md', '# Not there\n');
    await storage.scanSpace(slug);
    expect((await linkRows(sourceId)).filter((r) => r.kind === 'broken').map((r) => r.target_path)).toEqual(['Folder/Also not there.md']);
  });

  it('renaming or moving a page keeps the wikilinks to it resolved, in their own form, and the number of broken links does not grow', async () => {
    const space = await storage.createSpace(`${RUN} Wiki Rewrite`, null);
    createdSlugs.add(space.slug);
    const slug = space.slug;
    const dir = storage.getSpaceDir(slug);
    const put = async (rel: string, text: string) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), text, 'utf8');
    };
    await put('docs/old-name.md', '# Old name\n');
    const readerBody = [
      '# Reader',
      '',
      'bare [[old-name]], alias [[old-name|the page]], heading [[old-name#Part one]], block [[old-name#^b1]], embed ![[old-name]].',
      'path [[docs/old-name]], md [m](old-name.md), code `[[old-name]]`, unrelated [[docs/reader]] and [[ghost]].',
      '',
    ].join('\n');
    await put('docs/reader.md', readerBody);
    await put('elsewhere/viewer.md', 'Viewer: [[old-name#H|v]] and [[docs/old-name]]\n');
    await put('docs/mover.md', '# Mover\n\nrelative [[./reader]], parent-less [[reader]], root path [[docs/reader]], sibling md [r](reader.md)\n');
    await storage.scanSpace(slug);

    const brokenCount = async () => Number((await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM links l JOIN pages_index p ON p.id = l.source_page_id WHERE p.space_slug = $1 AND l.kind = 'broken'`, [slug]))[0].n);
    const brokenBefore = await brokenCount();
    expect(brokenBefore).toBe(1); // only [[ghost]]

    const oldId = await idOf(slug, 'docs/old-name.md');
    await collab.renamePageSlug(oldId, 'new-slug', AUTHOR);

    expect(await bodyOnDisk(path.join(dir, 'docs/reader.md'))).toBe(
      [
        '# Reader',
        '',
        'bare [[new-slug]], alias [[new-slug|the page]], heading [[new-slug#Part one]], block [[new-slug#^b1]], embed ![[new-slug]].',
        'path [[docs/new-slug]], md [m](new-slug.md), code `[[old-name]]`, unrelated [[docs/reader]] and [[ghost]].',
        '',
      ].join('\n'),
    );
    expect(await bodyOnDisk(path.join(dir, 'elsewhere/viewer.md'))).toBe('Viewer: [[new-slug#H|v]] and [[docs/new-slug]]\n');
    expect(await bodyOnDisk(path.join(dir, 'docs/mover.md'))).toContain('relative [[./reader]], parent-less [[reader]]'); // untouched
    expect(await brokenCount()).toBeLessThanOrEqual(brokenBefore);
    expect(await idOf(slug, 'docs/new-slug.md')).toBe(oldId);
    const afterRename = await linkRows(await idOf(slug, 'docs/reader.md'));
    expect(afterRename.filter((r) => r.target_page_id === oldId).length).toBe(7); // 5 wikilinks + path + md link

    // move the target into another folder: the bare name stays, the path-style one follows
    await collab.movePage(oldId, 'archive/2026', AUTHOR);
    const reader = await bodyOnDisk(path.join(dir, 'docs/reader.md'));
    expect(reader).toContain('bare [[new-slug]], alias [[new-slug|the page]], heading [[new-slug#Part one]], block [[new-slug#^b1]], embed ![[new-slug]].');
    expect(reader).toContain('path [[archive/2026/new-slug]], md [m](../archive/2026/new-slug.md)');
    expect(await bodyOnDisk(path.join(dir, 'elsewhere/viewer.md'))).toBe('Viewer: [[new-slug#H|v]] and [[archive/2026/new-slug]]\n');
    expect(await brokenCount()).toBeLessThanOrEqual(brokenBefore);

    // move a SOURCE: an explicit relative wikilink is re-aimed, bare and root-style ones need nothing
    const moverId = await idOf(slug, 'docs/mover.md');
    await collab.movePage(moverId, 'deep/er', AUTHOR);
    const mover = await bodyOnDisk(path.join(dir, 'deep/er/mover.md'));
    expect(mover).toBe('# Mover\n\nrelative [[../../docs/reader]], parent-less [[reader]], root path [[docs/reader]], sibling md [r](../../docs/reader.md)\n');
    expect(await brokenCount()).toBeLessThanOrEqual(brokenBefore);
    const moverLinks = await linkRows(moverId);
    expect(moverLinks.filter((r) => r.kind === 'page').length).toBe(4);
    expect(moverLinks.every((r) => r.kind !== 'broken')).toBe(true);
  });
});
