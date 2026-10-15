/**
 * Acceptance on a real vault (Obsidian vault compatibility, wave 1a): the
 * English help vault, when it is present on this machine, is copied to a temp
 * directory, committed as a repository and connected as a space. The corpus is
 * third-party text with no licence: it is read from disk at test time only and
 * never copied into this repository — the test is skipped when it is absent
 * (the folder lives in the gitignored `donors/` of the main checkout; set
 * OBSIDIAN_HELP_DIR to point somewhere else).
 *
 *  - connecting writes nothing: `git status` of the space is clean and every file
 *    is byte-identical to the source;
 *  - wikilinks are indexed (the vault is full of them); index v2 (wave 1b):
 *    headings are indexed, every link to a page that exists resolves (the only
 *    unresolved ones are the help text's examples), every #heading / #^block
 *    fragment resolves, and the scan still writes nothing;
 *  - renaming the most linked-to page does not increase the number of broken
 *    links, and only touches the lines that named the page.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as git from './git.js';
import * as collab from './collab.js';
import { query } from './db/pool.js';

const execFileAsync = promisify(execFile);
const here = path.dirname(new URL(import.meta.url).pathname);

function findCorpus(): string | null {
  const candidates = [
    process.env.OBSIDIAN_HELP_DIR,
    path.resolve(here, '../donors/obsidian/obsidian-help/en'),
    path.resolve(here, '../../../../donors/obsidian/obsidian-help/en'), // a worktree under <main checkout>/.claude/worktrees/<name>
  ];
  for (const c of candidates) if (c && fsSync.existsSync(c) && fsSync.statSync(c).isDirectory()) return c;
  return null;
}
const CORPUS = findCorpus();

async function walkFiles(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const d of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...(await walkFiles(root, r)));
    else if (d.isFile()) out.push(r);
  }
  return out;
}

describe.skipIf(!CORPUS)('a real Obsidian vault as a space (corpus acceptance)', () => {
  let teardownSchema: () => Promise<void>;
  let slug = '';
  let repo = '';
  const tmpDirs: string[] = [];

  beforeAll(async () => {
    git.__allowLocalRepoPathsForTests();
    teardownSchema = await setUpTestSchema();
    const stamp = `corpus-${Date.now().toString(36)}`;
    const seed = path.join(os.tmpdir(), `folio-${stamp}-seed`);
    const bare = path.join(os.tmpdir(), `folio-${stamp}.git`);
    tmpDirs.push(seed, bare);
    await fs.cp(CORPUS!, seed, { recursive: true });
    // what makes it a vault: the settings folder Obsidian keeps at its root (our own minimal content)
    await fs.mkdir(path.join(seed, '.obsidian'), { recursive: true });
    await fs.writeFile(path.join(seed, '.obsidian', 'app.json'), '{}\n', 'utf8');
    await execFileAsync('git', ['init', '-b', 'main', seed]);
    await git.commitAll(seed, 'vault', { name: 'Tester', email: 't@example.test' });
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bare]);
    await execFileAsync('git', ['remote', 'add', 'origin', bare], { cwd: seed });
    await git.push(seed, 'main');

    const info = await storage.createSpaceFromRepo({ name: `Corpus ${stamp}`, repoUrl: bare, branch: 'main', rootPath: '', createdBy: null });
    slug = info.slug;
    repo = storage.getRepoDir(slug);
    expect(info.vaultDetected).toBe(true);
    expect(info.lightFootprint).toBe(true);
  }, 120_000);

  afterAll(async () => {
    if (slug) await deleteTestSpace(slug);
    for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await teardownSchema?.();
  });

  it('connecting and scanning leaves the vault untouched: git status is clean and every file is byte-identical', async () => {
    expect((await execFileAsync('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()).toBe('');
    const sourceFiles = await walkFiles(CORPUS!);
    for (const rel of sourceFiles) {
      const [a, b] = await Promise.all([fs.readFile(path.join(CORPUS!, rel)), fs.readFile(path.join(repo, rel))]);
      expect(b.equals(a), rel).toBe(true);
    }
    const markdown = sourceFiles.filter((f) => f.endsWith('.md') && !f.split('/').some((s) => s.startsWith('.') || s === 'assets'));
    const pages = await query<{ path: string }>(`SELECT path FROM pages_index WHERE space_slug = $1 AND kind = 'doc'`, [slug]);
    expect(pages.length).toBe(markdown.length);
  });

  it('index v2: headings are indexed, no link to an existing page stays unresolved (only the 6 to the help text\'s made-up "Example"), every #heading / #^block fragment resolves, and git status stays clean', async () => {
    const headings = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM page_headings h JOIN pages_index p ON p.id = h.page_id WHERE p.space_slug = $1`, [slug]);
    expect(headings[0].n).toBeGreaterThan(0);
    const unresolved = await query<{ link_path: string; target_path: string }>(
      `SELECT l.link_path, l.target_path FROM page_links l JOIN pages_index p ON p.id = l.source_page_id WHERE p.space_slug = $1 AND l.kind = 'unresolved'`,
      [slug],
    );
    // "Internal links.md" explains the syntax with links to a note called Example, which the vault does not have.
    expect(unresolved).toHaveLength(6);
    const pageNames = new Set((await query<{ path: string }>('SELECT path FROM pages_index WHERE space_slug = $1', [slug])).map((r) => path.posix.basename(r.path).toLowerCase()));
    for (const row of unresolved) {
      expect(path.posix.basename(row.target_path).toLowerCase()).toBe('example.md');
      expect(pageNames.has('example.md')).toBe(false);
    }
    const fragments = await query<{ total: number; bad: number }>(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE l.fragment_resolved IS NOT TRUE)::int AS bad
         FROM page_links l JOIN pages_index p ON p.id = l.source_page_id
        WHERE p.space_slug = $1 AND l.kind = 'page' AND l.fragment IS NOT NULL`,
      [slug],
    );
    expect(fragments[0].total).toBeGreaterThan(10);
    expect(fragments[0].bad).toBe(0);
    expect((await execFileAsync('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()).toBe('');
  });

  it('indexes the wikilinks, and renaming the most linked-to page does not make more links broken', async () => {
    const wiki = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM links l JOIN pages_index p ON p.id = l.source_page_id WHERE p.space_slug = $1 AND l.kind = 'page'`,
      [slug],
    );
    expect(Number(wiki[0].n)).toBeGreaterThan(100);

    const broken = async () =>
      Number((await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM links l JOIN pages_index p ON p.id = l.source_page_id WHERE p.space_slug = $1 AND l.kind = 'broken'`, [slug]))[0].n);
    const before = await broken();

    const top = (
      await query<{ id: string; path: string; n: string }>(
        `SELECT t.id, t.path, COUNT(DISTINCT l.source_page_id)::text AS n
           FROM links l JOIN pages_index t ON t.id = l.target_page_id
          WHERE t.space_slug = $1 AND t.kind = 'doc' AND t.path NOT LIKE '%/index.md' AND t.path NOT LIKE '%/README.md'
          GROUP BY t.id, t.path ORDER BY COUNT(DISTINCT l.source_page_id) DESC, t.path LIMIT 1`,
        [slug],
      )
    )[0];
    expect(Number(top.n)).toBeGreaterThan(3);
    const sourcesBefore = new Map<string, string>();
    for (const row of await query<{ path: string }>(`SELECT DISTINCT s.path FROM links l JOIN pages_index s ON s.id = l.source_page_id WHERE l.target_page_id = $1`, [top.id])) {
      sourcesBefore.set(row.path, await fs.readFile(path.join(repo, row.path), 'utf8'));
    }

    await collab.renamePageSlug(top.id, 'renamed-by-test', { name: 'Tester', email: 't@example.test' });

    expect(await broken()).toBeLessThanOrEqual(before);
    const target = await query<{ path: string }>('SELECT path FROM pages_index WHERE id = $1', [top.id]);
    expect(path.posix.basename(target[0].path)).toBe('renamed-by-test.md');

    // every changed line of a source named the page; the lines that did not are byte-identical
    const stem = path.posix.basename(top.path, '.md').toLowerCase();
    let changedFiles = 0;
    for (const [rel, oldText] of sourcesBefore) {
      const newText = await fs.readFile(path.join(repo, rel), 'utf8').catch(() => oldText); // a moved source (inside the renamed folder) is skipped
      if (newText === oldText) continue;
      changedFiles++;
      const oldLines = oldText.split('\n');
      const newLines = newText.split('\n');
      expect(newLines.length).toBe(oldLines.length);
      oldLines.forEach((line, i) => {
        if (line !== newLines[i]) expect(line.toLowerCase()).toContain(stem.replace(/%20/g, ' '));
      });
    }
    expect(changedFiles).toBeGreaterThan(0);
    // and every page that linked to it still does, resolved to the same page
    const still = await query<{ n: string }>('SELECT COUNT(DISTINCT source_page_id)::text AS n FROM links WHERE target_page_id = $1', [top.id]);
    expect(Number(still[0].n)).toBe(sourcesBefore.size);
  }, 120_000);
});
