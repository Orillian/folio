/**
 * Opening a page must not rewrite its file (docs-as-code compatibility test,
 * 14.10.2026, finding 2). The trigger: a page opened in ANY mode (reading
 * included) joins its collab room, and when the last tab leaves, the room's
 * writer is flushed (collab.ts writeState -> createDebouncedWriter.flush, which
 * runs even with nothing pending) — persistDoc -> writeDocBody rewrote the file
 * every time: the executable bit dropped (writeFileAtomic), a trailing newline
 * added, CRLF turned into LF, and a `# Title\r` heading read as no heading at
 * all, so the "new" H1 auto-renamed the file.
 *
 * Here a room is opened (bindState) and flushed (persistDoc) exactly the way
 * y-websocket does it on close. Real PG + real git (a light-footprint space,
 * as in lightFootprint.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as Y from 'yjs';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as collab from './collab.js';
import * as git from './git.js';
import { query } from './db/pool.js';
import { buildEmbed } from './embed.js';
import { getPageMetadata } from './indexV2/read.js';

git.__allowLocalRepoPathsForTests();
const execFileAsync = promisify(execFile);
const RUN = `open-${Date.now().toString(36)}`;
const createdSlugs = new Set<string>();
const tmpDirs: string[] = [];

const FILES: Record<string, string> = {
  'docs/script-like.md': '# Shortcodes\n\nNo trailing newline here.',
  'docs/deprecated.md': '---\ntitle: Old API\nstatus: deprecated\n---\n# Old API\n\nBody.\n',
  'docs/crlf.md': '# CRLF page\r\n\r\nFirst line.\r\nSecond line.\r\n',
  'docs/empty-body.md': '---\ntitle: Only front matter\n---\n',
  // Obsidian-flavoured markup (wave 2) is only ever READ: a page full of it must open, render and embed without a byte changing.
  'docs/obsidian.md':
    '---\ntags: [vault]\naliases: [Vault note]\ncssclasses: wide\n---\n# Vault note\n\n' +
    'Links [[script-like]], [[deprecated|old]], [[crlf#CRLF page]], [[Ghost]] and ![[empty-body]] %%a comment%% #idea/x $e^{i\\pi}$ ^para-1\n\n' +
    '> [!Info]- Folded title\n> body with [[Ghost]]\n\n%%\nblock\ncomment\n%%\n\n$$\n\\frac{a}{b}\n$$\n\n![[pic.png|300]]\n',
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
  await fs.chmod(path.join(seed, 'docs/script-like.md'), 0o755);
  await git.commitAll(seed, 'seed', { name: 'Tester', email: 't@example.test' });
  await execFileAsync('git', ['remote', 'add', 'origin', bare], { cwd: seed });
  await git.push(seed, 'main');
  return bare;
}

async function snapshotFiles(content: string): Promise<Map<string, { bytes: Buffer; mode: number }>> {
  const out = new Map<string, { bytes: Buffer; mode: number }>();
  for (const name of await fs.readdir(content)) {
    if (!name.endsWith('.md')) continue;
    const abs = path.join(content, name);
    out.set(name, { bytes: await fs.readFile(abs), mode: (await fs.stat(abs)).mode & 0o777 });
  }
  return out;
}

/** Open the page's room, then close it the way y-websocket does (writeState flushes the writer). */
async function openAndClose(pageId: string): Promise<Y.Doc> {
  const room = new Y.Doc();
  await collab.bindState(pageId, room);
  expect(await collab.persistDoc(pageId, room)).toBe(true);
  return room;
}

