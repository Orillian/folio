/**
 * "Ask Folio AI" on a public site (publicRoutes.ts): an anonymous visitor asks
 * questions about ONE published space, as the built-in "Public visitor" system
 * user. The two things that must hold: the visitor never reads anything outside
 * the public page set of that one space, and never burns the admin's key
 * without limits.
 *
 * Real PostgreSQL (per-file schema), the real routes via Fastify inject, the
 * real RunManager, workspace and in-process MCP server, real encryption of the
 * shared key. Only the Cursor SDK is mocked: `Agent.create/resume` record the
 * key they were given and `send` records the prompt.
 *
 * Fixture:
 *   pub      public, assistant ON, space key `space-key-pub`
 *            guide.md (open, "quokka"), secret.md (RESTRICTED, "quokka"),
 *            .agent/rules.md (rules, "quokka"), _templates/weekly.md ("quokka")
 *   other    public, assistant ON, no key; page.md ("quokka")
 *   quiet    public, assistant OFF
 *   priv     private (assistant flag ON in the DB — still invisible)
 *   inst     instance-visible
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicAssistantConversation, PublicAssistantRunStarted, User } from '../../shared/contracts.js';

// --- Mocks (hoisted above the imports below) ---------------------------------

const sdkMock = vi.hoisted(() => {
  const run = {
    supports: () => false,
    wait: async () => ({ status: 'finished', result: 'Stub reply' }),
    cancel: async () => {},
  };
  const prompts: string[] = [];
  const agentKeys: string[] = [];
  const agent = {
    reload: async () => {},
    send: vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return run;
    }),
    close: async () => {},
  };
  return {
    prompts,
    agentKeys,
    resume: vi.fn(async (_id: string, options: { apiKey: string }) => {
      agentKeys.push(options.apiKey);
      return agent;
    }),
    create: vi.fn(async (options: { apiKey: string }) => {
      agentKeys.push(options.apiKey);
      return agent;
    }),
    configure: vi.fn(),
  };
});

vi.mock('@cursor/sdk', () => ({
  Cursor: { configure: sdkMock.configure },
  JsonlLocalAgentStore: class {},
  Agent: { resume: sdkMock.resume, create: sdkMock.create },
}));
// Writes ~/.cursor/cli-config.json — must never run from a test.
vi.mock('./cursorCliConfig.js', () => ({ ensureAssistantCursorPermissions: vi.fn() }));

// cursorRuntime.ts gates on Node >= 22.13; the SDK is mocked, so fake the version on an older Node.
const realNodeVersions = process.versions;
{
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '22.13.0' }, configurable: true });
  }
}

const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-public-assistant-ws-'));
const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-public-assistant-state-'));
process.env.CURSOR_AGENT_WORKSPACE_ROOT = workspaceRoot;
process.env.CURSOR_AGENT_STATE_DIR = stateDir;
const { loadEnv } = await import('../env.js');
loadEnv();
const saved = {
  secret: process.env.FOLIO_SECRET,
  cursorKey: process.env.CURSOR_API_KEY,
  perIp: process.env.PUBLIC_ASSISTANT_RUNS_PER_HOUR,
  perSpace: process.env.PUBLIC_ASSISTANT_SPACE_RUNS_PER_HOUR,
};
process.env.FOLIO_SECRET = 'public-assistant-test-secret';
delete process.env.CURSOR_API_KEY;
delete process.env.PUBLIC_ASSISTANT_RUNS_PER_HOUR;
delete process.env.PUBLIC_ASSISTANT_SPACE_RUNS_PER_HOUR;

const { setUpTestSchema, deleteTestSpace } = await import('../db/testSchema.js');
const authStore = await import('../auth/store.js');
const session = await import('../auth/session.js');
const storage = await import('../storage.js');
const pageAccess = await import('../pageAccess.js');
const { HttpError } = await import('../errors.js');
const { __resetRateLimitsForTests } = await import('../rateLimit.js');
const { setSpacePublicSettings } = await import('../publicSites.js');
const { registerPublicAuthRoutes } = await import('../auth/routes.js');
const sharedKeys = await import('./sharedKeys.js');
const runs = await import('./runs.js');
const { buildAssistantTools } = await import('./tools.js');
const { registerPublicAssistantRoutes } = await import('./publicRoutes.js');

type Tools = Awaited<ReturnType<typeof buildAssistantTools>>;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  registerPublicAuthRoutes(app);
  registerPublicAssistantRoutes(app); // public scope, exactly as server/index.ts registers it
  await app.ready();
  return app;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('public-site assistant (real PG, fastify inject, mocked Cursor SDK)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  const stamp = Date.now();
  const marker = `quokka${stamp}`;
  let freshInstanceNeedsSetup = false;

  let admin: User;
  let visitor: User;
  let pub: string;
  let other: string;
  let quiet: string;
  let priv: string;
  let inst: string;
  const ids = { guide: '', secret: '', rules: '', template: '', otherPage: '' };
  const createdSpaces: string[] = [];
  const openTools: Tools[] = [];

  const post = (url: string, payload: Record<string, unknown>, ip = '203.0.113.1') =>
    app.inject({ method: 'POST', url, payload, remoteAddress: ip });
  const get = (url: string) => app.inject({ method: 'GET', url });
  const startRun = (space: string, payload: Record<string, unknown>, ip?: string) => post(`/api/public/spaces/${space}/assistant/runs`, payload, ip);

  async function doc(space: string, parentPath: string, title: string, body: string): Promise<string> {
    const meta = await storage.createPage({ space, parentPath, title, kind: 'doc' });
    await storage.writeDocBody(meta.id, `# ${title}\n\n${body}\n`);
    return meta.id;
  }

  async function publish(slug: string, allowAssistant: boolean): Promise<void> {
    await authStore.setSpaceVisibility(slug, 'public');
    await setSpacePublicSettings(slug, { subdomain: null, domain: null, allowDownload: false, allowAssistant });
  }

  /** Calls one assistant tool and returns its answer as text, whether it succeeded or not. */
  async function call(handle: Tools, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const tool = handle.tools[name];
    if (!tool) throw new Error(`tool ${name} is not offered`);
    const result = (await tool.execute(args as never, {} as never)) as unknown;
    if (typeof result === 'string') return { text: result, isError: false };
    const r = result as { content?: Array<{ text?: string }>; isError?: boolean };
    return { text: (r.content ?? []).map((c) => c.text ?? '').join('\n'), isError: !!r.isError };
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    // Migration 039 inserted the system user; a fresh instance must still ask for its first-run setup.
    freshInstanceNeedsSetup = !(await authStore.hasAnyUsers());

    admin = await authStore.createUser({ email: `pubai-admin-${stamp}@test.local`, name: 'Admin', passwordHash: 'x', isAdmin: true });
    visitor = (await authStore.findUserById(authStore.PUBLIC_VISITOR_USER_ID))!;

    pub = (await storage.createSpace(`Pub AI ${stamp}`, admin.id)).slug;
    other = (await storage.createSpace(`Pub AI Other ${stamp}`, admin.id)).slug;
    quiet = (await storage.createSpace(`Pub AI Quiet ${stamp}`, admin.id)).slug;
    priv = (await storage.createSpace(`Pub AI Private ${stamp}`, admin.id)).slug;
    inst = (await storage.createSpace(`Pub AI Instance ${stamp}`, admin.id)).slug;
    createdSpaces.push(pub, other, quiet, priv, inst);
    for (const slug of createdSpaces) await authStore.setMembership(slug, admin.id, 'admin');

    ids.guide = await doc(pub, '', 'Guide', `The ${marker} guide.`);
    ids.secret = await doc(pub, '', 'Secret', `Secret ${marker} text.`);
    ids.rules = await doc(pub, '.agent', 'Rules', `Agent rule ${marker}: always be brief.`);
    ids.template = await doc(pub, '_templates', 'Weekly', `Template ${marker}.`);
    ids.otherPage = await doc(other, '', 'Other page', `Other ${marker} text.`);
    await pageAccess.setAccess(admin, await storage.requireEntry(ids.secret), 'restricted', []);

    await publish(pub, true);
    await publish(other, true);
    await publish(quiet, false);
    await setSpacePublicSettings(priv, { subdomain: null, domain: null, allowDownload: false, allowAssistant: true });
    await authStore.setSpaceVisibility(inst, 'instance');
    await sharedKeys.saveSpaceKey(pub, 'space-key-pub', 'pub-key', null, admin.id);

    app = await buildApp();
  });

  beforeEach(() => {
    __resetRateLimitsForTests();
    sdkMock.prompts.length = 0;
    sdkMock.agentKeys.length = 0;
  });

  afterAll(async () => {
    for (const handle of openTools) await handle.close();
    await app?.close();
    for (const slug of createdSpaces) await deleteTestSpace(slug).catch(() => {});
    await teardownSchema();
    const restore = (name: string, value: string | undefined) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
    restore('FOLIO_SECRET', saved.secret);
    restore('CURSOR_API_KEY', saved.cursorKey);
    restore('PUBLIC_ASSISTANT_RUNS_PER_HOUR', saved.perIp);
    restore('PUBLIC_ASSISTANT_SPACE_RUNS_PER_HOUR', saved.perSpace);
    Object.defineProperty(process, 'versions', { value: realNodeVersions, configurable: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it('404 `space not found` for a private, instance, unknown space and a public space with the assistant off — on every route', async () => {
    for (const slug of [priv, inst, quiet, 'no-such-space']) {
      const run = await startRun(slug, { message: 'hello' });
      expect(run.statusCode, slug).toBe(404);
      expect(run.json().error).toBe('space not found');
      expect((await get(`/api/public/spaces/${slug}/assistant/conversations/00000000-0000-4000-8000-000000000001?guestToken=x`)).statusCode).toBe(404);
      expect((await get(`/api/public/spaces/${slug}/assistant/runs/00000000-0000-4000-8000-000000000001/events?guestToken=x`)).statusCode).toBe(404);
    }
    expect(sdkMock.create).not.toHaveBeenCalled();
  });

  it('409 when no key exists for the site (no space key, no instance key, no CURSOR_API_KEY); nothing is created', async () => {
    const res = await startRun(other, { message: 'hello' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Folio AI is not configured for this site');
    expect(sdkMock.agentKeys).toEqual([]);
  });

  it('202 with the space key: Ask-only run as the public visitor, confined to the space, with the visitor notice and the .agent rules', async () => {
    const res = await startRun(pub, { message: 'What is in the guide?', pageId: ids.guide });
    expect(res.statusCode).toBe(202);
    const started = res.json<PublicAssistantRunStarted>();
    expect(started.guestToken).toMatch(/^[0-9a-f]{48}$/);
    await waitUntil(() => runs.peek(started.runId)?.status === 'done');

    expect(sdkMock.agentKeys).toEqual(['space-key-pub']);
    expect(runs.peek(started.runId)?.userId).toBe(authStore.PUBLIC_VISITOR_USER_ID);
    const prompt = sdkMock.prompts.join('\n');
    expect(prompt).toContain('anonymous visitor of the public website');
    expect(prompt).toContain(`Agent rule ${marker}`); // the space's .agent rules are injected as usual
    expect(prompt).toContain(ids.guide); // the open page is the navigation context
    expect(prompt).toContain('Mode of this run: ASK');

    // A pageId outside the public set (a restricted page) is ignored, not echoed into the context.
    const second = await startRun(pub, { message: 'And the secret?', pageId: ids.secret });
    expect(second.statusCode).toBe(202);
    await waitUntil(() => runs.peek(second.json<PublicAssistantRunStarted>().runId)?.status === 'done');
    expect(sdkMock.prompts.at(-1)).not.toContain(ids.secret);
  });

  it('a conversation continues only with its guest token: wrong token / other space is 404 for runs, events, stop and history', async () => {
    const first = (await startRun(pub, { message: 'first question' })).json<PublicAssistantRunStarted>();
    await waitUntil(() => runs.peek(first.runId)?.status === 'done');

    const wrong = await startRun(pub, { message: 'again', conversationId: first.conversationId, guestToken: 'f'.repeat(48) });
    expect(wrong.statusCode).toBe(404);
    expect((await startRun(pub, { message: 'again', conversationId: first.conversationId })).statusCode).toBe(404);
    // The same id and the right token on ANOTHER public site: still 404.
    expect((await get(`/api/public/spaces/${other}/assistant/conversations/${first.conversationId}?guestToken=${first.guestToken}`)).statusCode).toBe(404);

    const base = `/api/public/spaces/${pub}/assistant`;
    expect((await get(`${base}/runs/${first.runId}/events?guestToken=${'f'.repeat(48)}`)).statusCode).toBe(404);
    expect((await get(`${base}/runs/${first.runId}/events`)).statusCode).toBe(404);
    expect((await get(`/api/public/spaces/${other}/assistant/runs/${first.runId}/events?guestToken=${first.guestToken}`)).statusCode).toBe(404);
    expect((await post(`${base}/runs/${first.runId}/stop`, { guestToken: 'nope' })).statusCode).toBe(404);
    expect((await get(`${base}/conversations/${first.conversationId}?guestToken=nope`)).statusCode).toBe(404);

    const events = await get(`${base}/runs/${first.runId}/events?guestToken=${first.guestToken}`);
    expect(events.statusCode).toBe(200);
    expect(events.body).toContain('"type":"complete"');

    const next = await startRun(pub, { message: 'second question', conversationId: first.conversationId, guestToken: first.guestToken });
    expect(next.statusCode).toBe(202);
    expect(next.json<PublicAssistantRunStarted>()).toMatchObject({ conversationId: first.conversationId, guestToken: first.guestToken });
    await waitUntil(() => runs.peek(next.json<PublicAssistantRunStarted>().runId)?.status === 'done');
    expect((await post(`${base}/runs/${next.json<PublicAssistantRunStarted>().runId}/stop`, { guestToken: first.guestToken })).statusCode).toBe(202);

    const history = await get(`${base}/conversations/${first.conversationId}?guestToken=${first.guestToken}`);
    expect(history.statusCode).toBe(200);
    const body = history.json<PublicAssistantConversation>();
    expect(body.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'first question'],
      ['assistant', 'Stub reply'],
      ['user', 'second question'],
      ['assistant', 'Stub reply'],
    ]);
    expect(body.activeRunId).toBeNull();
  });

  it('rate limits apply before any work: per IP, then per space, with Retry-After', async () => {
    process.env.PUBLIC_ASSISTANT_RUNS_PER_HOUR = '2';
    process.env.PUBLIC_ASSISTANT_SPACE_RUNS_PER_HOUR = '3';
    try {
      // `other` has no key: the first two get as far as the key check (409); the third never gets there.
      expect((await startRun(other, { message: 'a' }, '198.51.100.7')).statusCode).toBe(409);
      expect((await startRun(other, { message: 'b' }, '198.51.100.7')).statusCode).toBe(409);
      const limited = await startRun(other, { message: 'c' }, '198.51.100.7');
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

      // The site's own budget (3/h) is shared by every visitor: one more from a new IP fits, the next does not.
      expect((await startRun(other, { message: 'd' }, '198.51.100.8')).statusCode).toBe(409);
      expect((await startRun(other, { message: 'e' }, '198.51.100.9')).statusCode).toBe(429);
    } finally {
      delete process.env.PUBLIC_ASSISTANT_RUNS_PER_HOUR;
      delete process.env.PUBLIC_ASSISTANT_SPACE_RUNS_PER_HOUR;
    }
  });

  it('the public MCP actor sees one space and only its public pages: list_spaces, read_page, search_pages, list_tree, folio_table_list, history', async () => {
    const handle = await buildAssistantTools(visitor, 'ask', { runId: 'r', conversationId: 'c', space: pub, pageId: null, publicSpace: pub });
    openTools.push(handle);

    // No write tool and no history is even offered.
    for (const name of ['create_page', 'update_page', 'create_board', 'update_board', 'board_ops', 'folio_table_insert', 'page_history', 'page_at_sha', 'list_templates', 'create_page_from_template', 'save_page_as_template', 'create_template']) {
      expect(handle.tools[name], name).toBeUndefined();
    }

    const spaces = JSON.parse((await call(handle, 'list_spaces')).text) as Array<{ slug: string }>;
    expect(spaces.map((s) => s.slug)).toEqual([pub]);

    expect((await call(handle, 'read_page', { id: ids.guide })).text).toContain(`The ${marker} guide.`);
    for (const id of [ids.secret, ids.rules, ids.template, ids.otherPage]) {
      const res = await call(handle, 'read_page', { id });
      expect(res, id).toEqual({ text: 'page not found', isError: true });
    }

    // Search: only the public page of `pub`, whatever `space` is asked for.
    for (const args of [{ query: marker }, { query: marker, space: other }]) {
      const text = (await call(handle, 'search_pages', args)).text;
      expect(text).toContain(ids.guide);
      for (const hidden of [ids.secret, ids.rules, ids.template, ids.otherPage, other]) expect(text).not.toContain(hidden);
    }

    expect(await call(handle, 'list_tree', { space: other })).toEqual({ text: 'space not found', isError: true });
    expect(await call(handle, 'list_tree', { space: inst })).toEqual({ text: 'space not found', isError: true });
    const tree = (await call(handle, 'list_tree', { space: pub })).text;
    expect(tree).toContain(ids.guide);
    for (const hidden of [ids.secret, ids.rules, ids.template]) expect(tree).not.toContain(hidden);
    expect((await call(handle, 'folio_table_list', { space: other })).text).not.toContain(other);
  });

  it('a public run is Ask-only, and the system user never runs unconfined', async () => {
    await expect(buildAssistantTools(visitor, 'agent', { runId: 'r', conversationId: 'c', space: pub, pageId: null, publicSpace: pub })).rejects.toThrow(/Ask-only/);
    await expect(buildAssistantTools(visitor, 'ask', { runId: 'r', conversationId: 'c', space: null, pageId: null })).rejects.toThrow(/confined/);
  });

  it('the system user: viewer of public spaces only (never instance/private), never admin; never signs in, never listed as a person', async () => {
    expect(visitor).toMatchObject({ id: authStore.PUBLIC_VISITOR_USER_ID, name: 'Public visitor', isSystem: true, isAdmin: false });
    expect(await session.effectiveRole(visitor, inst)).toBeUndefined();
    expect(await session.effectiveRole(visitor, priv)).toBeUndefined();
    expect(await session.effectiveRole(visitor, pub)).toBe('viewer');
    expect(await session.canAdministerSpace(visitor, pub)).toBe(false);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'public-visitor@folio.local', password: 'anything' } });
    expect(login.statusCode).toBe(401);
    await expect(authStore.createSession(authStore.PUBLIC_VISITOR_USER_ID)).rejects.toThrow(/system account/);
    await expect(authStore.createApiToken(authStore.PUBLIC_VISITOR_USER_ID, 't', ['read'])).rejects.toThrow(/system account/);
    expect((await authStore.listUsers()).map((u) => u.id)).not.toContain(authStore.PUBLIC_VISITOR_USER_ID);
    expect(freshInstanceNeedsSetup).toBe(true);
  });
});
