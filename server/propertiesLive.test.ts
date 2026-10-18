/**
 * "The properties of this page changed" live signal (16.10.2026) — real PG
 * (isolated schema, migration 049's trigger), real files, the real `/events`
 * socket and real `ws` clients with a session cookie (the same harness as
 * treeSignal.test.ts).
 *
 * What these tests pin down:
 *  - every properties write path produces a `page-properties` frame for the
 *    page's readers: the properties PUT for a document, a data table (its own
 *    front matter) and a board (sidecar); MCP set_page_properties; a tag
 *    rename; the page chrome's icon picker; a git sync (scanSpace) that brings
 *    a changed block or sidecar;
 *  - the frame is `{ type, space, pageId, etag }`, `etag` equal to what the GET
 *    answers now — never a value;
 *  - a reader of the space who cannot open a restricted page gets nothing about
 *    it, a stranger gets nothing at all;
 *  - a body-only edit stays silent; a burst over MAX_PAGES_PER_FLUSH becomes one
 *    space-wide frame without a page id.
 */
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as WS from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { buildFolioMcpServer } from './mcp.js';
import * as notificationSocket from './notifications/socket.js';
import * as pageAccess from './pageAccess.js';
import { readPageProperties } from './properties.js';
import { MAX_PAGES_PER_FLUSH } from './propertiesSignal.js';
import { registerPropertiesRoutes } from './propertiesRoutes.js';
import * as storage from './storage.js';
import { renameTag } from './tags.js';
import { startTreeSignal, stopTreeSignal } from './treeSignal.js';
import type { User } from '../shared/contracts.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const QUIET_MS = 80;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface PropsFrame {
  type: 'page-properties';
  space: string;
  pageId?: string;
  etag?: string | null;
}

interface EventsClient {
  frames: unknown[];
  raw: string[];
  props(space: string, pageId?: string): PropsFrame[];
  waitFor(space: string, pageId?: string, timeoutMs?: number): Promise<PropsFrame>;
  clear(): void;
  close(): void;
}

function openEvents(port: number, token: string): Promise<EventsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WS.WebSocket(`ws://127.0.0.1:${port}/events`, { headers: { cookie: `${session.SESSION_COOKIE_NAME}=${token}` } });
    const frames: unknown[] = [];
    const raw: string[] = [];
    const client: EventsClient = {
      frames,
      raw,
      props: (space, pageId) =>
        frames.filter(
          (f): f is PropsFrame => (f as PropsFrame).type === 'page-properties' && (f as PropsFrame).space === space && (pageId === undefined || (f as PropsFrame).pageId === pageId),
        ),
      waitFor: async (space, pageId, timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const got = client.props(space, pageId);
          if (got.length > 0) return got[got.length - 1];
          await sleep(10);
        }
        throw new Error(`no page-properties frame for ${space}/${pageId ?? '*'} within ${timeoutMs} ms`);
      },
      clear: () => {
        frames.length = 0;
        raw.length = 0;
      },
      close: () => ws.close(),
    };
    ws.on('message', (data) => {
      const text = String(data);
      const parsed = JSON.parse(text) as { type: string };
      if (parsed.type === 'ping') return;
      raw.push(text);
      frames.push(parsed);
    });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
  });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    registerPropertiesRoutes(protectedScope);
  });
  await app.ready();
  return app;
}

