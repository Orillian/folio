/**
 * A canvas / base is named by its file, as in Obsidian (owner, 16.10.2026): the
 * rename takes any valid file name — Cyrillic, spaces — keeps the extension, the
 * page id and the property sidecar, rewrites the links to it (wikilinks,
 * markdown links, canvas file cards) in native and light-footprint spaces
 * alike, and lands as one commit. Real fs + real PG + real git, no HTTP layer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as collab from './collab.js';
import * as propsSidecar from './propsSidecar.js';
import * as authStore from './auth/store.js';
import { buildCanvasPayload } from './canvasView.js';
import { userViewer } from './accessSql.js';
import type { User } from '../shared/contracts.js';

const AUTHOR = { name: 'Rename Tester', email: 'rename@example.test' };
const execFileAsync = promisify(execFile);

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: dir });
  return stdout;
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), content);
}

async function exists(abs: string): Promise<boolean> {
  return fs.access(abs).then(
    () => true,
    () => false,
  );
}

async function entryAt(space: string, relPath: string): Promise<storage.PageIndexEntry> {
  const entry = (await storage.listEntries(space)).find((e) => e.relPath === relPath);
  expect(entry, `entry ${relPath}`).toBeDefined();
  return entry!;
}

const BASE_TEXT = 'views:\n  - type: table\n    name: Table\n';

function canvasWith(file: string): string {
  return JSON.stringify(
    {
      nodes: [
        { id: 'a', type: 'file', file, x: 0, y: 0, width: 100, height: 100 },
        { id: 'b', type: 'text', text: `see [[${file}]] here`, x: 0, y: 140, width: 200, height: 80 },
      ],
      edges: [],
      futureKey: 1,
    },
    null,
    '\t',
  );
}

describe.each([
  ['native', false],
  ['light footprint (vault)', true],
])('free-name rename of canvases and bases — %s space', (_label, light) => {
  let teardownSchema: () => Promise<void>;
  let owner: User;
  let space: string;
  let dir: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    owner = await authStore.createUser({ email: `free-name-${light ? 'l' : 'n'}-${stamp}@test.local`, name: 'Owner', passwordHash: 'x', isAdmin: false });
    space = (await storage.createSpace(`Free Name ${light ? 'Light' : 'Native'} ${stamp}`, null)).slug;
    await authStore.setMembership(space, owner.id, 'editor');
    if (light) await storage.setSpaceScanSettings(space, { lightFootprint: true });
    dir = storage.getSpaceDir(space);
    await write(dir, 'Notes/Plan.md', '# Plan\n\nOpen [[Roadmap.canvas]] and [the board](../Roadmap.canvas) and [spaced](../Roadmap.canvas "t").\n\nAlso [[Tasks.base]].\n');
    await write(dir, 'Roadmap.canvas', canvasWith('Notes/Plan.md'));
    await write(dir, 'Overview.canvas', canvasWith('Roadmap.canvas'));
    await write(dir, 'Tasks.base', BASE_TEXT);
    await propsSidecar.putSidecarText(dir, 'Roadmap.canvas', 'owner: ann\n');
    await propsSidecar.putSidecarText(dir, 'Tasks.base', 'owner: bob\n');
    await storage.scanSpace(space);
  });

  afterAll(async () => {
    await deleteTestSpace(space).catch(() => {});
    await teardownSchema();
  });

  it('renames a canvas to a Cyrillic name with a space: file, sidecar, links and card paths follow; the id stays; one commit', async () => {
    const before = await entryAt(space, 'Roadmap.canvas');
    const overviewBefore = await fs.readFile(path.join(dir, 'Overview.canvas'), 'utf8');
    await collab.renamePageSlug(before.id, '  Мої задачі.canvas ', AUTHOR);

    expect(await exists(path.join(dir, 'Roadmap.canvas'))).toBe(false);
    expect(await exists(path.join(dir, 'Мої задачі.canvas'))).toBe(true);
    const after = await entryAt(space, 'Мої задачі.canvas');
    expect(after.id).toBe(before.id);
    expect(after.title).toBe('Мої задачі');
    // The sidecar moved along.
    expect(await exists(path.join(dir, propsSidecar.sidecarRelPath('Roadmap.canvas')))).toBe(false);
    expect(await propsSidecar.readSidecarText(dir, 'Мої задачі.canvas')).toContain('owner: ann');
    // A note's wikilink and markdown links (escaped, since a space would end the href).
    const note = await fs.readFile(path.join(dir, 'Notes/Plan.md'), 'utf8');
    expect(note).toContain('[[Мої задачі.canvas]]');
    expect(note).toContain('[the board](../Мої%20задачі.canvas)');
    expect(note).toContain('[spaced](../Мої%20задачі.canvas "t")');
    expect(note).toContain('[[Tasks.base]]');
    // Another canvas's file card and the wikilink in its text card; every other byte kept.
    expect(await fs.readFile(path.join(dir, 'Overview.canvas'), 'utf8')).toBe(
      overviewBefore.replace('"file": "Roadmap.canvas"', '"file": "Мої задачі.canvas"').replace('[[Roadmap.canvas]]', '[[Мої задачі.canvas]]'),
    );
    const payload = await buildCanvasPayload(await entryAt(space, 'Overview.canvas'), userViewer(owner));
    expect(payload.files.a).toMatchObject({ status: 'page', path: 'Мої задачі.canvas' });
    // One dedicated commit holds the move and every rewrite.
    expect(await git(dir, 'log', '-1', '--format=%s')).toContain('docs: rename Roadmap.canvas -> Мої задачі.canvas');
    const stat = await git(dir, 'show', '--stat', '--format=', '--name-only', 'HEAD');
    for (const f of ['Notes/Plan.md', 'Overview.canvas']) expect(stat).toContain(f);
  });

  it('renames a base the same way: file, sidecar, wikilink, id', async () => {
    const before = await entryAt(space, 'Tasks.base');
    await collab.renamePageSlug(before.id, 'Мої задачі', AUTHOR);
    expect(await exists(path.join(dir, 'Tasks.base'))).toBe(false);
    expect(await fs.readFile(path.join(dir, 'Мої задачі.base'), 'utf8')).toBe(BASE_TEXT);
    const after = await entryAt(space, 'Мої задачі.base');
    expect(after.id).toBe(before.id);
    expect(after.kind).toBe('base');
    expect(await propsSidecar.readSidecarText(dir, 'Мої задачі.base')).toContain('owner: bob');
    expect(await exists(path.join(dir, propsSidecar.sidecarRelPath('Tasks.base')))).toBe(false);
    expect(await fs.readFile(path.join(dir, 'Notes/Plan.md'), 'utf8')).toContain('[[Мої задачі.base]]');
    expect(await git(dir, 'log', '-1', '--format=%s')).toContain('docs: rename Tasks.base -> Мої задачі.base');
  });

  it('refuses invalid names and a name that is taken, touching nothing', async () => {
    const canvas = await entryAt(space, 'Мої задачі.canvas');
    for (const bad of ['', '   ', '.hidden', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0007b', 'ends.', 'x'.repeat(250), '.canvas']) {
      await expect(collab.renamePageSlug(canvas.id, bad, AUTHOR), JSON.stringify(bad)).rejects.toMatchObject({ status: 400 });
    }
    await write(dir, 'Taken.canvas', '{"nodes":[],"edges":[]}');
    await storage.scanSpace(space);
    await expect(collab.renamePageSlug(canvas.id, 'Taken', AUTHOR)).rejects.toMatchObject({ status: 409 });
    expect(await exists(path.join(dir, 'Мої задачі.canvas'))).toBe(true);
  });

  it('a change of letter case only is a rename, not a collision; the same name is a no-op', async () => {
    const canvas = await entryAt(space, 'Мої задачі.canvas');
    await collab.renamePageSlug(canvas.id, 'мої задачі', AUTHOR);
    expect((await entryAt(space, 'мої задачі.canvas')).id).toBe(canvas.id);
    const names = await fs.readdir(dir);
    expect(names).toContain('мої задачі.canvas');
    expect(names).not.toContain('Мої задачі.canvas');
    const result = await storage.renamePageSlug(canvas.id, 'мої задачі');
    expect(result.moved).toEqual([]);
  });

  it('an ordinary note still takes only a slug', async () => {
    const note = await entryAt(space, 'Notes/Plan.md');
    await expect(collab.renamePageSlug(note.id, 'Мої задачі', AUTHOR)).rejects.toMatchObject({ status: 400 });
  });
});
