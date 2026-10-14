/**
 * Shared Folio AI keys: an instance-wide key and a per-space key on top of the
 * personal one (db/migrations/037_assistant_shared_keys.sql).
 *
 * Real PostgreSQL (per-file schema), the real routes via Fastify inject and the
 * real encryption (FOLIO_SECRET). Only the Cursor SDK is mocked: `Cursor.me`
 * accepts any key that starts with `good-` and names it `name-of-<rest of the key>`, and
 * `Cursor.models.list` / `Agent.create` record which key they were called with,
 * so "which key a run uses" is a plain assertion on the mock.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AssistantSettings, SharedAssistantKeyInfo, User } from '../../shared/contracts.js';

// --- Mocks (hoisted above the imports below) ---------------------------------

const sdkMock = vi.hoisted(() => {
  const run = {
    supports: () => false,
    wait: async () => ({ status: 'finished', result: 'Stub reply' }),
    cancel: async () => {},
  };
  const agent = {
    reload: async () => {},
    send: vi.fn(async () => run),
    close: async () => {},
  };
  return {
    modelsListKeys: [] as string[],
    meKeys: [] as string[],
    agentKeys: [] as string[],
    me: vi.fn(async (options: { apiKey: string }) => {
      sdkMock.meKeys.push(options.apiKey);
      if (!options.apiKey.startsWith('good-')) throw new Error('invalid api key');
      // The name must not contain the key itself, or "the response never contains the key" could not be asserted.
      return { apiKeyName: `name-of-${options.apiKey.slice('good-'.length)}`, userEmail: 'owner@cursor.test' };
    }),
    modelsList: vi.fn(async (options: { apiKey: string }) => {
      sdkMock.modelsListKeys.push(options.apiKey);
      return [{ id: 'auto', displayName: 'Auto', description: null }];
    }),
    resume: vi.fn(async (_id: string, options: { apiKey: string }) => {
      sdkMock.agentKeys.push(options.apiKey);
      return agent;
    }),
    create: vi.fn(async (options: { apiKey: string }) => {
      sdkMock.agentKeys.push(options.apiKey);
      return agent;
    }),
    configure: vi.fn(),
  };
});

vi.mock('@cursor/sdk', () => ({
  Cursor: { configure: sdkMock.configure, me: sdkMock.me, models: { list: sdkMock.modelsList } },
  JsonlLocalAgentStore: class {},
  Agent: { resume: sdkMock.resume, create: sdkMock.create },
}));

// Writes ~/.cursor/cli-config.json — must never run from a test.
vi.mock('./cursorCliConfig.js', () => ({ ensureAssistantCursorPermissions: vi.fn() }));

// cursorRuntime.ts gates on Node >= 22.13 (what the real SDK needs). The SDK is mocked here, so on an older
// Node the version is faked for the duration of this file.
const realNodeVersions = process.versions;
{
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '22.13.0' }, configurable: true });
  }
}

const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-shared-keys-ws-'));
const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-shared-keys-state-'));
process.env.CURSOR_AGENT_WORKSPACE_ROOT = workspaceRoot;
process.env.CURSOR_AGENT_STATE_DIR = stateDir;
// Keys are encrypted for real; no operator key until a test sets one. Load .env first so it cannot add either back later.
const { loadEnv } = await import('../env.js');
loadEnv();
const realFolioSecret = process.env.FOLIO_SECRET;
const realCursorKey = process.env.CURSOR_API_KEY;
process.env.FOLIO_SECRET = 'shared-keys-test-secret';
delete process.env.CURSOR_API_KEY;

const { setUpTestSchema, deleteTestSpace } = await import('../db/testSchema.js');
const { query } = await import('../db/pool.js');
const authStore = await import('../auth/store.js');
const storage = await import('../storage.js');
const session = await import('../auth/session.js');
const { HttpError } = await import('../errors.js');
const assistantStore = await import('./store.js');
const runs = await import('./runs.js');
const sharedKeys = await import('./sharedKeys.js');
const { registerAssistantRoutes, resolveApiKey } = await import('./routes.js');
const { registerAssistantAdminRoutes } = await import('./adminRoutes.js');

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
    registerAssistantRoutes(protectedScope);
    registerAssistantAdminRoutes(protectedScope);
  });
  await app.ready();
  return app;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('shared Folio AI keys (real PG, fastify inject, mocked Cursor SDK)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  const stamp = Date.now();

  let owner: User; // instance admin
  let spaceAdmin: User; // explicit admin of space 1 only
  let member: User; // editor in space 1
  let outsider: User; // no membership anywhere
  let ownerCookie: string;
  let spaceAdminCookie: string;
  let memberCookie: string;
  let outsiderCookie: string;
  let slug1: string;
  let slug2: string;
  const createdSpaces: string[] = [];

  const cookieFor = async (user: User): Promise<string> => `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}`;
  const req = (method: 'GET' | 'PUT' | 'DELETE' | 'POST', url: string, cookie: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

  async function auditRows(action: string) {
    return query<{ actor_id: string | null; target: string | null; meta: Record<string, unknown> | null }>(
      'SELECT actor_id, target, meta FROM audit_log WHERE action = $1 ORDER BY at',
      [action],
    );
  }

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const mk = (name: string, isAdmin = false) => authStore.createUser({ email: `shared-${name}-${stamp}@test.local`, name: `User ${name}`, passwordHash: 'x', isAdmin });
    [owner, spaceAdmin, member, outsider] = await Promise.all([mk('owner', true), mk('spaceadmin'), mk('member'), mk('outsider')]);
    [ownerCookie, spaceAdminCookie, memberCookie, outsiderCookie] = await Promise.all([cookieFor(owner), cookieFor(spaceAdmin), cookieFor(member), cookieFor(outsider)]);

    const space1 = await storage.createSpace(`Shared Keys One ${stamp}`, owner.id);
    const space2 = await storage.createSpace(`Shared Keys Two ${stamp}`, owner.id);
    [slug1, slug2] = [space1.slug, space2.slug];
    createdSpaces.push(slug1, slug2);
    await authStore.setMembership(slug1, spaceAdmin.id, 'admin');
    await authStore.setMembership(slug1, member.id, 'editor');
    await authStore.setMembership(slug2, member.id, 'editor');

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    for (const slug of createdSpaces) await deleteTestSpace(slug).catch(() => {});
    await teardownSchema();
    const restore = (name: string, value: string | undefined) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
    restore('FOLIO_SECRET', realFolioSecret);
    restore('CURSOR_API_KEY', realCursorKey);
    Object.defineProperty(process, 'versions', { value: realNodeVersions, configurable: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // (a) Resolution order: personal -> space -> instance -> environment
  // -------------------------------------------------------------------------

  it('with no key anywhere: nothing resolves, settings say "none", a run is refused with the generic 409', async () => {
    expect(await resolveApiKey(member.id, slug1)).toBeNull();
    const settings = (await req('GET', `/api/assistant/settings?space=${slug1}`, memberCookie)).json() as AssistantSettings;
    expect(settings).toMatchObject({ apiKeyConfigured: false, apiKeySource: 'none', apiKeyName: null, personalKeysAllowed: true });

    const run = await req('POST', '/api/assistant/runs', memberCookie, { message: 'hello', runMode: 'ask', startNew: true, space: slug1 });
    expect(run.statusCode).toBe(409);
    expect(run.json().error).toBe('No Folio AI key is configured — add your own key in account settings or ask an administrator');
  });

  it('the operator environment key is the last resort', async () => {
    process.env.CURSOR_API_KEY = 'env-key';
    try {
      expect(await resolveApiKey(member.id, slug1)).toEqual({ apiKey: 'env-key', source: 'environment', apiKeyName: null });
      const settings = (await req('GET', '/api/assistant/settings', memberCookie)).json() as AssistantSettings;
      expect(settings).toMatchObject({ apiKeyConfigured: true, apiKeySource: 'environment', apiKeyName: null });
    } finally {
      delete process.env.CURSOR_API_KEY;
    }
  });

  it('personal -> space -> instance -> environment, and the space level only applies inside that space', async () => {
    process.env.CURSOR_API_KEY = 'env-key';
    try {
      // instance admin sets the instance key; it beats the environment
      const setInstance = await req('PUT', '/api/admin/assistant/key', ownerCookie, { apiKey: 'good-instance' });
      expect(setInstance.statusCode).toBe(200);
      expect(await resolveApiKey(member.id, null)).toEqual({ apiKey: 'good-instance', source: 'instance', apiKeyName: 'name-of-instance' });

      // a space admin sets the key of space 1; it beats the instance key in space 1 only
      const setSpace = await req('PUT', `/api/spaces/${slug1}/assistant-key`, spaceAdminCookie, { apiKey: 'good-space' });
      expect(setSpace.statusCode).toBe(200);
      expect(await resolveApiKey(member.id, slug1)).toEqual({ apiKey: 'good-space', source: 'space', apiKeyName: 'name-of-space' });
      expect((await resolveApiKey(member.id, slug2))?.source).toBe('instance');
      expect((await resolveApiKey(member.id, null))?.source).toBe('instance');

      // the settings endpoint reports the same, per space
      const inSpace = (await req('GET', `/api/assistant/settings?space=${slug1}`, memberCookie)).json() as AssistantSettings;
      expect(inSpace).toMatchObject({ apiKeySource: 'space', apiKeyName: 'name-of-space', apiKeyConfigured: true });
      const elsewhere = (await req('GET', `/api/assistant/settings?space=${slug2}`, memberCookie)).json() as AssistantSettings;
      expect(elsewhere).toMatchObject({ apiKeySource: 'instance', apiKeyName: 'name-of-instance' });

      // a personal key beats both
      await assistantStore.saveCursorKey(member.id, 'good-personal', 'name-of-personal', null);
      expect(await resolveApiKey(member.id, slug1)).toEqual({ apiKey: 'good-personal', source: 'personal', apiKeyName: 'name-of-personal' });
      const personal = (await req('GET', `/api/assistant/settings?space=${slug1}`, memberCookie)).json() as AssistantSettings;
      expect(personal).toMatchObject({ apiKeySource: 'personal', apiKeyName: 'name-of-personal' });

      // the model list and a run use the resolved key (observed at the SDK)
      sdkMock.modelsListKeys.length = 0;
      expect((await req('GET', `/api/assistant/models?space=${slug1}`, memberCookie)).statusCode).toBe(200);
      expect(sdkMock.modelsListKeys).toEqual(['good-personal']);

      // removing the personal key falls back to the space key; removing that, to the instance key; then to the environment
      expect((await req('DELETE', '/api/assistant/settings/key', memberCookie)).statusCode).toBe(204);
      sdkMock.modelsListKeys.length = 0;
      await req('GET', `/api/assistant/models?space=${slug1}`, memberCookie);
      expect(sdkMock.modelsListKeys).toEqual(['good-space']);

      expect((await req('DELETE', `/api/spaces/${slug1}/assistant-key`, spaceAdminCookie)).statusCode).toBe(204);
      expect((await resolveApiKey(member.id, slug1))?.source).toBe('instance');

      expect((await req('DELETE', '/api/admin/assistant/key', ownerCookie)).statusCode).toBe(204);
      expect(await resolveApiKey(member.id, slug1)).toEqual({ apiKey: 'env-key', source: 'environment', apiKeyName: null });
    } finally {
      delete process.env.CURSOR_API_KEY;
    }
  });

  it('a run in a space starts with that space\'s key', async () => {
    await req('PUT', `/api/spaces/${slug1}/assistant-key`, spaceAdminCookie, { apiKey: 'good-space-run' });
    sdkMock.agentKeys.length = 0;
    const run = await req('POST', '/api/assistant/runs', memberCookie, { message: 'hello', runMode: 'ask', startNew: true, space: slug1 });
    expect(run.statusCode).toBe(202);
    const { runId } = run.json() as { runId: string };
    await waitUntil(() => runs.peek(runId)?.status === 'done');
    expect(sdkMock.agentKeys.length).toBeGreaterThan(0);
    expect(new Set(sdkMock.agentKeys)).toEqual(new Set(['good-space-run']));
    await req('DELETE', `/api/spaces/${slug1}/assistant-key`, spaceAdminCookie);
  });

  it('personalKeysAllowed=false skips the personal key, refuses a new one (403) but still lets it be removed', async () => {
    await sharedKeys.saveInstanceKey('good-instance-2', 'name-of-instance-2', null, owner.id);
    await assistantStore.saveCursorKey(member.id, 'good-personal', 'name-of-personal', null);
    expect((await resolveApiKey(member.id, null))?.source).toBe('personal');

    const policy = await req('PUT', '/api/admin/assistant/key-policy', ownerCookie, { personalKeysAllowed: false });
    expect(policy.statusCode).toBe(200);
    expect((policy.json() as SharedAssistantKeyInfo).personalKeysAllowed).toBe(false);
    expect(await sharedKeys.getPersonalKeysAllowed()).toBe(false);

    // the stored personal key is ignored: instance key wins, and so does the space key inside its space
    expect(await resolveApiKey(member.id, null)).toEqual({ apiKey: 'good-instance-2', source: 'instance', apiKeyName: 'name-of-instance-2' });
    await sharedKeys.saveSpaceKey(slug1, 'good-space-2', 'name-of-space-2', null, spaceAdmin.id);
    expect((await resolveApiKey(member.id, slug1))?.source).toBe('space');
    const settings = (await req('GET', `/api/assistant/settings?space=${slug1}`, memberCookie)).json() as AssistantSettings;
    expect(settings).toMatchObject({ personalKeysAllowed: false, apiKeySource: 'space' });

    const put = await req('PUT', '/api/assistant/settings/key', memberCookie, { apiKey: 'good-another' });
    expect(put.statusCode).toBe(403);
    expect(put.json().error).toBe('Personal AI keys are disabled on this instance');
    expect((await req('DELETE', '/api/assistant/settings/key', memberCookie)).statusCode).toBe(204);

    // switching the policy back brings personal keys back
    await req('PUT', '/api/admin/assistant/key-policy', ownerCookie, { personalKeysAllowed: true });
    expect((await req('PUT', '/api/assistant/settings/key', memberCookie, { apiKey: 'good-another' })).statusCode).toBe(200);
    expect((await resolveApiKey(member.id, slug1))?.source).toBe('personal');

    await sharedKeys.deleteSpaceKey(slug1);
    await sharedKeys.deleteInstanceKey();
    await assistantStore.deleteCursorKey(member.id);
  });

  it('?space= does not leak: a space the caller cannot read, or an unknown one, is just "no space level"', async () => {
    await sharedKeys.saveInstanceKey('good-instance-3', 'name-of-instance-3', null, owner.id);
    await sharedKeys.saveSpaceKey(slug1, 'good-space-3', 'name-of-space-3', null, spaceAdmin.id);
    try {
      const secretSpace = await req('GET', `/api/assistant/settings?space=${slug1}`, outsiderCookie);
      const unknownSpace = await req('GET', `/api/assistant/settings?space=no-such-space-${stamp}`, outsiderCookie);
      expect(secretSpace.statusCode).toBe(200);
      expect(secretSpace.json()).toEqual(unknownSpace.json());
      expect(secretSpace.json()).toMatchObject({ apiKeySource: 'instance', apiKeyName: 'name-of-instance-3' });
      // and a member does see the space level
      expect((await req('GET', `/api/assistant/settings?space=${slug1}`, memberCookie)).json()).toMatchObject({ apiKeySource: 'space' });
      // an overlong value is a 400, not a lookup
      expect((await req('GET', `/api/assistant/settings?space=${'x'.repeat(201)}`, memberCookie)).statusCode).toBe(400);
    } finally {
      await sharedKeys.deleteSpaceKey(slug1);
      await sharedKeys.deleteInstanceKey();
    }
  });

  // -------------------------------------------------------------------------
  // (b) What GET returns - and what never leaves the server
  // -------------------------------------------------------------------------

  it('GET info carries the key name, email, who/when - never the key - and the stored value is ciphertext', async () => {
    const put = await req('PUT', '/api/admin/assistant/key', ownerCookie, { apiKey: 'good-secret-instance-key' });
    expect(put.statusCode).toBe(200);
    const putSpace = await req('PUT', `/api/spaces/${slug1}/assistant-key`, spaceAdminCookie, { apiKey: 'good-secret-space-key' });
    expect(putSpace.statusCode).toBe(200);

    const instance = await req('GET', '/api/admin/assistant/key', ownerCookie);
    const space = await req('GET', `/api/spaces/${slug1}/assistant-key`, spaceAdminCookie);
    for (const res of [put, putSpace, instance, space]) {
      expect(res.body).not.toContain('good-secret-instance-key');
      expect(res.body).not.toContain('good-secret-space-key');
      expect(Object.keys(res.json())).not.toContain('apiKey');
    }
    expect(instance.json()).toMatchObject({
      scope: 'instance',
      space: null,
      configured: true,
      apiKeyName: 'name-of-secret-instance-key',
      email: 'owner@cursor.test',
      updatedBy: { id: owner.id, name: owner.name },
      personalKeysAllowed: true,
      encryptionAvailable: true,
      runtimeAvailable: true,
    });
    expect(typeof (instance.json() as SharedAssistantKeyInfo).updatedAt).toBe('string');
    expect(space.json()).toMatchObject({
      scope: 'space',
      space: slug1,
      configured: true,
      apiKeyName: 'name-of-secret-space-key',
      updatedBy: { id: spaceAdmin.id, name: spaceAdmin.name },
      personalKeysAllowed: null,
    });

    // at rest it is AES-GCM ciphertext (iv + tag + data), not the plaintext
    const [inst] = await query<{ cursor_key_enc: Buffer }>('SELECT cursor_key_enc FROM instance_assistant_settings WHERE id = 1');
    const [sp] = await query<{ cursor_key_enc: Buffer }>('SELECT cursor_key_enc FROM space_assistant_settings WHERE space_slug = $1', [slug1]);
    expect(inst!.cursor_key_enc.toString('utf8')).not.toContain('good-secret-instance-key');
    expect(sp!.cursor_key_enc.toString('utf8')).not.toContain('good-secret-space-key');
    expect((await sharedKeys.getDecryptedInstanceKey())?.apiKey).toBe('good-secret-instance-key');
    expect((await sharedKeys.getDecryptedSpaceKey(slug1))?.apiKey).toBe('good-secret-space-key');

    // an unconfigured space reads as "not configured" for its admin
    const empty = (await req('GET', `/api/spaces/${slug2}/assistant-key`, ownerCookie)).json() as SharedAssistantKeyInfo;
    expect(empty).toMatchObject({ scope: 'space', space: slug2, configured: false, apiKeyName: null, email: null, updatedAt: null, updatedBy: null });
  });

  it('writes are audited without the key, and a rejected key is a 400 that stores nothing', async () => {
    await waitUntil(async () => (await auditRows('assistant.space_key_set')).length > 0 && (await auditRows('assistant.instance_key_set')).length > 0);
    const [spaceSet] = await auditRows('assistant.space_key_set');
    expect(spaceSet).toMatchObject({ actor_id: spaceAdmin.id, target: slug1 });
    const [instanceSet] = await auditRows('assistant.instance_key_set');
    expect(instanceSet).toMatchObject({ actor_id: owner.id, target: 'instance' });
    expect(JSON.stringify([spaceSet, instanceSet])).not.toContain('good-secret');

    const before = await sharedKeys.getInstanceKeyInfo();
    const bad = await req('PUT', '/api/admin/assistant/key', ownerCookie, { apiKey: 'bad-key' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('Cursor API key was not accepted');
    expect(await sharedKeys.getInstanceKeyInfo()).toEqual(before);
    expect((await req('PUT', '/api/admin/assistant/key', ownerCookie, { apiKey: '   ' })).statusCode).toBe(400);
  });

  // -------------------------------------------------------------------------
  // (c) Space route access
  // -------------------------------------------------------------------------

  it('space key route: a plain member is 403, a space admin and an instance admin are in, an unknown space is 404', async () => {
    const url = `/api/spaces/${slug1}/assistant-key`;
    for (const [method, payload] of [['GET', undefined], ['PUT', { apiKey: 'good-x' }], ['DELETE', undefined]] as const) {
      expect((await req(method, url, memberCookie, payload)).statusCode, `member ${method}`).toBe(403);
      expect((await req(method, url, outsiderCookie, payload)).statusCode, `outsider ${method}`).toBe(403);
    }
    // nothing changed by the refused PUT/DELETE
    expect((await sharedKeys.getDecryptedSpaceKey(slug1))?.apiKey).toBe('good-secret-space-key');

    expect((await req('GET', url, spaceAdminCookie)).statusCode).toBe(200);
    expect((await req('PUT', url, spaceAdminCookie, { apiKey: 'good-by-space-admin' })).statusCode).toBe(200);
    expect((await req('PUT', url, ownerCookie, { apiKey: 'good-by-instance-admin' })).statusCode).toBe(200);
    expect((await sharedKeys.getSpaceKeyInfo(slug1)).updatedBy?.id).toBe(owner.id);

    // a space admin of space 1 has nothing to say about space 2
    expect((await req('GET', `/api/spaces/${slug2}/assistant-key`, spaceAdminCookie)).statusCode).toBe(403);

    for (const cookie of [spaceAdminCookie, ownerCookie, memberCookie]) {
      expect((await req('GET', `/api/spaces/no-such-space-${stamp}/assistant-key`, cookie)).statusCode).toBe(404);
      expect((await req('PUT', `/api/spaces/no-such-space-${stamp}/assistant-key`, cookie, { apiKey: 'good-x' })).statusCode).toBe(404);
    }

    expect((await req('DELETE', url, spaceAdminCookie)).statusCode).toBe(204);
    expect((await sharedKeys.getSpaceKeyInfo(slug1)).configured).toBe(false);
    await waitUntil(async () => (await auditRows('assistant.space_key_removed')).some((row) => row.target === slug1 && row.actor_id === spaceAdmin.id));
  });

  it('a space key goes away with its space', async () => {
    const doomed = await storage.createSpace(`Shared Keys Doomed ${stamp}`, owner.id);
    createdSpaces.push(doomed.slug);
    await sharedKeys.saveSpaceKey(doomed.slug, 'good-doomed', 'name-of-doomed', null, owner.id);
    expect((await sharedKeys.getSpaceKeyInfo(doomed.slug)).configured).toBe(true);
    await deleteTestSpace(doomed.slug);
    expect((await sharedKeys.getSpaceKeyInfo(doomed.slug)).configured).toBe(false);
    expect(await sharedKeys.getDecryptedSpaceKey(doomed.slug)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // (d) Instance routes need an instance admin
  // -------------------------------------------------------------------------

  it('instance key routes: a space admin and a member are 403 on every method, the instance admin is in', async () => {
    const calls = [
      ['GET', '/api/admin/assistant/key', undefined],
      ['PUT', '/api/admin/assistant/key', { apiKey: 'good-x' }],
      ['DELETE', '/api/admin/assistant/key', undefined],
      ['PUT', '/api/admin/assistant/key-policy', { personalKeysAllowed: false }],
    ] as const;
    for (const cookie of [spaceAdminCookie, memberCookie, outsiderCookie]) {
      for (const [method, url, payload] of calls) {
        expect((await req(method, url, cookie, payload)).statusCode, `${method} ${url}`).toBe(403);
      }
    }
    // the refused calls changed nothing
    expect((await sharedKeys.getDecryptedInstanceKey())?.apiKey).toBe('good-secret-instance-key');
    expect(await sharedKeys.getPersonalKeysAllowed()).toBe(true);

    expect((await req('GET', '/api/admin/assistant/key', ownerCookie)).statusCode).toBe(200);
    const bad = await req('PUT', '/api/admin/assistant/key-policy', ownerCookie, { personalKeysAllowed: 'no' });
    expect(bad.statusCode).toBe(400);

    const policy = await req('PUT', '/api/admin/assistant/key-policy', ownerCookie, { personalKeysAllowed: false });
    expect(policy.json()).toMatchObject({ scope: 'instance', configured: true, personalKeysAllowed: false });
    // deleting the key leaves the policy alone
    expect((await req('DELETE', '/api/admin/assistant/key', ownerCookie)).statusCode).toBe(204);
    expect(await sharedKeys.getPersonalKeysAllowed()).toBe(false);
    expect((await req('GET', '/api/admin/assistant/key', ownerCookie)).json()).toMatchObject({ configured: false, apiKeyName: null, personalKeysAllowed: false });

    await waitUntil(async () => (await auditRows('assistant.key_policy')).length > 0 && (await auditRows('assistant.instance_key_removed')).length > 0);
    expect((await auditRows('assistant.key_policy'))[0]).toMatchObject({ actor_id: owner.id, meta: { personalKeysAllowed: false } });
    await req('PUT', '/api/admin/assistant/key-policy', ownerCookie, { personalKeysAllowed: true });
  });

  it('refuses to store a key when the server cannot encrypt it (409) - and keeps nothing', async () => {
    const saved = process.env.FOLIO_SECRET;
    // hasSecretConfigured() reads the live env, so removing it is enough to model "FOLIO_SECRET is not set".
    delete process.env.FOLIO_SECRET;
    try {
      const res = await req('PUT', '/api/admin/assistant/key', ownerCookie, { apiKey: 'good-no-secret' });
      expect(res.statusCode).toBe(409);
      const resSpace = await req('PUT', `/api/spaces/${slug1}/assistant-key`, spaceAdminCookie, { apiKey: 'good-no-secret' });
      expect(resSpace.statusCode).toBe(409);
    } finally {
      process.env.FOLIO_SECRET = saved;
    }
    expect((await sharedKeys.getInstanceKeyInfo()).configured).toBe(false);
    expect((await sharedKeys.getSpaceKeyInfo(slug1)).configured).toBe(false);
  });
});
