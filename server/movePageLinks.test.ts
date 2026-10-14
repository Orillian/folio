/**
 * collab.movePage: moving a page (or an index page's whole directory) keeps
 * every relative link working — the moved docs' OUTGOING links/images are
 * re-aimed from their new directory, links from OTHER pages to anything that
 * moved are rewritten — and the move plus all the rewrites land as ONE
 * dedicated commit. Real fs + real PG + real git, same style as
 * slugRename.test.ts (no HTTP layer).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as Y from 'yjs';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as collab from './collab.js';
import * as gitSync from './gitSync.js';
import * as links from './links.js';

const AUTHOR = { name: 'Tester', email: 't@example.test' };
const execFileAsync = promisify(execFile);

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: dir });
  return stdout;
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), content, 'utf8');
}

async function bodyOf(space: string, relPath: string): Promise<string> {
  const entry = (await storage.listEntries(space)).find((e) => e.relPath === relPath);
  expect(entry, `entry ${relPath}`).toBeDefined();
  return storage.readFreshDocBody(entry!.id);
}

async function entryId(space: string, relPath: string): Promise<string> {
  const entry = (await storage.listEntries(space)).find((e) => e.relPath === relPath);
  expect(entry, `entry ${relPath}`).toBeDefined();
  return entry!.id;
}

describe('collab.movePage rewrites links and commits as one unit (real PG + real git)', () => {
  let teardownSchema: () => Promise<void>;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    await teardownSchema();
  });

  it('moves a leaf page to a different depth: its own links/images are re-aimed, incoming links follow, one commit holds it all', async () => {
    const space = await storage.createSpace(`Move Links Leaf ${Date.now()}`, null);
    const dir = storage.getSpaceDir(space.slug);
    const repo = storage.getRepoDir(space.slug);
    try {
      await write(dir, 'assets/a.png', 'png');
      await write(dir, 'guide/intro.md', '# Intro\n\n![logo](../assets/a.png)\n\n[sib](sibling.md) and [top](../top.md#part "Top") and [web](https://example.com/x.md).\n');
      await write(dir, 'guide/sibling.md', '# Sibling\n\n[back to intro](intro.md)\n');
      await write(dir, 'top.md', '# Top\n\nSee [intro](guide/intro.md) and [again](./guide/intro.md?x=1#h).\n');
      await storage.scanSpace(space.slug);
      const introId = await entryId(space.slug, 'guide/intro.md');
      await gitSync.commitNow(space.slug, 'baseline', AUTHOR);
      const baseSha = (await git(repo, 'rev-parse', 'HEAD')).trim();

      const meta = await collab.movePage(introId, 'archive/deep', AUTHOR);
      expect(meta.path).toBe('archive/deep/intro.md');

      expect(await bodyOf(space.slug, 'archive/deep/intro.md')).toBe(
        '# Intro\n\n![logo](../../assets/a.png)\n\n[sib](../../guide/sibling.md) and [top](../../top.md#part "Top") and [web](https://example.com/x.md).\n',
      );
      expect(await bodyOf(space.slug, 'top.md')).toBe('# Top\n\nSee [intro](archive/deep/intro.md) and [again](archive/deep/intro.md?x=1#h).\n');
      expect(await bodyOf(space.slug, 'guide/sibling.md')).toBe('# Sibling\n\n[back to intro](../archive/deep/intro.md)\n');

      // Exactly one new commit: the move (a rename) plus the two rewritten linking pages.
      expect((await git(repo, 'rev-list', '--count', `${baseSha}..HEAD`)).trim()).toBe('1');
      expect((await git(repo, 'log', '-1', '--format=%s')).trim()).toBe('docs: move guide/intro.md -> archive/deep/intro.md');
      // --no-renames: a heavily rewritten small file would otherwise fall under git's similarity threshold.
      const status = (await git(repo, 'show', '--name-status', '--format=', '--no-renames', 'HEAD')).trim().split('\n');
      expect(status.some((l) => /^D\s+guide\/intro\.md$/.test(l))).toBe(true);
      expect(status.some((l) => /^A\s+archive\/deep\/intro\.md$/.test(l))).toBe(true);
      expect(status.some((l) => /^M\s+top\.md$/.test(l))).toBe(true);
      expect(status.some((l) => /^M\s+guide\/sibling\.md$/.test(l))).toBe(true);
      expect((await git(repo, 'status', '--porcelain')).trim()).toBe('');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('moves an index page with its whole directory: co-moved links stay as written, outward and incoming links are fixed, files inside move along', async () => {
    const space = await storage.createSpace(`Move Links Index ${Date.now()}`, null);
    const dir = storage.getSpaceDir(space.slug);
    const repo = storage.getRepoDir(space.slug);
    try {
      await write(dir, 'top.md', '# Top\n\n[notes](notes/) [kid](notes/kid.md) ![pic](notes/pic.png) [idx](notes/index.md)\n');
      await write(dir, 'notes/index.md', '# Notes\n\n![pic](pic.png) [kid](kid.md) [out](../top.md) [deep](sub/deeper.md)\n');
      await write(dir, 'notes/kid.md', '# Kid\n\n[idx](index.md) [top](../top.md) [deeper](sub/deeper.md)\n');
      await write(dir, 'notes/sub/deeper.md', '# Deeper\n\n[kid](../kid.md) [top](../../top.md)\n');
      await write(dir, 'notes/pic.png', 'png');
      // Links to nothing but a non-page file inside the directory: no page backlink, only the asset-link capture catches it.
      await write(dir, 'gallery/shot.md', '# Shot\n\n![pic](../notes/pic.png)\n');
      await storage.scanSpace(space.slug);
      const idxId = await entryId(space.slug, 'notes/index.md');
      const kidId = await entryId(space.slug, 'notes/kid.md');
      await gitSync.commitNow(space.slug, 'baseline', AUTHOR);
      const baseSha = (await git(repo, 'rev-parse', 'HEAD')).trim();

      await collab.movePage(idxId, 'archive/old', AUTHOR);

      expect((await storage.getEntry(kidId))?.relPath).toBe('archive/old/notes/kid.md');
      await expect(fs.access(path.join(dir, 'archive/old/notes/pic.png'))).resolves.toBeUndefined();
      expect(await bodyOf(space.slug, 'archive/old/notes/index.md')).toBe('# Notes\n\n![pic](pic.png) [kid](kid.md) [out](../../../top.md) [deep](sub/deeper.md)\n');
      expect(await bodyOf(space.slug, 'archive/old/notes/kid.md')).toBe('# Kid\n\n[idx](index.md) [top](../../../top.md) [deeper](sub/deeper.md)\n');
      expect(await bodyOf(space.slug, 'archive/old/notes/sub/deeper.md')).toBe('# Deeper\n\n[kid](../kid.md) [top](../../../../top.md)\n');
      expect(await bodyOf(space.slug, 'gallery/shot.md')).toBe('# Shot\n\n![pic](../archive/old/notes/pic.png)\n');
      expect(await bodyOf(space.slug, 'top.md')).toBe(
        '# Top\n\n[notes](archive/old/notes/) [kid](archive/old/notes/kid.md) ![pic](archive/old/notes/pic.png) [idx](archive/old/notes/index.md)\n',
      );

      expect((await git(repo, 'rev-list', '--count', `${baseSha}..HEAD`)).trim()).toBe('1');
      expect((await git(repo, 'log', '-1', '--format=%s')).trim()).toBe('docs: move notes/index.md -> archive/old/notes/index.md');
      const names = (await git(repo, 'show', '--name-only', '--format=', '-M', 'HEAD')).trim().split('\n');
      expect(names).toEqual(expect.arrayContaining(['top.md', 'archive/old/notes/index.md', 'archive/old/notes/kid.md', 'archive/old/notes/pic.png']));
      expect((await git(repo, 'status', '--porcelain')).trim()).toBe('');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('moves a leaf page together with its same-named children directory (shape 2): parent/child links survive in both directions', async () => {
    const space = await storage.createSpace(`Move Links Shape2 ${Date.now()}`, null);
    const dir = storage.getSpaceDir(space.slug);
    try {
      await write(dir, 'plan.md', '# Plan\n\n[child](plan/child.md) [up](other.md)\n');
      await write(dir, 'plan/child.md', '# Child\n\n[parent](../plan.md) [other](../other.md)\n');
      await write(dir, 'other.md', '# Other\n\n[plan](plan.md) [child](plan/child.md)\n');
      await storage.scanSpace(space.slug);

      await collab.movePage(await entryId(space.slug, 'plan.md'), 'archive', AUTHOR);

      expect(await bodyOf(space.slug, 'archive/plan.md')).toBe('# Plan\n\n[child](plan/child.md) [up](../other.md)\n');
      expect(await bodyOf(space.slug, 'archive/plan/child.md')).toBe('# Child\n\n[parent](../plan.md) [other](../../other.md)\n');
      expect(await bodyOf(space.slug, 'other.md')).toBe('# Other\n\n[plan](archive/plan.md) [child](archive/plan/child.md)\n');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('first scan: a link to a page that sorts LATER is a real backlink, so a move and a slug rename both rewrite it', async () => {
    const space = await storage.createSpace(`Move Links FirstScan ${Date.now()}`, null);
    const dir = storage.getSpaceDir(space.slug);
    try {
      await write(dir, 'a.md', '# A\n\n[z](z.md) [y](y.md)\n');
      await write(dir, 'y.md', '# Y\n');
      await write(dir, 'z.md', '# Z\n');
      await storage.scanSpace(space.slug);
      const zId = await entryId(space.slug, 'z.md');
      const yId = await entryId(space.slug, 'y.md');
      const aId = await entryId(space.slug, 'a.md');
      expect((await links.getBacklinks(zId)).map((b) => b.id)).toContain(aId);

      await collab.movePage(zId, 'archive', AUTHOR);
      expect(await storage.readFreshDocBody(aId)).toBe('# A\n\n[z](archive/z.md) [y](y.md)\n');
      await collab.renamePageSlug(yId, 'why', AUTHOR);
      expect(await storage.readFreshDocBody(aId)).toBe('# A\n\n[z](archive/z.md) [y](why.md)\n');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('rescan: an unchanged source holding a broken link is re-indexed once its target appears', async () => {
    const space = await storage.createSpace(`Move Links Rescan ${Date.now()}`, null);
    const dir = storage.getSpaceDir(space.slug);
    try {
      await write(dir, 'a.md', '# A\n\n[late](late.md)\n');
      await storage.scanSpace(space.slug);
      const aId = await entryId(space.slug, 'a.md');

      await write(dir, 'late.md', '# Late\n');
      await storage.scanSpace(space.slug);
      const lateId = await entryId(space.slug, 'late.md');
      expect((await links.getBacklinks(lateId)).map((b) => b.id)).toContain(aId);
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('a moved board stays a link target: links to it are rewritten (boards themselves carry no markdown links)', async () => {
    const space = await storage.createSpace(`Move Links Board ${Date.now()}`, null);
    const dir = storage.getSpaceDir(space.slug);
    try {
      const board = await storage.createPage({ space: space.slug, parentPath: '', title: 'Sketch', kind: 'board' });
      const doc = await storage.createPage({ space: space.slug, parentPath: 'docs', title: 'Doc', kind: 'doc' });
      await storage.writeDocBody(doc.id, `# Doc\n\n[board](../${board.path})\n`);

      const moved = await collab.movePage(board.id, 'archive', AUTHOR);
      expect(moved.path).toBe('archive/sketch.excalidraw.svg');
      expect(await storage.readFreshDocBody(doc.id)).toBe('# Doc\n\n[board](../archive/sketch.excalidraw.svg)\n');
      await expect(fs.access(path.join(dir, 'archive/sketch.excalidraw.svg'))).resolves.toBeUndefined();
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('moving to the current parent is a no-op: nothing rewritten, no new commit', async () => {
    const space = await storage.createSpace(`Move Links Noop ${Date.now()}`, null);
    const dir = storage.getSpaceDir(space.slug);
    const repo = storage.getRepoDir(space.slug);
    try {
      await write(dir, 'a/page.md', '# Page\n\n[x](../x.md)\n');
      await write(dir, 'x.md', '# X\n');
      await storage.scanSpace(space.slug);
      await gitSync.commitNow(space.slug, 'baseline', AUTHOR);
      const head = (await git(repo, 'rev-parse', 'HEAD')).trim();

      await collab.movePage(await entryId(space.slug, 'a/page.md'), 'a', AUTHOR);

      expect((await git(repo, 'rev-parse', 'HEAD')).trim()).toBe(head);
      expect(await bodyOf(space.slug, 'a/page.md')).toBe('# Page\n\n[x](../x.md)\n');
    } finally {
      await deleteTestSpace(space.slug);
    }
  });

  it('a moved page that is open in the editor gets its links fixed through the live Y.Doc and flushed to disk', async () => {
    const space = await storage.createSpace(`Move Links Live ${Date.now()}`, null);
    const dir = storage.getSpaceDir(space.slug);
    try {
      const bodyText = '# Live\n\n[x](../x.md) ![i](../assets/p.png)\n';
      await write(dir, 'a/live.md', bodyText);
      await write(dir, 'x.md', '# X\n');
      await write(dir, 'assets/p.png', 'png');
      await storage.scanSpace(space.slug);
      const liveId = await entryId(space.slug, 'a/live.md');

      const { createRequire } = await import('node:module');
      const ywsUtils = createRequire(import.meta.url)('y-websocket/bin/utils') as { docs: Map<string, Y.Doc> };
      const ydoc = new Y.Doc();
      ydoc.getText('content').insert(0, bodyText);
      ywsUtils.docs.set(liveId, ydoc);
      await collab.bindState(liveId, ydoc);

      try {
        expect(collab.isDocLive(liveId)).toBe(true);
        await collab.movePage(liveId, 'b/c/d', AUTHOR);
        const expected = '# Live\n\n[x](../../../x.md) ![i](../../../assets/p.png)\n';
        expect(ydoc.getText('content').toString()).toBe(expected);
        expect(await storage.readFreshDocBody(liveId)).toBe(expected);
      } finally {
        ywsUtils.docs.delete(liveId);
      }
    } finally {
      await deleteTestSpace(space.slug);
    }
  });
});
