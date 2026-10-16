/**
 * The shared page timer end to end — real PG (isolated schema), a real HTTP
 * server with the real `/events` socket and real `ws` clients carrying a
 * session cookie: access rules, the REST contract, and WHO receives the frame.
 */
import * as http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import * as WS from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import * as notificationSocket from './notifications/socket.js';
import * as pageAccess from './pageAccess.js';
import { __resetTimersForTests } from './pageTimer.js';
import { registerPageTimerRoutes } from './pageTimerRoutes.js';
import { __resetRateLimitsForTests } from './rateLimit.js';
import * as storage from './storage.js';
import type { PageTimerResponse, User } from '../shared/contracts.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const MIN = 60_000;

interface TimerFrame {
  type: 'timer';
  key: string;
  timer: { durationMs: number; endsAt: number | null; pausedRemainingMs: number | null; startedByName: string; updatedAt: number } | null;
  rev: number;
  serverNow: number;
}

interface EventsClient {
  frames: TimerFrame[];
  raw: string[];
  waitFor(count: number, timeoutMs?: number): Promise<void>;
  close(): void;
}

function openEvents(port: number, token: string): Promise<EventsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WS.WebSocket(`ws://127.0.0.1:${port}/events`, { headers: { cookie: `${session.SESSION_COOKIE_NAME}=${token}` } });
    const frames: TimerFrame[] = [];
    const raw: string[] = [];
    const client: EventsClient = {
      frames,
      raw,
      waitFor: async (count, timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (frames.length >= count) return;
          await sleep(10);
        }
        throw new Error(`expected ${count} timer frame(s) within ${timeoutMs} ms, got ${frames.length}`);
      },
      close: () => ws.close(),
    };
    ws.on('message', (data) => {
      const text = String(data);
      raw.push(text);
      const parsed = JSON.parse(text) as { type: string };
      if (parsed.type === 'timer') frames.push(parsed as TimerFrame);
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
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: err instanceof Error ? err.message : 'bad request' });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    registerPageTimerRoutes(protectedScope);
  });
  await app.ready();
  return app;
}