describe('page-properties live signal (real PG + /events)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let server: http.Server;
  let port: number;
  let dana: User; // editor — makes the changes
  let marcus: User; // viewer — has the page open
  let stranger: User;
  let tokenDana: string;
  let tokenMarcus: string;
  let tokenStranger: string;
  const clients: EventsClient[] = [];
  const slugs: string[] = [];

  async function connect(token: string): Promise<EventsClient> {
    const client = await openEvents(port, token);
    clients.push(client);
    return client;
  }

  async function makeSpace(label: string): Promise<string> {
    const info = await storage.createSpace(`Props Live ${label} ${Date.now()}`, dana.id);
    slugs.push(info.slug);
    await authStore.setMembership(info.slug, dana.id, 'editor');
    await authStore.setMembership(info.slug, marcus.id, 'viewer');
    return info.slug;
  }

  /** Waits out the creation noise (order of siblings, first indexing), then forgets it. */
  async function settle(observers: EventsClient[]): Promise<void> {
    await sleep(QUIET_MS * 6);
    for (const observer of observers) observer.clear();
  }

  const put = (id: string, properties: Record<string, unknown>, token = tokenDana) =>
    app.inject({ method: 'PUT', url: `/api/pages/${id}/properties`, cookies: { [session.SESSION_COOKIE_NAME]: token }, payload: { properties } });

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    dana = await authStore.createUser({ email: `pl-dana-${stamp}@t.local`, name: 'Dana Editor', passwordHash: 'x', isAdmin: false });
    marcus = await authStore.createUser({ email: `pl-marcus-${stamp}@t.local`, name: 'Marcus Viewer', passwordHash: 'x', isAdmin: false });
    stranger = await authStore.createUser({ email: `pl-n-${stamp}@t.local`, name: 'Nina Stranger', passwordHash: 'x', isAdmin: false });
    tokenDana = (await authStore.createSession(dana.id)).token;
    tokenMarcus = (await authStore.createSession(marcus.id)).token;
    tokenStranger = (await authStore.createSession(stranger.id)).token;
    app = await buildApp();
    server = http.createServer();
    notificationSocket.attachToServer(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
    await startTreeSignal({ quietMs: 200, maxWaitMs: 800, properties: { quietMs: QUIET_MS, busyQuietMs: QUIET_MS * 2, maxWaitMs: 600, minGapMs: 200, maxGapMs: 800, calmMs: 2000 } });
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  afterAll(async () => {
    await stopTreeSignal();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    for (const slug of slugs) await deleteTestSpace(slug);
    await teardownSchema();
  });

  it('a document PUT by Dana reaches Marcus as {pageId, etag} — the GET\'s etag, no values — and a stranger as nothing', async () => {
    const slug = await makeSpace('doc');
    const page = await storage.createPage({ space: slug, parentPath: '', title: 'Launch plan', kind: 'doc' });
    const d = await connect(tokenDana);
    const m = await connect(tokenMarcus);
    const n = await connect(tokenStranger);
    await settle([d, m, n]);

    const res = await put(page.id, { priority: 'secret-high' });
    expect(res.statusCode).toBe(200);
    const putEtag = (res.json() as { etag: string }).etag;

    const frame = await m.waitFor(slug, page.id);
    expect(frame).toEqual({ type: 'page-properties', space: slug, pageId: page.id, etag: putEtag });
    expect(putEtag).toBe((await readPageProperties(await storage.requireEntry(page.id), false)).etag);
    // The writer's own tab gets the same frame: it holds that etag already, so it does not refetch.
    expect((await d.waitFor(slug, page.id)).etag).toBe(putEtag);
    await sleep(150);
    expect(m.raw.join('\n')).not.toContain('secret-high');
    expect(n.frames).toEqual([]);
  });

  it('a restricted page: its own readers hear about it, a reader of the space who cannot open it gets nothing', async () => {
    const slug = await makeSpace('restricted');
    const page = await storage.createPage({ space: slug, parentPath: '', title: 'Salary review', kind: 'doc' });
    await pageAccess.setAccess(dana, await storage.requireEntry(page.id), 'restricted', []);
    const d = await connect(tokenDana);
    const m = await connect(tokenMarcus);
    await settle([d, m]);

    expect((await put(page.id, { band: 'b4' })).statusCode).toBe(200);
    await d.waitFor(slug, page.id);
    await sleep(QUIET_MS * 4);
    expect(m.props(slug)).toEqual([]);
    expect(m.raw.join('\n')).not.toContain(page.id);
    expect((await pageAccess.readablePageIds(marcus.id, slug, false)).has(page.id)).toBe(false);
  });

  it('a data table (its own front matter) and a board (sidecar) PUT produce the frame', async () => {
    const slug = await makeSpace('nondoc');
    const table = await storage.createPage({ space: slug, parentPath: '', title: 'Requests', kind: 'table' });
    const board = await storage.createPage({ space: slug, parentPath: '', title: 'Flow', kind: 'board' });
    const m = await connect(tokenMarcus);
    await settle([m]);

    expect((await put(table.id, { owner: 'ops' })).statusCode).toBe(200);
    const tableFrame = await m.waitFor(slug, table.id);
    expect(tableFrame.etag).toBe((await readPageProperties(await storage.requireEntry(table.id), false)).etag);

    expect((await put(board.id, { stage: 'review' })).statusCode).toBe(200);
    const boardFrame = await m.waitFor(slug, board.id);
    expect(boardFrame.etag).toBe((await readPageProperties(await storage.requireEntry(board.id), false)).etag);
  });

  it('MCP set_page_properties, a tag rename and the icon picker each produce the frame', async () => {
    const slug = await makeSpace('paths');
    const page = await storage.createPage({ space: slug, parentPath: '', title: 'Many paths', kind: 'doc' });
    const m = await connect(tokenMarcus);
    await settle([m]);

    const mcp = buildFolioMcpServer({ user: dana, scopes: ['read', 'write'], tokenId: 'props-live-token' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'props-live-test', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: 'set_page_properties', arguments: { id: page.id, properties: { tags: ['alpha'], reviewer: 'kim' }, merge: true } });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
    const afterMcp = await m.waitFor(slug, page.id);
    await settle([m]);

    await renameTag({ space: slug, from: 'alpha', to: 'beta', user: dana, actor: { name: dana.name, email: dana.email } });
    const afterRename = await m.waitFor(slug, page.id);
    expect(afterRename.etag).not.toBe(afterMcp.etag);
    await settle([m]);

    // The page chrome's icon picker writes `icon:` into the block (and the row's icon column).
    const entry = await storage.requireEntry(page.id);
    await storage.setDocIconCover(entry, '🚀', undefined, await storage.readFreshDocBody(page.id));
    const afterIcon = await m.waitFor(slug, page.id);
    expect(afterIcon.etag).toBe((await readPageProperties(await storage.requireEntry(page.id), false)).etag);
  });

  it('a git sync (scanSpace) that brings a changed block or sidecar produces the frame; a body-only edit stays silent', async () => {
    const slug = await makeSpace('sync');
    const page = await storage.createPage({ space: slug, parentPath: '', title: 'Synced', kind: 'doc' });
    const board = await storage.createPage({ space: slug, parentPath: '', title: 'Synced board', kind: 'board' });
    expect((await put(board.id, { stage: 'draft' })).statusCode).toBe(200);
    const m = await connect(tokenMarcus);
    await settle([m]);

    // Body only: nothing.
    await storage.patchEntryContent(await storage.requireEntry(page.id), '# Synced\n\nOnly the body changed.\n');
    await sleep(QUIET_MS * 5);
    expect(m.props(slug)).toEqual([]);

    // What a pull does: the file changes on disk, the scan picks it up.
    const entry = await storage.requireEntry(page.id);
    const raw = await fs.readFile(entry.absPath, 'utf8');
    await fs.writeFile(entry.absPath, raw.replace(/^---\n/, '---\nfrom_git: yes\n'), 'utf8');
    await storage.scanSpace(slug);
    await m.waitFor(slug, page.id);

    const boardEntry = await storage.requireEntry(board.id);
    const sidecar = path.join(storage.getSpaceDir(slug), '.folio', `${boardEntry.relPath}.props.yaml`);
    await fs.writeFile(sidecar, 'stage: shipped\n', 'utf8');
    await storage.scanSpace(slug);
    await m.waitFor(slug, board.id);
  });

  it(`a burst over ${MAX_PAGES_PER_FLUSH} pages becomes one space-wide frame without a page id`, async () => {
    const slug = await makeSpace('burst');
    const count = MAX_PAGES_PER_FLUSH + 5;
    for (let i = 0; i < count; i++) {
      await fs.writeFile(path.join(storage.getSpaceDir(slug), `burst-${i}.md`), `---\nn: ${i}\n---\n# Burst ${i}\n`, 'utf8');
    }
    await storage.scanSpace(slug);
    const m = await connect(tokenMarcus);
    await settle([m]);

    for (let i = 0; i < count; i++) {
      const file = path.join(storage.getSpaceDir(slug), `burst-${i}.md`);
      const raw = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, raw.replace(`n: ${i}`, `n: ${i + 100}`), 'utf8');
    }
    await storage.scanSpace(slug);
    const frame = await m.waitFor(slug);
    await sleep(QUIET_MS * 4);
    expect(frame).toEqual({ type: 'page-properties', space: slug });
    expect(m.props(slug).filter((f) => f.pageId !== undefined)).toEqual([]);
  });
});
