/**
 * Tags and properties of EVERY page kind across the page's life (owner report 15.10.2026: a board with
 * `tags: [q3, roadmap]` in its property sidecar was not found by `tag:q3` in Cmd+K).
 *
 * For doc / table / form / board / PDF / Office: set properties through the properties API, then after each
 * step — content save, full rescan, boot reindex of rows indexed by an older parser (meta_version 0, no
 * page_tags), slug rename, move, an edit made outside Folio — the page must still be found by `tag:q3` and
 * `prop:owner=ann`, listed in the space's tags and in `GET /tags/q3/pages`, and carry its tags in
 * get_page_metadata (what the MCP tool returns). The checks run per step and are collected, so one report
 * lists every kind x step that failed.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '../shared/contracts.js';
import { userViewer } from './accessSql.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as git from './git.js';
import { getPageMetadata, listSpaceTags } from './indexV2/read.js';
import { registerPropertiesRoutes } from './propertiesRoutes.js';
import { searchPages } from './search.js';
import * as storage from './storage.js';
import { listTagPages } from './tags.js';

git.__allowLocalRepoPathsForTests();
const execFileAsync = promisify(execFile);
const RUN = `taglife-${Date.now().toString(36)}`;

/** A bare repo seeded with `files` — the "remote" a space is created from. */
async function seededBareRepo(files: Record<string, string>): Promise<{ bare: string; cleanup: string[] }> {
  const bare = path.join(os.tmpdir(), `folio-${RUN}-${Math.random().toString(36).slice(2, 8)}.git`);
  const seed = `${bare}-seed`;
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
  return { bare, cleanup: [bare, seed] };
}

/** The three ways a space keeps its pages: a Folio-owned repo, a `docs/` folder of a product repo, a repo of notes created light (no ids in files). */
const SPACES = [
  { label: 'plain space', create: async (name: string, by: string) => (await storage.createSpace(name, by)).slug, rootPath: '', ids: true },
  {
    label: 'rootPath docs (docs-as-code)',
    create: (name: string, by: string, tmp: string[]) => fromRepo(name, by, tmp, { 'README.md': '# Product\n', 'package.json': '{"name":"product"}\n' }, 'docs'),
    rootPath: 'docs',
    ids: false,
  },
  {
    label: 'light footprint from a repo',
    create: (name: string, by: string, tmp: string[]) => fromRepo(name, by, tmp, { 'README.md': '# Notes\n', 'ideas.md': '# Ideas\n\nSome text.\n' }, ''),
    rootPath: '',
    ids: false,
  },
];

async function fromRepo(name: string, by: string, tmp: string[], files: Record<string, string>, rootPath: string): Promise<string> {
  const { bare, cleanup } = await seededBareRepo(files);
  tmp.push(...cleanup);
  const info = await storage.createSpaceFromRepo({ name, repoUrl: bare, branch: 'main', rootPath, createdBy: by });
  return info.slug;
}

type Kind = 'doc' | 'table' | 'form' | 'board' | 'pdf' | 'office';
const KINDS: Kind[] = ['doc', 'table', 'form', 'board', 'pdf', 'office'];
const STEPS = ['props saved', 'content saved', 'rescan', 'boot reindex (stale)', 'renamed', 'moved', 'edited outside'] as const;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(async (scope) => {
    scope.addHook('onRequest', session.requireSession);
    registerPropertiesRoutes(scope);
  });
  await app.ready();
  return app;
}