describe('opening a page leaves its file alone (real PG + git)', () => {
  let teardownSchema: () => Promise<void>;
  let slug: string;
  let repo: string;
  let content: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const bare = await seededBareRepo(FILES);
    const info = await storage.createSpaceFromRepo({ name: `${RUN} Docs`, repoUrl: bare, branch: 'main', rootPath: 'docs', createdBy: null });
    slug = info.slug;
    createdSlugs.add(slug);
    repo = storage.getRepoDir(slug);
    content = storage.getSpaceDir(slug);
  });
  afterAll(async () => {
    for (const s of createdSlugs) await deleteTestSpace(s);
    for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await teardownSchema();
  });

  async function pageId(rel: string): Promise<string> {
    const id = await storage.getEntryIdByExactPath(slug, rel);
    expect(id).toBeTruthy();
    return id!;
  }

  it('writeFileAtomic keeps the mode of the file it replaces', async () => {
    const abs = path.join(content, 'mode-probe.txt');
    await fs.writeFile(abs, 'old', 'utf8');
    await fs.chmod(abs, 0o755);
    await storage.writeFileAtomic(abs, 'new');
    expect((await fs.stat(abs)).mode & 0o777).toBe(0o755);
    expect(await fs.readFile(abs, 'utf8')).toBe('new');
    await fs.rm(abs);
  });

  it('open + close, then reopen + close, changes no byte and no mode, and renames nothing', async () => {
    const before = await snapshotFiles(content);
    expect(before.get('script-like.md')?.mode).toBe(0o755);
    // The CRLF heading is a heading: the title is not the file name.
    expect((await storage.getEntry(await pageId('crlf.md')))?.title).toBe('CRLF page');

    for (const rel of before.keys()) await openAndClose(await pageId(rel));
    expect(await snapshotFiles(content)).toEqual(before);
    // Second open resumes the stored snapshot: a body without its final newline
    // is not "changed outside" (no whole-text replace, nothing backed up).
    for (const rel of before.keys()) await openAndClose(await pageId(rel));
    expect(await snapshotFiles(content)).toEqual(before);
    const backups = await query('SELECT 1 FROM page_text_backups p JOIN pages_index i ON i.id = p.page_id WHERE i.space_slug = $1', [slug]);
    expect(backups).toHaveLength(0);

    expect((await execFileAsync('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()).toBe('');
    expect(await storage.getEntryIdByExactPath(slug, 'crlf.md')).toBeTruthy();
  });

  it('reading Obsidian markup (page metadata, embeds of the page, a section, a block) changes no byte either', async () => {
    const before = await snapshotFiles(content);
    const id = await pageId('obsidian.md');
    const entry = await storage.requireEntry(id);
    // What the reading view asks for: the page's typed links, and the embed route's slices.
    const meta = await getPageMetadata({ id, space: slug, relPath: entry.relPath, title: entry.title }, { kind: 'public', space: slug });
    expect(meta.links.map((l) => l.syntax).sort()).toEqual(expect.arrayContaining(['wikilink', 'embed']));
    expect((await buildEmbed(entry, null)).markdown).toContain('[[Ghost]]');
    expect((await buildEmbed(entry, '^para-1')).markdown).toContain('Links [[script-like]]');
    await openAndClose(id);
    expect(await snapshotFiles(content)).toEqual(before);
    expect((await execFileAsync('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()).toBe('');
  });

  it('an edit keeps CRLF line endings, the missing final newline and the file mode', async () => {
    const crlfId = await pageId('crlf.md');
    await storage.writeDocBody(crlfId, '# CRLF page\n\nFirst line, edited.\nSecond line.\n');
    expect(await fs.readFile(path.join(content, 'crlf.md'), 'utf8')).toBe('# CRLF page\r\n\r\nFirst line, edited.\r\nSecond line.\r\n');

    const scriptId = await pageId('script-like.md');
    await storage.writeDocBody(scriptId, '# Shortcodes\n\nEdited, still no trailing newline.');
    const abs = path.join(content, 'script-like.md');
    expect(await fs.readFile(abs, 'utf8')).toBe('# Shortcodes\n\nEdited, still no trailing newline.');
    expect((await fs.stat(abs)).mode & 0o777).toBe(0o755);

    const deprecatedId = await pageId('deprecated.md');
    await storage.writeDocBody(deprecatedId, '# Old API\n\nEdited.\n');
    expect(await fs.readFile(path.join(content, 'deprecated.md'), 'utf8')).toBe(FILES['docs/deprecated.md'].replace('Body.', 'Edited.'));
  });
});
