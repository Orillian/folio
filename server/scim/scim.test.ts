/**
 * SCIM 2.0 provisioning end to end over HTTP (Fastify inject, real per-run PG schema): the request sequences Okta
 * and Entra ID send, token authentication and scoping, malformed payloads, the last-admin guards, JIT vs SCIM,
 * and how a SCIM-created account is matched at its first sign-in (auth/sso.ts resolveSsoSignIn).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema } from '../db/testSchema.js';
import { query, queryOne } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { __resetRateLimitsForTests } from '../rateLimit.js';
import * as store from '../auth/store.js';
import * as session from '../auth/session.js';
import * as providers from '../auth/providers.js';
import type { AuthProvider } from '../auth/providers.js';
import { registerAuthProviderRoutes } from '../auth/providerRoutes.js';
import { resolveSsoSignIn, type MappedClaims } from '../auth/sso.js';
import { parseScimFilter } from './filter.js';
import { registerScimAdminRoutes, registerScimRoutes } from './routes.js';

const fastifyCookie = fastifyCookieModule.default;
const SCIM_JSON = 'application/scim+json';
const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function waitForAudit(action: string, target?: string): Promise<Array<{ actor_id: string | null; target: string | null; meta: Json | null }>> {
  for (let i = 0; i < 50; i++) {
    const rows = await query<{ actor_id: string | null; target: string | null; meta: Json | null }>(
      'SELECT actor_id, target, meta FROM audit_log WHERE action = $1 AND ($2::text IS NULL OR target = $2) ORDER BY id',
      [action, target ?? null],
    );
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return [];
}

function claims(subject: string, email: string | null, emailVerified = true): MappedClaims {
  return { subject, email, emailVerified, emailUnverifiedExplicitly: false, name: null, groups: undefined, hd: undefined };
}

describe('SCIM 2.0 provisioning (real PG, HTTP)', () => {
  let teardown: () => Promise<void>;
  let app: FastifyInstance;
  let adminCookie: string;
  let okta: AuthProvider;
  let entra: AuthProvider;
  let oktaToken: string;
  let entraToken: string;

  async function scim(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, token: string | null, body?: unknown, contentType = SCIM_JSON) {
    const res = await app.inject({
      method,
      url: `/scim/v2${url}`,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': contentType } : {}) },
      ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    return { status: res.statusCode, headers: res.headers, body: (res.body ? JSON.parse(res.body) : null) as Json };
  }

  async function generateToken(providerId: string): Promise<Json> {
    const res = await app.inject({ method: 'POST', url: `/api/admin/auth/providers/${providerId}/scim/token`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function login(userId: string): Promise<string> {
    return (await store.createSession(userId, { userAgent: 'Test/1.0', ip: '203.0.113.9' })).token;
  }

  beforeAll(async () => {
    teardown = await setUpTestSchema();
    app = Fastify({ logger: false });
    app.decorateRequest('authUser', null);
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
      return reply.status(500).send({ error: String(err) });
    });
    await app.register(fastifyCookie);
    await registerScimRoutes(app);
    await app.register(async (scope) => {
      scope.addHook('onRequest', session.requireSession);
      registerAuthProviderRoutes(scope);
      registerScimAdminRoutes(scope);
    });
    await app.ready();
    const admin = await store.createUser({ email: 'root@admin.local', name: 'Root', passwordHash: 'x', isAdmin: true });
    adminCookie = `${session.SESSION_COOKIE_NAME}=${await login(admin.id)}`;
    okta = await providers.createProvider({ slug: 'okta', displayName: 'Okta', issuer: 'https://okta.test', clientId: 'okta-client', allowedDomains: ['example.com'], jitEnabled: true });
    entra = await providers.createProvider({ slug: 'entra', displayName: 'Entra ID', issuer: 'https://login.entra.test/tenant/v2.0', clientId: 'entra-client', allowedDomains: ['contoso.com'] });
  });

  afterAll(async () => {
    await app.close();
    await teardown();
  });

  describe('admin API: the token', () => {
    it('is generated once (hashed at rest), turns JIT off, and is audited', async () => {
      const created = await generateToken(okta.id);
      oktaToken = created.token;
      expect(oktaToken).toMatch(/^folio_scim_/);
      expect(created.jitDisabled).toBe(true);
      expect(created.status).toMatchObject({ enabled: true, users: 0, groups: 0, baseUrl: expect.stringMatching(/\/scim\/v2$/) });
      expect((await providers.getProviderById(okta.id))!.jitEnabled).toBe(false);
      const stored = await query<{ token_hash: string }>('SELECT token_hash FROM scim_tokens WHERE provider_id = $1', [okta.id]);
      expect(stored).toHaveLength(1);
      expect(stored[0].token_hash).not.toContain(oktaToken);
      const [event] = await waitForAudit('scim.token_rotate', 'okta');
      expect(event.meta).toMatchObject({ rotated: false, jitDisabled: true });
      expect(JSON.stringify(event.meta)).not.toContain(oktaToken);

      const status = await app.inject({ method: 'GET', url: `/api/admin/auth/providers/${okta.id}/scim`, headers: { cookie: adminCookie } });
      expect(status.json()).toMatchObject({ enabled: true, token: { prefix: oktaToken.slice(0, 15) } });
      expect(status.body).not.toContain(oktaToken);

      entraToken = (await generateToken(entra.id)).token;
    });

    it('JIT cannot be turned back on while SCIM is on', async () => {
      const res = await app.inject({ method: 'PATCH', url: `/api/admin/auth/providers/${okta.id}`, headers: { cookie: adminCookie }, payload: { jitEnabled: true } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/SCIM/);
      const list = await app.inject({ method: 'GET', url: '/api/admin/auth/providers', headers: { cookie: adminCookie } });
      expect(list.json().providers.find((p: Json) => p.slug === 'okta').scimEnabled).toBe(true);
    });

    it('is instance admin + cookie only', async () => {
      const bob = await store.createUser({ email: 'plain@admin.local', name: 'Plain', passwordHash: 'x', isAdmin: false });
      const res = await app.inject({ method: 'POST', url: `/api/admin/auth/providers/${okta.id}/scim/token`, headers: { cookie: `${session.SESSION_COOKIE_NAME}=${await login(bob.id)}` } });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('discovery', () => {
    it('ServiceProviderConfig, ResourceTypes and Schemas answer in application/scim+json', async () => {
      const spc = await scim('GET', '/ServiceProviderConfig', null);
      expect(spc.status).toBe(200);
      expect(spc.headers['content-type']).toContain('application/scim+json');
      expect(spc.body).toMatchObject({ patch: { supported: true }, bulk: { supported: false }, filter: { supported: true, maxResults: 200 } });
      const types = await scim('GET', '/ResourceTypes', oktaToken);
      expect(types.body.Resources.map((r: Json) => r.id)).toEqual(['User', 'Group']);
      const schemas = await scim('GET', '/Schemas', oktaToken);
      expect(schemas.body.totalResults).toBe(2);
    });
  });

  describe('Okta sequence', () => {
    let adaId: string;
    let bobId: string;
    let groupId: string;

    it('lists, filters (nothing yet), creates a user, finds it by userName and work email', async () => {
      const first = await scim('GET', '/Users?count=1&startIndex=1', oktaToken);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 0, startIndex: 1, Resources: [] });
      const none = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "ada@example.com"')}&startIndex=1&count=100`, oktaToken);
      expect(none.body.totalResults).toBe(0);

      const created = await scim('POST', '/Users', oktaToken, {
        schemas: [USER],
        userName: 'ada@example.com',
        name: { givenName: 'Ada', familyName: 'Lovelace' },
        emails: [{ primary: true, value: 'ada@example.com', type: 'work' }],
        displayName: 'Ada Lovelace',
        locale: 'en-US',
        externalId: '00u1ada',
        groups: [],
        password: { value: 'ignored-by-folio' },
        active: true,
      });
      expect(created.status).toBe(201);
      expect(created.headers.location).toBe(created.body.meta.location);
      expect(created.body).toMatchObject({ userName: 'ada@example.com', externalId: '00u1ada', active: true, displayName: 'Ada Lovelace', name: { givenName: 'Ada', familyName: 'Lovelace' } });
      adaId = created.body.id;
      const row = await queryOne<{ password_hash: string | null; is_admin: boolean }>('SELECT password_hash, is_admin FROM users WHERE id = $1', [adaId]);
      expect(row).toEqual({ password_hash: null, is_admin: false });
      const identity = await queryOne<Json>('SELECT issuer, subject, scim_provisioned FROM user_identities WHERE user_id = $1', [adaId]);
      expect(identity).toEqual({ issuer: `urn:folio:scim:${okta.id}`, subject: adaId, scim_provisioned: true });
      const [event] = await waitForAudit('scim.user_create', adaId);
      expect(event.actor_id).toBeNull();
      expect(event.meta).toMatchObject({ provider: 'okta', email: 'ada@example.com' });

      const byName = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "ADA@example.com"')}`, oktaToken);
      expect(byName.body.totalResults).toBe(1);
      expect(byName.body.Resources[0].id).toBe(adaId);
      const byEmail = await scim('GET', `/Users?filter=${encodeURIComponent('emails[type eq "work"].value eq "ada@example.com"')}`, oktaToken);
      expect(byEmail.body.Resources[0].id).toBe(adaId);

      const again = await scim('POST', '/Users', oktaToken, { schemas: [USER], userName: 'ada@example.com', emails: [{ value: 'ada@example.com', type: 'work' }] });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ schemas: [ERROR], status: '409', scimType: 'uniqueness' });

      const bob = await scim('POST', '/Users', oktaToken, { schemas: [USER], userName: 'bob@example.com', name: { givenName: 'Bob', familyName: 'Byte' }, emails: [{ primary: true, value: 'bob@example.com', type: 'work' }], active: true });
      expect(bob.status).toBe(201);
      bobId = bob.body.id;
    });

    it('PUT replaces the profile', async () => {
      const res = await scim('PUT', `/Users/${adaId}`, oktaToken, {
        schemas: [USER],
        id: adaId,
        userName: 'ada@example.com',
        name: { givenName: 'Ada', familyName: 'King' },
        emails: [{ primary: true, value: 'ada@example.com', type: 'work' }],
        active: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.displayName).toBe('Ada King');
      expect((await store.findUserById(adaId))!.name).toBe('Ada King');
      await waitForAudit('scim.user_update', adaId);
    });

    it('PATCH active:false deactivates and revokes every session and PAT; active:true re-enables', async () => {
      const sessionToken = await login(adaId);
      const pat = await store.createApiToken(adaId, 'ci', ['read']);
      const res = await scim('PATCH', `/Users/${adaId}`, oktaToken, { schemas: [PATCH_OP], Operations: [{ op: 'replace', value: { active: false } }] });
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);
      expect(await store.resolveSessionUserId(sessionToken)).toBeUndefined();
      expect(await store.resolveApiToken(pat.token)).toBeUndefined();
      expect((await store.findUserById(adaId))!.disabled).toBe(true);
      expect((await waitForAudit('scim.user_disable', adaId))[0].meta).toMatchObject({ provider: 'okta' });
      expect((await waitForAudit('user.disable', adaId))[0].meta).toMatchObject({ sessions: 1, apiTokens: 1 });

      const back = await scim('PATCH', `/Users/${adaId}`, oktaToken, { schemas: [PATCH_OP], Operations: [{ op: 'replace', value: { active: true } }] });
      expect(back.body.active).toBe(true);
      expect((await store.findUserById(adaId))!.disabled).toBe(false);
      await waitForAudit('scim.user_enable', adaId);
    });

    it('creates a group with members, renames it, adds and removes members, replaces them (PUT), deletes = archives', async () => {
      const created = await scim('POST', '/Groups', oktaToken, { schemas: [GROUP], displayName: 'Engineering', members: [{ value: adaId, display: 'ada@example.com' }] });
      expect(created.status).toBe(201);
      groupId = created.body.id;
      expect(created.body.members.map((m: Json) => m.value)).toEqual([adaId]);
      expect(await queryOne('SELECT source, slug, scim_provider_id FROM groups WHERE id = $1', [groupId])).toEqual({ source: 'scim', slug: 'engineering', scim_provider_id: okta.id });
      expect(await queryOne('SELECT source FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, adaId])).toEqual({ source: 'scim' });
      await waitForAudit('scim.group_create', groupId);
      await waitForAudit('scim.member_add', groupId);

      const renamed = await scim('PATCH', `/Groups/${groupId}`, oktaToken, { schemas: [PATCH_OP], Operations: [{ op: 'replace', value: { id: groupId, displayName: 'Eng' } }] });
      expect(renamed.status).toBe(200);
      expect(renamed.body.displayName).toBe('Eng');
      await waitForAudit('scim.group_update', groupId);

      const add = await scim('PATCH', `/Groups/${groupId}`, oktaToken, { schemas: [PATCH_OP], Operations: [{ op: 'add', path: 'members', value: [{ value: bobId, display: 'bob@example.com' }] }] });
      expect(add.status).toBe(204);
      const remove = await scim('PATCH', `/Groups/${groupId}`, oktaToken, { schemas: [PATCH_OP], Operations: [{ op: 'remove', path: `members[value eq "${adaId}"]` }] });
      expect(remove.status).toBe(204);
      let group = await scim('GET', `/Groups/${groupId}`, oktaToken);
      expect(group.body.members.map((m: Json) => m.value)).toEqual([bobId]);
      expect((await waitForAudit('scim.member_remove', groupId))[0].meta).toMatchObject({ targetUserId: adaId, provider: 'okta' });

      const put = await scim('PUT', `/Groups/${groupId}`, oktaToken, { schemas: [GROUP], id: groupId, displayName: 'Eng', members: [{ value: adaId }] });
      expect(put.status).toBe(200);
      expect(put.body.members.map((m: Json) => m.value)).toEqual([adaId]);

      const list = await scim('GET', `/Groups?filter=${encodeURIComponent('displayName eq "eng"')}`, oktaToken);
      expect(list.body.totalResults).toBe(1);

      const del = await scim('DELETE', `/Groups/${groupId}`, oktaToken);
      expect(del.status).toBe(204);
      expect((await queryOne<{ archived_at: string | null }>('SELECT archived_at FROM groups WHERE id = $1', [groupId]))!.archived_at).not.toBeNull();
      expect((await scim('GET', `/Groups/${groupId}`, oktaToken)).status).toBe(404);
      await waitForAudit('scim.group_archive', groupId);
    });

    it('a local membership is left alone: not converted, not removed by SCIM', async () => {
      const g = await scim('POST', '/Groups', oktaToken, { schemas: [GROUP], displayName: 'Design', members: [] });
      await query("INSERT INTO group_members (group_id, user_id, source) VALUES ($1, $2, 'local')", [g.body.id, bobId]);
      await scim('PATCH', `/Groups/${g.body.id}`, oktaToken, { schemas: [PATCH_OP], Operations: [{ op: 'add', path: 'members', value: [{ value: bobId }] }] });
      await scim('PATCH', `/Groups/${g.body.id}`, oktaToken, { schemas: [PATCH_OP], Operations: [{ op: 'replace', path: 'members', value: [] }] });
      expect(await queryOne('SELECT source FROM group_members WHERE group_id = $1 AND user_id = $2', [g.body.id, bobId])).toEqual({ source: 'local' });
    });
  });

  describe('Entra ID sequence', () => {
    let userId: string;

    it('creates a user (enterprise schema, externalId), patches with "Replace"/"False" and path-less dotted keys', async () => {
      const none = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "grace@contoso.com"')}`, entraToken);
      expect(none.body.totalResults).toBe(0);
      const created = await scim('POST', '/Users', entraToken, {
        schemas: [USER, 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'],
        externalId: 'grace',
        userName: 'grace@contoso.com',
        active: true,
        displayName: 'Grace Hopper',
        emails: [{ primary: true, type: 'work', value: 'grace@contoso.com' }],
        meta: { resourceType: 'User' },
        name: { formatted: 'Grace Hopper', familyName: 'Hopper', givenName: 'Grace' },
        roles: [],
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'Navy' },
      });
      expect(created.status).toBe(201);
      userId = created.body.id;
      expect((await scim('GET', `/Users?filter=${encodeURIComponent('externalId eq "grace"')}`, entraToken)).body.Resources[0].id).toBe(userId);

      const patched = await scim('PATCH', `/Users/${userId}`, entraToken, {
        schemas: [PATCH_OP],
        Operations: [
          { op: 'Replace', path: 'displayName', value: 'Rear Admiral Hopper' },
          { op: 'Add', path: 'emails[type eq "work"].value', value: 'grace.hopper@contoso.com' },
          { op: 'Replace', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'USN' },
          { op: 'Replace', value: { 'name.givenName': 'Grace B.', title: 'RADM' } },
        ],
      });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ displayName: 'Rear Admiral Hopper', emails: [{ value: 'grace.hopper@contoso.com' }], name: { givenName: 'Grace B.' } });
      expect((await store.findUserById(userId))!.email).toBe('grace.hopper@contoso.com');

      const session1 = await login(userId);
      const off = await scim('PATCH', `/Users/${userId}`, entraToken, { schemas: [PATCH_OP], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] });
      expect(off.body.active).toBe(false);
      expect(await store.resolveSessionUserId(session1)).toBeUndefined();
      const on = await scim('PATCH', `/Users/${userId}`, entraToken, { schemas: [PATCH_OP], Operations: [{ op: 'Replace', path: 'active', value: 'True' }] });
      expect(on.body.active).toBe(true);
    });

    it('groups: create with externalId, filter without members, add / remove with value arrays, membership filter, delete, revive', async () => {
      const created = await scim('POST', '/Groups', entraToken, { schemas: [GROUP], externalId: 'aad-group-1', displayName: 'Ops', members: [], meta: { resourceType: 'Group' } });
      expect(created.status).toBe(201);
      const gid = created.body.id;
      const found = await scim('GET', `/Groups?excludedAttributes=members&filter=${encodeURIComponent('displayName eq "Ops"')}`, entraToken);
      expect(found.body.totalResults).toBe(1);
      expect(found.body.Resources[0].members).toBeUndefined();

      const add = await scim('PATCH', `/Groups/${gid}`, entraToken, { schemas: [PATCH_OP], Operations: [{ op: 'Add', path: 'members', value: [{ value: userId }] }] });
      expect(add.status).toBe(204);
      const isMember = await scim('GET', `/Groups?excludedAttributes=members&filter=${encodeURIComponent(`id eq "${gid}" and members[value eq "${userId}"]`)}`, entraToken);
      expect(isMember.body.totalResults).toBe(1);
      const rm = await scim('PATCH', `/Groups/${gid}`, entraToken, { schemas: [PATCH_OP], Operations: [{ op: 'Remove', path: 'members', value: [{ value: userId }] }] });
      expect(rm.status).toBe(204);
      expect((await scim('GET', `/Groups?filter=${encodeURIComponent(`id eq "${gid}" and members[value eq "${userId}"]`)}`, entraToken)).body.totalResults).toBe(0);

      expect((await scim('DELETE', `/Groups/${gid}`, entraToken)).status).toBe(204);
      const revived = await scim('POST', '/Groups', entraToken, { schemas: [GROUP], externalId: 'aad-group-1', displayName: 'Ops', members: [{ value: userId }] });
      expect(revived.status).toBe(201);
      expect(revived.body.id).toBe(gid);
    });

    it('DELETE /Users deactivates (never deletes) and hides the account; a new POST revives it', async () => {
      const sess = await login(userId);
      expect((await scim('DELETE', `/Users/${userId}`, entraToken)).status).toBe(204);
      expect(await store.resolveSessionUserId(sess)).toBeUndefined();
      expect((await store.findUserById(userId))!.disabled).toBe(true);
      expect((await scim('GET', `/Users/${userId}`, entraToken)).status).toBe(404);
      expect((await waitForAudit('scim.user_disable', userId)).some((e) => e.meta?.deleted === true)).toBe(true);
      const back = await scim('POST', '/Users', entraToken, { schemas: [USER], externalId: 'grace', userName: 'grace.hopper@contoso.com', emails: [{ type: 'work', value: 'grace.hopper@contoso.com' }], active: true });
      expect(back.status).toBe(201);
      expect(back.body.id).toBe(userId);
      expect((await store.findUserById(userId))!.disabled).toBe(false);
    });
  });

  describe('token authentication and scope', () => {
    it('missing / wrong token -> 401 in the SCIM error format', async () => {
      __resetRateLimitsForTests();
      const missing = await scim('GET', '/Users', null);
      expect(missing.status).toBe(401);
      expect(missing.headers['www-authenticate']).toContain('Bearer');
      expect(missing.body).toMatchObject({ schemas: [ERROR], status: '401' });
      expect((await scim('GET', '/Users', 'folio_scim_not-a-real-token')).status).toBe(401);
      const basic = await app.inject({ method: 'GET', url: '/scim/v2/Users', headers: { authorization: 'Basic dXNlcjpwYXNz' } });
      expect(basic.statusCode).toBe(401);
    });

    it('a rotated or revoked token stops working', async () => {
      const temp = await providers.createProvider({ slug: 'temp', displayName: 'Temp', issuer: 'https://temp.test', clientId: 'c' });
      const first = (await generateToken(temp.id)).token;
      expect((await scim('GET', '/Users', first)).status).toBe(200);
      const second = await generateToken(temp.id);
      expect(second.status.enabled).toBe(true);
      expect((await scim('GET', '/Users', first)).status).toBe(401);
      expect((await scim('GET', '/Users', second.token)).status).toBe(200);
      expect((await waitForAudit('scim.token_rotate', 'temp')).some((e) => e.meta?.rotated === true)).toBe(true);
      const revoked = await app.inject({ method: 'DELETE', url: `/api/admin/auth/providers/${temp.id}/scim/token`, headers: { cookie: adminCookie } });
      expect(revoked.json().enabled).toBe(false);
      expect((await scim('GET', '/Users', second.token)).status).toBe(401);
      await waitForAudit('scim.token_revoke', 'temp');
    });

    it("never sees or touches another provider's users and groups, unlinked local accounts or is_admin", async () => {
      const oktaUsers = await scim('GET', '/Users', oktaToken);
      const entraUser = (await scim('GET', '/Users', entraToken)).body.Resources[0];
      expect(oktaUsers.body.Resources.map((u: Json) => u.id)).not.toContain(entraUser.id);
      expect((await scim('GET', `/Users/${entraUser.id}`, oktaToken)).status).toBe(404);
      expect((await scim('PATCH', `/Users/${entraUser.id}`, oktaToken, { schemas: [PATCH_OP], Operations: [{ op: 'replace', path: 'active', value: false }] })).status).toBe(404);
      expect((await scim('DELETE', `/Users/${entraUser.id}`, oktaToken)).status).toBe(404);
      expect((await store.findUserById(entraUser.id))!.disabled).toBe(false);

      const entraGroup = (await scim('GET', '/Groups', entraToken)).body.Resources[0];
      expect((await scim('GET', `/Groups/${entraGroup.id}`, oktaToken)).status).toBe(404);
      expect((await scim('DELETE', `/Groups/${entraGroup.id}`, oktaToken)).status).toBe(404);
      // An Okta group cannot take an Entra user as a member.
      const g = await scim('POST', '/Groups', oktaToken, { schemas: [GROUP], displayName: 'Mixed', members: [{ value: entraUser.id }] });
      expect(g.status).toBe(400);

      // A local group is invisible.
      const local = await queryOne<{ id: string }>("INSERT INTO groups (slug, name) VALUES ('local-team', 'Local team') RETURNING id");
      expect((await scim('GET', `/Groups/${local!.id}`, oktaToken)).status).toBe(404);

      // A local admin in the provider's domain is not visible, and a PUT never sets is_admin.
      await store.createUser({ email: 'boss@example.com', name: 'Boss', passwordHash: 'x', isAdmin: true });
      expect((await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "boss@example.com"')}`, oktaToken)).body.totalResults).toBe(0);
      const someone = oktaUsers.body.Resources[0];
      await scim('PUT', `/Users/${someone.id}`, oktaToken, { schemas: [USER], userName: someone.userName, emails: someone.emails, isAdmin: true, roles: [{ value: 'admin' }], active: true });
      expect((await store.findUserById(someone.id))!.isAdmin).toBe(false);
    });

    it('adopts an unlinked account in an allowed domain, but never an instance admin or another provider\'s person', async () => {
      const local = await store.createUser({ email: 'carol@example.com', name: 'Carol', passwordHash: 'x', isAdmin: false });
      const adopted = await scim('POST', '/Users', oktaToken, { schemas: [USER], userName: 'carol@example.com', emails: [{ type: 'work', value: 'carol@example.com' }], active: true });
      expect(adopted.status).toBe(201);
      expect(adopted.body.id).toBe(local.id);
      expect((await waitForAudit('scim.user_create', local.id))[0].meta).toMatchObject({ via: 'adopted' });

      const admin = await scim('POST', '/Users', oktaToken, { schemas: [USER], userName: 'boss@example.com', emails: [{ type: 'work', value: 'boss@example.com' }] });
      expect(admin.status).toBe(409);
      expect(admin.body.detail).toMatch(/administrator/);

      const other = await scim('POST', '/Users', oktaToken, { schemas: [USER], userName: 'outsider@elsewhere.org', emails: [{ type: 'work', value: 'outsider@elsewhere.org' }] });
      expect(other.status).toBe(400); // not in the allowed domains
    });
  });

  describe('malformed payloads -> SCIM errors', () => {
    it('answers 400 with scimType for bad JSON, bad bodies, bad PATCH ops and unsupported filters', async () => {
      const badJson = await scim('POST', '/Users', oktaToken, '{"userName": ');
      expect(badJson.status).toBe(400);
      expect(badJson.body).toMatchObject({ schemas: [ERROR], status: '400', scimType: 'invalidSyntax' });
      const badJsonPlain = await scim('POST', '/Users', oktaToken, '{nope', 'application/json');
      expect(badJsonPlain.body).toMatchObject({ status: '400', scimType: 'invalidSyntax' });

      const noUserName = await scim('POST', '/Users', oktaToken, { schemas: [USER], emails: [{ value: 'x@example.com' }] });
      expect(noUserName.body).toMatchObject({ status: '400', scimType: 'invalidValue' });
      expect(noUserName.body.detail).toMatch(/userName/);
      const noEmail = await scim('POST', '/Users', oktaToken, { schemas: [USER], userName: 'not-an-email' });
      expect(noEmail.status).toBe(400);
      const badActive = await scim('POST', '/Users', oktaToken, { schemas: [USER], userName: 'dan@example.com', active: 'maybe' });
      expect(badActive.body).toMatchObject({ status: '400', scimType: 'invalidValue' });
      const arrayBody = await scim('POST', '/Users', oktaToken, [1, 2]);
      expect(arrayBody.body).toMatchObject({ status: '400', scimType: 'invalidSyntax' });

      const someone = (await scim('GET', '/Users?count=1', oktaToken)).body.Resources[0];
      const badOp = await scim('PATCH', `/Users/${someone.id}`, oktaToken, { schemas: [PATCH_OP], Operations: [{ op: 'move', path: 'active', value: false }] });
      expect(badOp.body).toMatchObject({ status: '400', scimType: 'invalidSyntax' });
      const noOps = await scim('PATCH', `/Users/${someone.id}`, oktaToken, { schemas: [PATCH_OP], Operations: [] });
      expect(noOps.status).toBe(400);
      const badBool = await scim('PATCH', `/Users/${someone.id}`, oktaToken, { schemas: [PATCH_OP], Operations: [{ op: 'replace', path: 'active', value: 'nope' }] });
      expect(badBool.body.scimType).toBe('invalidValue');

      const co = await scim('GET', `/Users?filter=${encodeURIComponent('userName co "a"')}`, oktaToken);
      expect(co.body).toMatchObject({ status: '400', scimType: 'invalidFilter' });
      const or = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "a" or userName eq "b"')}`, oktaToken);
      expect(or.body.scimType).toBe('invalidFilter');
      const unknownAttr = await scim('GET', `/Users?filter=${encodeURIComponent('nickName eq "a"')}`, oktaToken);
      expect(unknownAttr.body.scimType).toBe('invalidFilter');

      const notFound = await scim('GET', '/Users/00000000-0000-4000-8000-000000000000', oktaToken);
      expect(notFound.body).toMatchObject({ schemas: [ERROR], status: '404' });
      const unknownRoute = await scim('GET', '/Bulk', oktaToken);
      expect(unknownRoute.status).toBe(404);
      expect(unknownRoute.headers['content-type']).toContain('application/scim+json');

      const badMember = await scim('POST', '/Groups', oktaToken, { schemas: [GROUP], displayName: 'X', members: [{ display: 'no value' }] });
      expect(badMember.status).toBe(400);
      const groupNoName = await scim('POST', '/Groups', oktaToken, { schemas: [GROUP] });
      expect(groupNoName.body.scimType).toBe('invalidValue');
    });

    it('parses the filter subset', () => {
      expect(parseScimFilter('userName eq "a@b.c"')).toEqual([{ attr: 'username', value: 'a@b.c' }]);
      expect(parseScimFilter('emails[type eq "work"].value eq "x"')).toEqual([{ attr: 'emails.value', value: 'x' }]);
      expect(parseScimFilter('id eq "g" and members[value eq "u"]')).toEqual([
        { attr: 'id', value: 'g' },
        { attr: 'members.value', value: 'u' },
      ]);
      expect(parseScimFilter('displayName eq "R&D and Ops"')).toEqual([{ attr: 'displayname', value: 'R&D and Ops' }]);
      expect(parseScimFilter('urn:ietf:params:scim:schemas:core:2.0:User:userName eq "q"')).toEqual([{ attr: 'username', value: 'q' }]);
      expect(() => parseScimFilter('(userName eq "a")')).toThrow();
    });
  });

  describe('last-admin guards', () => {
    it('refuses to remove the only admin of a space held through a SCIM group, and to archive that group (409 mutability)', async () => {
      const u = await scim('POST', '/Users', oktaToken, { schemas: [USER], userName: 'erin@example.com', emails: [{ type: 'work', value: 'erin@example.com' }] });
      const g = await scim('POST', '/Groups', oktaToken, { schemas: [GROUP], displayName: 'Space admins', members: [{ value: u.body.id }] });
      await query("INSERT INTO spaces (slug, name) VALUES ('scim-space', 'SCIM space')");
      await query("INSERT INTO space_group_roles (space_slug, group_id, role) VALUES ('scim-space', $1, 'admin')", [g.body.id]);

      const remove = await scim('PATCH', `/Groups/${g.body.id}`, oktaToken, { schemas: [PATCH_OP], Operations: [{ op: 'remove', path: 'members', value: [{ value: u.body.id }] }] });
      expect(remove.status).toBe(409);
      expect(remove.body).toMatchObject({ schemas: [ERROR], status: '409', scimType: 'mutability' });
      expect(remove.body.detail).toContain('scim-space');
      expect(await queryOne('SELECT 1 AS one FROM group_members WHERE group_id = $1 AND user_id = $2', [g.body.id, u.body.id])).toEqual({ one: 1 });

      const del = await scim('DELETE', `/Groups/${g.body.id}`, oktaToken);
      expect(del.status).toBe(409);
      expect((await queryOne<{ archived_at: string | null }>('SELECT archived_at FROM groups WHERE id = $1', [g.body.id]))!.archived_at).toBeNull();
    });

    it('refuses to deactivate the last active instance admin', async () => {
      const temp = await providers.createProvider({ slug: 'admins', displayName: 'Admins IdP', issuer: 'https://admins.test', clientId: 'c' });
      const token = (await generateToken(temp.id)).token;
      const [root] = await query<{ id: string }>("SELECT id FROM users WHERE email = 'root@admin.local'");
      await query("UPDATE users SET disabled = true WHERE is_admin AND id <> $1", [root.id]);
      await providers.createIdentity({ userId: root.id, providerId: temp.id, issuer: 'https://admins.test', subject: 'root', email: 'root@admin.local', groups: undefined });
      const res = await scim('PATCH', `/Users/${root.id}`, token, { schemas: [PATCH_OP], Operations: [{ op: 'replace', path: 'active', value: false }] });
      expect(res.status).toBe(409);
      expect(res.body.scimType).toBe('mutability');
      expect((await store.findUserById(root.id))!.disabled).toBe(false);
    });
  });

  describe('first sign-in of a SCIM-created account (sso.ts)', () => {
    it('matches by externalId = subject; the placeholder becomes the real identity', async () => {
      const created = await scim('POST', '/Users', oktaToken, { schemas: [USER], userName: 'finn@example.com', externalId: '00u9finn', emails: [{ type: 'work', value: 'finn@example.com' }] });
      const outcome = await resolveSsoSignIn(okta, 'https://okta.test', claims('00u9finn', 'finn@example.com', false));
      expect(outcome).toEqual({ kind: 'login', userId: created.body.id, how: 'linked' });
      const identities = await query<Json>('SELECT issuer, subject, scim_provisioned FROM user_identities WHERE user_id = $1', [created.body.id]);
      expect(identities).toEqual([{ issuer: 'https://okta.test', subject: '00u9finn', scim_provisioned: true }]);
      // Still the same SCIM user afterwards.
      expect((await scim('GET', `/Users/${created.body.id}`, oktaToken)).body.externalId).toBe('00u9finn');
      expect(await resolveSsoSignIn(okta, 'https://okta.test', claims('00u9finn', 'finn@example.com'))).toMatchObject({ kind: 'login', how: 'existing' });
    });

    it('SAML: matches the NameID against the SCIM userName', async () => {
      const created = await scim('POST', '/Users', entraToken, { schemas: [USER], userName: 'hedy@contoso.com', externalId: 'hedy', emails: [{ type: 'work', value: 'hedy@contoso.com' }] });
      const asSaml: AuthProvider = { ...entra, kind: 'saml' };
      expect(await resolveSsoSignIn(asSaml, 'https://sts.entra.test/tenant/', claims('HEDY@contoso.com', 'hedy@contoso.com', false))).toEqual({
        kind: 'login',
        userId: created.body.id,
        how: 'linked',
      });
    });

    it('a verified email completes the placeholder too (not an "already linked" refusal, no second identity)', async () => {
      const created = await scim('POST', '/Users', oktaToken, { schemas: [USER], userName: 'gina@example.com', emails: [{ type: 'work', value: 'gina@example.com' }] });
      expect(await resolveSsoSignIn(okta, 'https://okta.test', claims('00uOther', 'gina@example.com', true))).toMatchObject({ kind: 'login', userId: created.body.id, how: 'linked' });
      expect((await query('SELECT 1 FROM user_identities WHERE user_id = $1', [created.body.id])).length).toBe(1);
    });

    describe('placeholder matched by email (Entra over OIDC: no email_verified, per-app sub)', () => {
      const entraIssuer = 'https://login.entra.test/tenant/v2.0';

      it('matches the SCIM email without email_verified, completes the placeholder and audits via scim_email', async () => {
        const created = await scim('POST', '/Users', entraToken, { schemas: [USER], userName: 'ivy@contoso.com', externalId: 'entra-obj-ivy', emails: [{ type: 'work', value: 'ivy@contoso.com' }] });
        const outcome = await resolveSsoSignIn(entra, entraIssuer, claims('per-app-sub-ivy', 'Ivy@Contoso.com', false));
        expect(outcome).toEqual({ kind: 'login', userId: created.body.id, how: 'linked', via: 'scim_email' });
        const identities = await query<Json>('SELECT issuer, subject, scim_provisioned FROM user_identities WHERE user_id = $1', [created.body.id]);
        expect(identities).toEqual([{ issuer: entraIssuer, subject: 'per-app-sub-ivy', scim_provisioned: true }]);
        expect(await resolveSsoSignIn(entra, entraIssuer, claims('per-app-sub-ivy', 'ivy@contoso.com', false))).toMatchObject({ kind: 'login', how: 'existing' });
      });

      it('matches the SCIM userName when it differs from the email (UPN vs mail is not guessed: exact only)', async () => {
        const created = await scim('POST', '/Users', entraToken, { schemas: [USER], userName: 'jo.upn@contoso.com', externalId: 'entra-obj-jo', emails: [{ type: 'work', value: 'jo@contoso.com' }] });
        expect(await resolveSsoSignIn(entra, entraIssuer, claims('sub-jo-1', 'jo.other@contoso.com', false))).toMatchObject({ kind: 'refuse', reason: 'no_account' });
        expect(await resolveSsoSignIn(entra, entraIssuer, claims('sub-jo-2', 'jo@contoso.com', false))).toEqual({ kind: 'login', userId: created.body.id, how: 'linked', via: 'scim_email' });
      });

      it("does not match another provider's placeholder", async () => {
        const created = await scim('POST', '/Users', oktaToken, { schemas: [USER], userName: 'kit@example.com', externalId: '00uKit', emails: [{ type: 'work', value: 'kit@example.com' }] });
        const other = await providers.createProvider({ slug: 'other-oidc', displayName: 'Other', issuer: 'https://other.test', clientId: 'other-client', allowedDomains: ['example.com'] });
        expect(await resolveSsoSignIn(other, 'https://other.test', claims('o-kit', 'kit@example.com', false))).toMatchObject({ kind: 'refuse', reason: 'link_unverified' });
        expect((await query<Json>('SELECT issuer FROM user_identities WHERE user_id = $1', [created.body.id]))[0].issuer).toBe(`urn:folio:scim:${okta.id}`);
      });

      it('refuses when the email domain is not allowed for the provider', async () => {
        const created = await scim('POST', '/Users', entraToken, { schemas: [USER], userName: 'lou@contoso.com', externalId: 'entra-obj-lou', emails: [{ type: 'work', value: 'lou@contoso.com' }] });
        const narrowed: AuthProvider = { ...entra, allowedDomains: ['fabrikam.com'] };
        expect(await resolveSsoSignIn(narrowed, entraIssuer, claims('sub-lou', 'lou@contoso.com', false))).toMatchObject({ kind: 'refuse', reason: 'domain' });
        expect((await query<Json>('SELECT issuer FROM user_identities WHERE user_id = $1', [created.body.id]))[0].issuer).toBe(`urn:folio:scim:${entra.id}`);
      });

      it('refuses a deactivated SCIM user', async () => {
        const created = await scim('POST', '/Users', entraToken, { schemas: [USER], userName: 'max@contoso.com', externalId: 'entra-obj-max', emails: [{ type: 'work', value: 'max@contoso.com' }], active: false });
        expect(await resolveSsoSignIn(entra, entraIssuer, claims('sub-max', 'max@contoso.com', false))).toMatchObject({ kind: 'refuse', reason: 'disabled', userId: created.body.id });
      });

      it('an ordinary account (no placeholder) with the same email is still refused without email_verified', async () => {
        const plain = await store.createUser({ email: 'ned@contoso.com', name: 'Ned', passwordHash: 'x', isAdmin: false });
        expect(await resolveSsoSignIn(entra, entraIssuer, claims('sub-ned', 'ned@contoso.com', false))).toMatchObject({ kind: 'refuse', reason: 'link_unverified', userId: plain.id });
        expect((await query('SELECT 1 FROM user_identities WHERE user_id = $1', [plain.id])).length).toBe(0);
      });
    });

    it('a deactivated SCIM account is refused; JIT never creates accounts while SCIM is on', async () => {
      const created = await scim('POST', '/Users', oktaToken, { schemas: [USER], userName: 'hal@example.com', externalId: '00uHal', emails: [{ type: 'work', value: 'hal@example.com' }], active: false });
      expect(await resolveSsoSignIn(okta, 'https://okta.test', claims('00uHal', 'hal@example.com'))).toMatchObject({ kind: 'refuse', reason: 'disabled', userId: created.body.id });
      const jitOn: AuthProvider = { ...okta, jitEnabled: true };
      expect(await resolveSsoSignIn(jitOn, 'https://okta.test', claims('00uNew', 'newcomer@example.com'))).toMatchObject({ kind: 'refuse', reason: 'no_account' });
      expect(await store.findStoredUserByEmail('newcomer@example.com')).toBeUndefined();
    });
  });

  it('records the last sync and counts for the admin panel', async () => {
    const status = await app.inject({ method: 'GET', url: `/api/admin/auth/providers/${okta.id}/scim`, headers: { cookie: adminCookie } });
    const body = status.json();
    expect(body.lastSyncAt).not.toBeNull();
    expect(body.users).toBeGreaterThan(3);
    expect(body.groups).toBeGreaterThanOrEqual(2);
  });

  it('rate-limits a token (429 with Retry-After)', async () => {
    __resetRateLimitsForTests();
    process.env.FOLIO_SCIM_RATE_PER_MINUTE = '3';
    try {
      for (let i = 0; i < 3; i++) expect((await scim('GET', '/Users?count=0', oktaToken)).status).toBe(200);
      const limited = await scim('GET', '/Users?count=0', oktaToken);
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(limited.body).toMatchObject({ schemas: [ERROR], status: '429' });
    } finally {
      delete process.env.FOLIO_SCIM_RATE_PER_MINUTE;
      __resetRateLimitsForTests();
    }
  });
});