describe('shared page timer over REST + /events (real PG, real sockets)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let server: http.Server;
  let port: number;

  let editorA: User;
  let editorC: User; // editor of the space, but NOT granted the restricted page
  let viewerB: User;
  let stranger: User;
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let tokenStranger: string;
  let readPat: string;
  let writePat: string;
  let slug: string;
  let pageId: string;
  let restrictedId: string;
  const clients: EventsClient[] = [];

  const cookie = (token: string) => ({ [session.SESSION_COOKIE_NAME]: token });
  const connect = async (token: string): Promise<EventsClient> => {
    const client = await openEvents(port, token);
    clients.push(client);
    return client;
  };
  const post = (url: string, token: string, payload: unknown) => app.inject({ method: 'POST', url, cookies: cookie(token), payload: payload as object });
  const get = (url: string, token: string) => app.inject({ method: 'GET', url, cookies: cookie(token) });

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    editorA = await authStore.createUser({ email: `pt-a-${stamp}@t.local`, name: 'Alice Editor', passwordHash: 'x', isAdmin: false });
    editorC = await authStore.createUser({ email: `pt-c-${stamp}@t.local`, name: 'Carl Editor', passwordHash: 'x', isAdmin: false });
    viewerB = await authStore.createUser({ email: `pt-b-${stamp}@t.local`, name: 'Bob Viewer', passwordHash: 'x', isAdmin: false });
    stranger = await authStore.createUser({ email: `pt-n-${stamp}@t.local`, name: 'Nina Stranger', passwordHash: 'x', isAdmin: false });
    tokenA = (await authStore.createSession(editorA.id)).token;
    tokenB = (await authStore.createSession(viewerB.id)).token;
    tokenC = (await authStore.createSession(editorC.id)).token;
    tokenStranger = (await authStore.createSession(stranger.id)).token;
    readPat = (await authStore.createApiToken(editorA.id, 'read only', ['read'])).token;
    writePat = (await authStore.createApiToken(editorA.id, 'read write', ['read', 'write'])).token;

    const info = await storage.createSpace(`Page Timer ${stamp}`, editorA.id);
    slug = info.slug;
    await authStore.setMembership(slug, editorA.id, 'editor');
    await authStore.setMembership(slug, editorC.id, 'editor');
    await authStore.setMembership(slug, viewerB.id, 'viewer');
    pageId = (await storage.createPage({ space: slug, parentPath: '', title: 'Standup Notes', kind: 'doc' })).id;
    const secret = await storage.createPage({ space: slug, parentPath: '', title: 'Salary Review Draft', kind: 'doc' });
    restrictedId = secret.id;
    await pageAccess.setAccess(editorA, await storage.requireEntry(secret.id), 'restricted', []);

    app = await buildApp();
    server = http.createServer();
    notificationSocket.attachToServer(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  beforeEach(() => {
    __resetTimersForTests();
    __resetRateLimitsForTests();
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    await deleteTestSpace(slug);
    await teardownSchema();
  });

  it('GET with no timer answers null; the editor may control, the viewer may only look', async () => {
    const asEditor = (await get(`/api/pages/${pageId}/timer`, tokenA)).json() as PageTimerResponse;
    expect(asEditor).toMatchObject({ timer: null, canControl: true });
    expect(asEditor.serverNow).toBeGreaterThan(Date.now() - 5000);
    const asViewer = (await get(`/api/pages/${pageId}/timer`, tokenB)).json() as PageTimerResponse;
    expect(asViewer).toMatchObject({ timer: null, canControl: false });
  });

  it('start -> the answer carries the end moment in server time; a late joiner reads the same state', async () => {
    const before = Date.now();
    const started = await post(`/api/pages/${pageId}/timer`, tokenA, { action: 'start', durationMs: 5 * MIN });
    expect(started.statusCode).toBe(200);
    const body = started.json() as PageTimerResponse;
    expect(body.canControl).toBe(true);
    expect(body.timer).toMatchObject({ durationMs: 5 * MIN, pausedRemainingMs: null, startedByName: 'Alice Editor' });
    expect(body.timer!.endsAt!).toBeGreaterThanOrEqual(before + 5 * MIN);
    expect(body.timer!.endsAt!).toBeLessThanOrEqual(Date.now() + 5 * MIN);

    const late = (await get(`/api/pages/${pageId}/timer`, tokenB)).json() as PageTimerResponse;
    expect(late.timer).toEqual(body.timer);
    expect(late.canControl).toBe(false);
    expect(late.rev).toBeGreaterThanOrEqual(body.rev);
  });

  it('pause / resume / add / reset walk the state machine over HTTP', async () => {
    const url = `/api/pages/${pageId}/timer`;
    await post(url, tokenA, { action: 'start', durationMs: 5 * MIN });
    const paused = (await post(url, tokenA, { action: 'pause' })).json() as PageTimerResponse;
    expect(paused.timer!.endsAt).toBeNull();
    expect(paused.timer!.pausedRemainingMs).toBeGreaterThan(4 * MIN);
    const topped = (await post(url, tokenA, { action: 'add', ms: MIN })).json() as PageTimerResponse;
    expect(topped.timer!.pausedRemainingMs).toBeGreaterThan(5 * MIN);
    const resumed = (await post(url, tokenA, { action: 'resume' })).json() as PageTimerResponse;
    expect(resumed.timer!.endsAt).toBeGreaterThan(Date.now() + 5 * MIN);
    const reset = (await post(url, tokenA, { action: 'reset' })).json() as PageTimerResponse;
    expect(reset.timer).toBeNull();
    expect(((await get(url, tokenA)).json() as PageTimerResponse).timer).toBeNull();
  });

  it('validates the body: unknown action, zero, negative, fractional and over-the-cap durations are 400', async () => {
    const url = `/api/pages/${pageId}/timer`;
    for (const payload of [{ action: 'explode' }, { action: 'start' }, { action: 'start', durationMs: 0 }, { action: 'start', durationMs: -5 }, { action: 'start', durationMs: 1500.5 }, { action: 'start', durationMs: 181 * MIN }, { action: 'add', ms: 'x' }]) {
      expect((await post(url, tokenA, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await post(url, tokenA, { action: 'start', durationMs: 180 * MIN })).statusCode).toBe(200);
    expect((await post(url, tokenA, { action: 'add', ms: MIN })).statusCode).toBe(200);
    __resetTimersForTests();
    expect((await post(url, tokenA, { action: 'add', ms: MIN })).statusCode).toBe(409);
  });

  it('a viewer cannot change the timer; a stranger cannot even read it; an unknown page is 404', async () => {
    const url = `/api/pages/${pageId}/timer`;
    expect((await post(url, tokenB, { action: 'start', durationMs: MIN })).statusCode).toBe(403);
    expect((await get(url, tokenStranger)).statusCode).toBe(403);
    expect((await post(url, tokenStranger, { action: 'start', durationMs: MIN })).statusCode).toBe(403);
    expect((await get('/api/pages/does-not-exist/timer', tokenA)).statusCode).toBe(404);
    expect(((await get(url, tokenA)).json() as PageTimerResponse).timer).toBeNull();
  });

  it('page access applies: an editor of the space who is not granted a restricted page can neither see nor start its timer', async () => {
    const url = `/api/pages/${restrictedId}/timer`;
    expect((await get(url, tokenC)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await post(url, tokenC, { action: 'start', durationMs: MIN })).statusCode).toBeGreaterThanOrEqual(403);
    expect((await post(url, tokenA, { action: 'start', durationMs: MIN })).statusCode).toBe(200);
  });

  it('a read-scope token may look but not change; a write-scope token may do both', async () => {
    const url = `/api/pages/${pageId}/timer`;
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    const read = await app.inject({ method: 'GET', url, headers: bearer(readPat) });
    expect(read.statusCode).toBe(200);
    expect((read.json() as PageTimerResponse).canControl).toBe(false);
    expect((await app.inject({ method: 'POST', url, headers: bearer(readPat), payload: { action: 'start', durationMs: MIN } })).statusCode).toBe(403);
    const write = await app.inject({ method: 'POST', url, headers: bearer(writePat), payload: { action: 'start', durationMs: MIN } });
    expect(write.statusCode).toBe(200);
  });

  it('a change reaches every reader of the page with the new state, and nobody else; an idempotent repeat sends nothing', async () => {
    const a = await connect(tokenA);
    const b = await connect(tokenB);
    const n = await connect(tokenStranger);
    const url = `/api/pages/${pageId}/timer`;

    const started = (await post(url, tokenA, { action: 'start', durationMs: 3 * MIN })).json() as PageTimerResponse;
    await Promise.all([a.waitFor(1), b.waitFor(1)]);
    for (const frame of [a.frames[0], b.frames[0]]) {
      expect(frame).toEqual({ type: 'timer', key: pageId, timer: started.timer, rev: started.rev, serverNow: expect.any(Number) });
    }

    // «Pause» twice: the second is a no-op for everybody.
    await post(url, tokenA, { action: 'pause' });
    await post(url, tokenA, { action: 'pause' });
    await Promise.all([a.waitFor(2), b.waitFor(2)]);
    await sleep(200);
    expect(b.frames).toHaveLength(2);
    expect(b.frames[1].timer).toMatchObject({ endsAt: null });
    expect(b.frames[1].rev).toBeGreaterThan(b.frames[0].rev);

    await post(url, tokenA, { action: 'reset' });
    await b.waitFor(3);
    expect(b.frames[2]).toMatchObject({ key: pageId, timer: null });

    expect(n.frames).toEqual([]);
    expect(n.raw.join('\n')).not.toContain(pageId);
  });

  it('the timer of a restricted page reaches only those who may open it', async () => {
    const a = await connect(tokenA);
    const c = await connect(tokenC); // editor of the space, not granted this page
    const b = await connect(tokenB);
    await post(`/api/pages/${restrictedId}/timer`, tokenA, { action: 'start', durationMs: MIN });
    await a.waitFor(1);
    await sleep(250);
    expect(a.frames[0].key).toBe(restrictedId);
    expect(c.frames).toEqual([]);
    expect(b.frames).toEqual([]);
    expect(c.raw.join('\n')).not.toContain(restrictedId);
  });

  it('a revoked session gets nothing', async () => {
    const extra = (await authStore.createSession(viewerB.id)).token;
    const live = await connect(extra);
    const other = await connect(tokenB);
    await authStore.destroyAllSessionsForUser(viewerB.id);
    await post(`/api/pages/${pageId}/timer`, tokenA, { action: 'start', durationMs: MIN });
    await sleep(300);
    expect(live.frames).toEqual([]);
    expect(other.frames).toEqual([]);
    tokenB = (await authStore.createSession(viewerB.id)).token; // the rest of the file keeps using B
  });

  it('a folder listing has its own, space-wide timer under /api/spaces/:space/timer, with the same rules and fan-out', async () => {
    const a = await connect(tokenA);
    const b = await connect(tokenB);
    const n = await connect(tokenStranger);
    const url = `/api/spaces/${slug}/timer`;
    expect((await get(url, tokenStranger)).statusCode).toBe(403);
    expect((await post(url, tokenB, { action: 'start', durationMs: MIN })).statusCode).toBe(403);
    expect((await get(url, tokenB)).json()).toMatchObject({ timer: null, canControl: false });

    const started = (await post(url, tokenA, { action: 'start', durationMs: 10 * MIN })).json() as PageTimerResponse;
    expect(started).toMatchObject({ canControl: true, timer: { durationMs: 10 * MIN } });
    await Promise.all([a.waitFor(1), b.waitFor(1)]);
    expect(b.frames[0].key).toBe(`space:${slug}`);
    expect(n.frames).toEqual([]);
    // A page's timer and the space's are separate.
    expect(((await get(`/api/pages/${pageId}/timer`, tokenA)).json() as PageTimerResponse).timer).toBeNull();
    expect(((await get(url, tokenB)).json() as PageTimerResponse).timer).toEqual(started.timer);
  });

  it('rate-limits a script that hammers the timer', async () => {
    const url = `/api/pages/${pageId}/timer`;
    let last = 200;
    for (let i = 0; i < 62; i++) last = (await post(url, tokenA, { action: i % 2 ? 'pause' : 'resume' })).statusCode;
    expect(last).toBe(429);
  });
});