describe.each(SPACES)('tags of every page kind survive the page lifecycle, $label (real PG + git)', (variant) => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let editor: User;
  let slug: string;
  let dir: string;
  let cookie: string;
  const failures: string[] = [];
  const tmpDirs: string[] = [];
  const table: Record<string, Record<string, string>> = {};

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    app = await buildApp();
    const stamp = Date.now();
    const owner = await authStore.createUser({ email: `tl-owner-${stamp}@example.com`, name: 'Owner', passwordHash: 'x', isAdmin: true });
    editor = await authStore.createUser({ email: `tl-editor-${stamp}@example.com`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    slug = await variant.create(`TagLifecycle ${stamp}`, owner.id, tmpDirs);
    dir = storage.getSpaceDir(slug);
    await authStore.setMembership(slug, owner.id, 'admin');
    await authStore.setMembership(slug, editor.id, 'editor');
    cookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(editor.id)).token}`;
    await fs.mkdir(path.join(dir, 'moved-here'), { recursive: true });
    expect(storage.getRootPath(slug)).toBe(variant.rootPath);
  });
  afterAll(async () => {
    await app.close();
    await deleteTestSpace(slug);
    await teardownSchema();
    for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
  });

  const put = async (id: string, properties: Record<string, unknown>) => {
    const res = await app.inject({ method: 'PUT', url: `/api/pages/${id}/properties`, headers: { cookie }, payload: { properties } });
    expect(res.statusCode, res.body).toBe(200);
  };
  const viewer = () => userViewer(editor);

  /** Every way the page must be findable by its tag; the problems of this step. */
  async function problems(id: string, extraTag?: string): Promise<string[]> {
    const out: string[] = [];
    const ids = async (q: string) => (await searchPages(q, { userId: editor.id, space: slug })).map((h) => h.id);
    if (!(await ids('tag:q3')).includes(id)) out.push('search tag:q3');
    if (!(await ids('tag:roadmap')).includes(id)) out.push('search tag:roadmap');
    if (!(await ids('prop:owner=ann')).includes(id)) out.push('search prop:owner=ann');
    if (extraTag && !(await ids(`tag:${extraTag}`)).includes(id)) out.push(`search tag:${extraTag}`);
    const hit = (await searchPages('tag:q3', { userId: editor.id, space: slug })).find((h) => h.id === id);
    if (hit && !hit.kind) out.push('search hit has no kind');
    const tags = await listSpaceTags(slug, viewer());
    if (!tags.some((t) => t.tag === 'q3')) out.push('space tags list lacks q3');
    const listed = await listTagPages(slug, 'q3', viewer(), { limit: 100, offset: 0 });
    if (!listed.pages.some((p) => p.id === id)) out.push('tag pages lacks the page');
    const entry = await storage.getEntry(id);
    if (!entry) return [...out, 'page vanished'];
    const meta = await getPageMetadata(entry, viewer());
    const metaTags = meta.tags.map((t) => t.tag);
    if (!metaTags.includes('q3') || !metaTags.includes('roadmap')) out.push(`get_page_metadata tags ${JSON.stringify(metaTags)}`);
    if (meta.properties.owner !== 'ann') out.push('get_page_metadata properties');
    return out;
  }

  async function create(kind: Kind): Promise<string> {
    const title = `Life ${kind}`;
    if (kind === 'doc' || kind === 'table' || kind === 'board') return (await storage.createPage({ space: slug, parentPath: '', title, kind })).id;
    if (kind === 'form') {
      const t = await storage.createPage({ space: slug, parentPath: '', title: 'Life form source', kind: 'table' });
      return (await storage.createFormFromTable(t.id)).id;
    }
    const file = kind === 'pdf' ? 'life.pdf' : 'life.docx';
    await fs.writeFile(path.join(dir, file), kind === 'pdf' ? '%PDF-1.4\n%%EOF\n' : 'PK\u0003\u0004 docx');
    await storage.scanSpace(slug);
    return (await storage.getEntryIdByExactPath(slug, file))!;
  }

  async function saveContent(kind: Kind, id: string): Promise<void> {
    if (kind === 'doc') await storage.writeDocBody(id, '# Life doc\n\nEdited body #bodytag\n');
    else if (kind === 'table') await storage.writeTableDoc(id, await storage.readFreshTableDoc(id));
    else if (kind === 'form') {
      const doc = await storage.readFreshFormDoc(id);
      await storage.writeFormDoc(id, { ...doc, title: 'Life form edited', description: 'Tell us' });
    } else if (kind === 'board') await storage.writeBoardSvg(id, (await storage.readBoardSvg(id)).replace('</svg>', '<!-- edited --></svg>'));
    else await storage.writeFilePageBytes(id, Buffer.from(kind === 'pdf' ? '%PDF-1.4\n% edited\n%%EOF\n' : 'PK\u0003\u0004 docx edited'));
  }

  async function editOutside(kind: Kind, id: string): Promise<void> {
    const entry = (await storage.getEntry(id))!;
    if (kind === 'board' || kind === 'pdf' || kind === 'office') {
      const sidecar = path.join(dir, '.folio', `${entry.relPath}.props.yaml`);
      const text = await fs.readFile(sidecar, 'utf8');
      await fs.writeFile(sidecar, text.replace('- roadmap\n', '- roadmap\n  - ext\n'), 'utf8');
    } else {
      const raw = await fs.readFile(entry.absPath, 'utf8');
      const next = raw.replace('  - roadmap\n', '  - roadmap\n  - ext\n');
      expect(next, `${kind}: own tags written as a block list`).not.toBe(raw);
      await fs.writeFile(entry.absPath, next, 'utf8');
    }
    await storage.scanSpace(slug);
  }

  for (const kind of KINDS) {
    it(`${kind}`, async () => {
      const id = await create(kind);
      expect(id).toBeTruthy();
      const results: string[] = [];
      const step = async (name: (typeof STEPS)[number], run: () => Promise<void>, extraTag?: string) => {
        try {
          await run();
          const p = await problems(id, extraTag);
          results.push(p.length === 0 ? 'ok' : `FAIL (${p.join('; ')})`);
          for (const m of p) failures.push(`${kind} / ${name}: ${m}`);
        } catch (err) {
          results.push(`ERROR ${(err as Error).message}`);
          failures.push(`${kind} / ${name}: threw ${(err as Error).message}`);
        }
      };

      await step('props saved', async () => {
        if (kind === 'doc') await storage.writeDocBody(id, '# Life doc\n\nBody #bodytag\n');
        await put(id, { owner: 'ann', tags: ['q3', 'roadmap'] });
      });
      await step('content saved', () => saveContent(kind, id));
      await step('rescan', async () => {
        await storage.scanSpace(slug);
      });
      await step('boot reindex (stale)', async () => {
        // What a row indexed by an older parser looks like: no page_tags, no properties, meta_version 0.
        await query('DELETE FROM page_tags WHERE page_id = $1', [id]);
        await query(`UPDATE pages_index SET frontmatter = '{}'::jsonb, meta_version = 0 WHERE id = $1`, [id]);
        await storage.scanSpaceForBoot(slug);
      });
      await step('renamed', async () => {
        await storage.renamePageSlug(id, `renamed-${kind}`);
      });
      await step('moved', async () => {
        await storage.movePage(id, 'moved-here');
      });
      await step(
        'edited outside',
        async () => {
          await editOutside(kind, id);
        },
        'ext',
      );
      table[kind] = Object.fromEntries(STEPS.map((s, i) => [s, results[i] ?? 'skipped']));
    });
  }

  it('keeps the sidecars under the content root and writes no id into a file of a light space', async () => {
    const board = (await storage.getEntryIdByExactPath(slug, 'moved-here/renamed-board.excalidraw.svg'))!;
    expect(board).toBeTruthy();
    await expect(fs.stat(path.join(dir, '.folio/moved-here/renamed-board.excalidraw.svg.props.yaml'))).resolves.toBeTruthy();
    if (!variant.ids) {
      const doc = await fs.readFile(path.join(dir, 'moved-here/renamed-doc.md'), 'utf8');
      expect(doc).not.toMatch(/^id:/m);
    }
  });

  it('reports the kind x step table', () => {
    // eslint-disable-next-line no-console
    console.log(`[tag lifecycle: ${variant.label}]\n${KINDS.map((k) => `${k.padEnd(7)} ${STEPS.map((s) => `${s}: ${table[k]?.[s] ?? '?'}`).join(' | ')}`).join('\n')}`);
    expect(failures).toEqual([]);
  });
});
