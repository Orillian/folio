/**
 * Stage 4 of groups + SSO: deactivation hygiene, session management, the audit log API.
 * Real PG (per-file schema) + Fastify inject; sockets are fakes registered in liveConnections.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema } from '../db/testSchema.js';
import { query } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { liveConnectionCount, trackConnection } from '../liveConnections.js';
import * as oauthStore from '../oauth/store.js';
import { registerAuditRoutes } from '../auditRoutes.js';
import { AUDIT_CSV_HEADER, auditCsvChunks, csvCell, listAuditEvents } from '../auditLog.js';
import { recordAudit } from '../audit.js';
import { registerProtectedAuthRoutes } from './routes.js';
import { registerSessionRoutes } from './sessionRoutes.js';
import * as session from './session.js';
import * as store from './store.js';

const fastifyCookie = fastifyCookieModule.default;

class FakeSocket {
  closed: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Array<() => void>>();
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    for (const l of this.listeners.get('close') ?? []) l();
  }
  terminate(): void {}
  on(event: string, listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
}

async function waitForAudit(action: string, target?: string): Promise<Array<{ actor_id: string | null; target: string | null; meta: Record<string, unknown> | null }>> {
  for (let i = 0; i < 50; i++) {
    const rows = await query<{ actor_id: string | null; target: string | null; meta: Record<string, unknown> | null }>(
      'SELECT actor_id, target, meta FROM audit_log WHERE action = $1 AND ($2::text IS NULL OR target = $2) ORDER BY id',
      [action, target ?? null],
    );
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return [];
}

describe('stage 4: deactivation, sessions, audit log (real PG)', () => {
  let teardown: () => Promise<void>;
  let app: FastifyInstance;
  let admin: { id: string; cookie: string; token: string };

  async function newUser(email: string, isAdmin = false) {
    return store.createUser({ email: `${email}@stage4.local`, name: email, passwordHash: 'x', isAdmin });
  }
  async function login(userId: string, ua = 'TestAgent/1.0') {
    const { token } = await store.createSession(userId, { userAgent: ua, ip: '203.0.113.7' });
    return { token, cookie: `${session.SESSION_COOKIE_NAME}=${token}` };
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
    await app.register(async (scope) => {
      scope.addHook('onRequest', session.requireSession);
      registerProtectedAuthRoutes(scope);
      registerSessionRoutes(scope);
      registerAuditRoutes(scope);
    });
    await app.ready();
    const a = await newUser('admin', true);
    admin = { id: a.id, ...(await login(a.id)) };
  });

  afterAll(async () => {
    await app.close();
    await teardown();
  });

  afterEach(() => {
    delete process.env.FOLIO_SESSION_TTL_DAYS;
  });

  describe('deactivation hygiene', () => {
    it('disabling revokes sessions, PATs, OAuth grants and live sockets, and audits the counts', async () => {
      const victim = await newUser('victim');
      const s1 = await login(victim.id);
      await login(victim.id);
      const pat = await store.createApiToken(victim.id, 'ci', ['read']);
      const client = await oauthStore.createDcrClient({ clientName: 'Test app', redirectUris: ['https://app.example.com/cb'], clientUri: null });
      const grantId = await oauthStore.createGrant({ userId: victim.id, clientId: client.clientId, scopes: ['read'], resource: 'https://folio.example.com/mcp' });
      const tokens = await oauthStore.issueFirstTokens(grantId);
      const sock = new FakeSocket();
      trackConnection(victim.id, s1.token, sock);
      const other = new FakeSocket();
      trackConnection(admin.id, admin.token, other);

      const res = await app.inject({ method: 'PATCH', url: `/api/users/${victim.id}`, headers: { cookie: admin.cookie }, payload: { disabled: true } });
      expect(res.statusCode).toBe(200);

      expect(await store.resolveSessionUserId(s1.token)).toBeUndefined();
      expect((await query('SELECT 1 FROM sessions WHERE user_id = $1', [victim.id])).length).toBe(0);
      expect(await store.resolveApiToken(pat.token)).toBeUndefined();
      expect(await store.listApiTokens(victim.id)).toHaveLength(0);
      expect(await oauthStore.resolveAccessToken(tokens.accessToken)).toBeUndefined();
      expect(sock.closed?.code).toBe(4401);
      expect(other.closed).toBeNull(); // another user's socket is untouched
      expect(liveConnectionCount(victim.id)).toBe(0);

      const [event] = await waitForAudit('user.disable', victim.id);
      expect(event.actor_id).toBe(admin.id);
      expect(event.meta).toMatchObject({ sessions: 2, apiTokens: 1, oauthGrants: 1, sockets: 1, email: 'victim@stage4.local' });
    });

    it('re-enabling writes user.enable and does not bring revoked credentials back', async () => {
      const u = await newUser('comeback');
      const pat = await store.createApiToken(u.id, 'old', ['read']);
      await store.updateUser(u.id, { disabled: true }, { actorId: admin.id });
      await store.updateUser(u.id, { disabled: false }, { actorId: admin.id });
      const [event] = await waitForAudit('user.enable', u.id);
      expect(event.actor_id).toBe(admin.id);
      expect(await store.resolveApiToken(pat.token)).toBeUndefined();
    });

    it('a repeated disable still sweeps credentials but audits only the state change', async () => {
      const u = await newUser('twice');
      await store.updateUser(u.id, { disabled: true });
      const pat = await store.createApiToken(u.id, 'late', ['read']); // minted while already disabled
      await store.updateUser(u.id, { disabled: true });
      expect(await store.resolveApiToken(pat.token)).toBeUndefined();
      await new Promise((r) => setTimeout(r, 100));
      const rows = await query('SELECT 1 FROM audit_log WHERE action = $1 AND target = $2', ['user.disable', u.id]);
      expect(rows).toHaveLength(1);
    });
  });

  describe('sessions', () => {
    it('FOLIO_SESSION_TTL_DAYS sets the lifetime; garbage falls back to 30 days', () => {
      const day = 24 * 60 * 60 * 1000;
      expect(store.sessionTtlMs()).toBe(30 * day);
      process.env.FOLIO_SESSION_TTL_DAYS = '7';
      expect(store.sessionTtlMs()).toBe(7 * day);
      process.env.FOLIO_SESSION_TTL_DAYS = '0.5';
      expect(store.sessionTtlMs()).toBe(day / 2);
      for (const bad of ['abc', '-3', '0', '']) {
        process.env.FOLIO_SESSION_TTL_DAYS = bad;
        expect(store.sessionTtlMs()).toBe(30 * day);
      }
    });

    it('a new session expires after the configured lifetime and stores a truncated user agent', async () => {
      process.env.FOLIO_SESSION_TTL_DAYS = '2';
      const u = await newUser('ttl');
      const { token, expiresAt } = await store.createSession(u.id, { userAgent: 'A'.repeat(1000), ip: '198.51.100.1' });
      expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(2 * 24 * 3600 * 1000 - 60_000);
      expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(2 * 24 * 3600 * 1000);
      const [info] = await store.listActiveSessions(u.id, token);
      expect(info.userAgent).toHaveLength(300);
      expect(info.ip).toBe('198.51.100.1');
      expect(info.current).toBe(true);
    });

    it('touchSession is throttled and fills in a missing user agent / ip', async () => {
      store.__resetSessionTouchThrottleForTests();
      const u = await newUser('touch');
      const { token } = await store.createSession(u.id);
      await query("UPDATE sessions SET last_seen_at = now() - interval '1 hour' WHERE user_id = $1", [u.id]);
      store.touchSession(token, { userAgent: 'Fox/2', ip: '192.0.2.9' });
      await new Promise((r) => setTimeout(r, 100));
      const [first] = await store.listActiveSessions(u.id);
      expect(first.userAgent).toBe('Fox/2');
      expect(first.ip).toBe('192.0.2.9');
      expect(Date.now() - new Date(first.lastSeenAt!).getTime()).toBeLessThan(5000);

      // within the interval: no second write
      await query("UPDATE sessions SET last_seen_at = now() - interval '1 hour' WHERE user_id = $1", [u.id]);
      store.touchSession(token, { userAgent: 'Fox/2', ip: '192.0.2.9' });
      await new Promise((r) => setTimeout(r, 100));
      const [second] = await store.listActiveSessions(u.id);
      expect(Date.now() - new Date(second.lastSeenAt!).getTime()).toBeGreaterThan(50 * 60 * 1000);
    });

    it('own list marks this device; "sign out other devices" keeps it and closes the others\' sockets', async () => {
      const u = await newUser('multi');
      const here = await login(u.id, 'Here/1');
      const there = await login(u.id, 'There/1');
      const sockHere = new FakeSocket();
      const sockThere = new FakeSocket();
      trackConnection(u.id, here.token, sockHere);
      trackConnection(u.id, there.token, sockThere);

      const list = await app.inject({ method: 'GET', url: '/api/me/sessions', headers: { cookie: here.cookie } });
      const sessions = list.json().sessions as Array<{ userAgent: string; current: boolean }>;
      expect(sessions).toHaveLength(2);
      expect(sessions.find((s) => s.current)?.userAgent).toBe('Here/1');

      const res = await app.inject({ method: 'POST', url: '/api/me/sessions/revoke-others', headers: { cookie: here.cookie } });
      expect(res.json()).toEqual({ revoked: 1 });
      expect(await store.resolveSessionUserId(here.token)).toBe(u.id);
      expect(await store.resolveSessionUserId(there.token)).toBeUndefined();
      expect(sockThere.closed).not.toBeNull();
      expect(sockHere.closed).toBeNull();
      const [event] = await waitForAudit('session.revoke_all', u.id);
      expect(event.meta).toMatchObject({ count: 1, scope: 'others' });
    });

    it('a person revokes one of their own sessions but never somebody else\'s', async () => {
      const a = await newUser('own-a');
      const b = await newUser('own-b');
      const sa = await login(a.id);
      const sb = await login(b.id);
      const bId = (await store.listActiveSessions(b.id))[0].id;
      const aId = (await store.listActiveSessions(a.id))[0].id;

      const cross = await app.inject({ method: 'DELETE', url: `/api/me/sessions/${bId}`, headers: { cookie: sa.cookie } });
      expect(cross.statusCode).toBe(404);
      expect(await store.resolveSessionUserId(sb.token)).toBe(b.id);

      const own = await app.inject({ method: 'DELETE', url: `/api/me/sessions/${aId}`, headers: { cookie: sa.cookie } });
      expect(own.statusCode).toBe(200);
      expect(await store.resolveSessionUserId(sa.token)).toBeUndefined();
      const [event] = await waitForAudit('session.revoke', a.id);
      expect(event.meta).toMatchObject({ sessionId: aId, self: true });
    });

    it('instance admin lists and revokes another person\'s sessions; a non-admin and a PAT cannot', async () => {
      const u = await newUser('managed');
      const s = await login(u.id);
      await login(u.id);
      const ids = (await store.listActiveSessions(u.id)).map((x) => x.id);

      const plain = await newUser('plain');
      const plainSession = await login(plain.id);
      expect((await app.inject({ method: 'GET', url: `/api/users/${u.id}/sessions`, headers: { cookie: plainSession.cookie } })).statusCode).toBe(403);
      const pat = await store.createApiToken(admin.id, 'adm', ['read', 'write']);
      expect((await app.inject({ method: 'GET', url: `/api/users/${u.id}/sessions`, headers: { authorization: `Bearer ${pat.token}` } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/admin/audit', headers: { authorization: `Bearer ${pat.token}` } })).statusCode).toBe(403);

      const list = await app.inject({ method: 'GET', url: `/api/users/${u.id}/sessions`, headers: { cookie: admin.cookie } });
      expect(list.json().sessions).toHaveLength(2);
      expect(list.json().sessions.every((x: { current: boolean }) => !x.current)).toBe(true);

      const one = await app.inject({ method: 'DELETE', url: `/api/users/${u.id}/sessions/${ids[0]}`, headers: { cookie: admin.cookie } });
      expect(one.statusCode).toBe(200);
      expect(await store.listActiveSessions(u.id)).toHaveLength(1);
      expect((await app.inject({ method: 'DELETE', url: `/api/users/${u.id}/sessions/${ids[0]}`, headers: { cookie: admin.cookie } })).statusCode).toBe(404);

      const all = await app.inject({ method: 'DELETE', url: `/api/users/${u.id}/sessions`, headers: { cookie: admin.cookie } });
      expect(all.json()).toEqual({ revoked: 1 });
      expect(await store.resolveSessionUserId(s.token)).toBeUndefined();
      const rows = await waitForAudit('session.revoke_all', u.id);
      expect(rows[0].actor_id).toBe(admin.id);
    });
  });

  describe('audit log', () => {
    it('filters by actor, action prefix, target and date, and pages by keyset without gaps or repeats', async () => {
      const actor = await newUser('auditor');
      for (let i = 0; i < 7; i++) recordAudit(actor.id, i % 2 === 0 ? 'space.visibility' : 'access.grant', `space-${i % 3}`, { n: i });
      recordAudit(null, 'share.board_edit', 'page-x', { source: 'share' });
      for (let i = 0; i < 50; i++) {
        const rows = await query<{ n: string }>("SELECT count(*) AS n FROM audit_log WHERE meta ->> 'n' IS NOT NULL OR action = 'share.board_edit'");
        if (Number(rows[0].n) >= 8) break;
        await new Promise((r) => setTimeout(r, 20));
      }

      const mine = await listAuditEvents({ actor: actor.id });
      expect(mine.events).toHaveLength(7);
      expect(mine.events[0].actorEmail).toBe('auditor@stage4.local');
      expect((await listAuditEvents({ actor: actor.id, action: 'access.' })).events).toHaveLength(3);
      expect((await listAuditEvents({ actor: actor.id, action: 'access_' })).events).toHaveLength(0); // `_` is literal, not a wildcard
      expect((await listAuditEvents({ actor: actor.id, target: 'space-1' })).events.every((e) => e.target === 'space-1')).toBe(true);
      const guest = await listAuditEvents({ action: 'share.board_edit' });
      expect(guest.events[0]).toMatchObject({ actorId: null, actorName: null, target: 'page-x' });

      const today = new Date().toISOString().slice(0, 10);
      expect((await listAuditEvents({ actor: actor.id, from: today, to: today })).events).toHaveLength(7);
      expect((await listAuditEvents({ actor: actor.id, to: '2000-01-01' })).events).toHaveLength(0);
      expect((await listAuditEvents({ actor: actor.id, from: '2999-01-01' })).events).toHaveLength(0);

      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await listAuditEvents({ actor: actor.id, limit: 3, cursor });
        seen.push(...page.events.map((e) => e.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      expect(seen).toEqual([...seen].sort((a, b) => Number(b) - Number(a)));
    });

    it('names the targets: user, group (also a deleted one), space and page, with the raw id kept as the fallback', async () => {
      const actor = await newUser('namer');
      const person = await newUser('Target Person');
      const [group] = await query<{ id: string }>("INSERT INTO groups (slug, name) VALUES ('namer-grp', 'Sales team') RETURNING id");
      await query("INSERT INTO spaces (slug, name) VALUES ('namer-space', 'Engineering handbook')");
      await query("INSERT INTO pages_index (id, space_slug, path, kind, title) VALUES ('namer-page-id', 'namer-space', 'a.md', 'doc', 'Release plan')");
      const goneGroupId = '00000000-0000-4000-8000-00000000dead';
      recordAudit(actor.id, 'user.disable', person.id);
      recordAudit(actor.id, 'group.restore', group.id, { groupName: 'Sales team', archived: false });
      recordAudit(actor.id, 'group.delete', goneGroupId, { groupName: 'Old group' });
      recordAudit(actor.id, 'space.visibility', 'namer-space');
      recordAudit(actor.id, 'page.access', 'namer-page-id');
      recordAudit(actor.id, 'space.visibility', 'no-such-space');
      for (let i = 0; i < 50; i++) {
        if ((await listAuditEvents({ actor: actor.id })).events.length >= 6) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const events = (await listAuditEvents({ actor: actor.id })).events;
      const nameOf = (target: string) => events.find((e) => e.target === target)?.targetName;
      expect(nameOf(person.id)).toBe(`Target Person (${person.email})`);
      expect(nameOf(group.id)).toBe('Sales team');
      expect(nameOf(goneGroupId)).toBe('Old group'); // the group is gone: the name the event recorded
      expect(nameOf('namer-space')).toBe('Engineering handbook');
      expect(nameOf('namer-page-id')).toBe('Release plan');
      expect(nameOf('no-such-space')).toBeNull();

      let body = '';
      for await (const chunk of auditCsvChunks({ actor: actor.id })) body += chunk;
      body = body.replace(/^﻿/, '');
      expect(body.split('\r\n')[0]).toBe(AUDIT_CSV_HEADER.join(','));
      expect(AUDIT_CSV_HEADER).toContain('target_name');
      expect(body).toContain('page.access,namer-page-id,Release plan,');
      expect(body).toContain('space.visibility,no-such-space,,');
    });

    it('GET /api/admin/audit validates the query and is instance-admin only', async () => {
      const u = await newUser('nosy');
      const s = await login(u.id);
      expect((await app.inject({ method: 'GET', url: '/api/admin/audit', headers: { cookie: s.cookie } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/admin/audit?actor=not-a-uuid', headers: { cookie: admin.cookie } })).statusCode).toBe(400);
      const ok = await app.inject({ method: 'GET', url: '/api/admin/audit?action=user.&limit=2', headers: { cookie: admin.cookie } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().events.length).toBeLessThanOrEqual(2);
    });

    it('CSV: header, escaping, formula neutralisation, filter applied, the export itself audited', async () => {
      expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
      expect(csvCell('a,b')).toBe('"a,b"');
      expect(csvCell('+1')).toBe("'+1");
      expect(csvCell(null)).toBe('');

      recordAudit(admin.id, 'space.visibility', 'csv-space', { visibility: 'instance', note: 'line1\nline2, "q"' });
      await waitForAudit('space.visibility', 'csv-space');
      const res = await app.inject({ method: 'GET', url: '/api/admin/audit/export.csv?target=csv-space', headers: { cookie: admin.cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      const body = res.body.replace(/^﻿/, '');
      const lines = body.split('\r\n');
      expect(lines[0]).toBe(AUDIT_CSV_HEADER.join(','));
      expect(body).toContain('space.visibility,csv-space,');
      expect(body).toContain('""visibility"":""instance""'); // the meta JSON is one quoted cell, its quotes doubled
      expect(body).toContain('line1\\nline2, \\""q\\""'); // a newline inside meta stays JSON-escaped (one record per line)
      const [exported] = await waitForAudit('audit.export');
      expect(exported.actor_id).toBe(admin.id);
      expect(exported.meta).toMatchObject({ rows: 1, truncated: false });
    });

    it('CSV stream walks batches and honours the row cap', async () => {
      const actor = await newUser('bulk');
      await query(
        `INSERT INTO audit_log (actor_id, action, target) SELECT $1, 'bulk.test', 'b' || g FROM generate_series(1, 2500) g`,
        [actor.id],
      );
      const result = { rows: 0, truncated: false };
      let text = '';
      for await (const chunk of auditCsvChunks({ actor: actor.id }, result)) text += chunk;
      expect(result).toEqual({ rows: 2500, truncated: false });
      expect(text.split('\r\n').filter((l) => l.includes(',bulk.test,'))).toHaveLength(2500);
    });
  });
});

