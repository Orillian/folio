/**
 * Space membership API (docs/spec-access.md §8): managed by canAdministerSpace — an instance admin or an admin member
 * of the space — and that is ALL an instance admin gets: no content access through it.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema } from '../db/testSchema.js';
import { query } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { registerProtectedAuthRoutes } from './routes.js';
import * as session from './session.js';
import * as store from './store.js';

const fastifyCookie = fastifyCookieModule.default;

describe('space members API', () => {
  let teardown: () => Promise<void>;
  let app: FastifyInstance;
  const space = 'members-space';
  let n = 0;

  async function newUser(name: string, isAdmin = false) {
    const user = await store.createUser({ email: `${name}-${n++}@members.test`, name, passwordHash: 'x', isAdmin });
    const { token } = await store.createSession(user.id);
    return { user, cookie: `${session.SESSION_COOKIE_NAME}=${token}` };
  }
  const call = (method: 'GET' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

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
    });
    await app.ready();
    await query("INSERT INTO spaces (slug, name, visibility) VALUES ($1, 'Members space', 'private')", [space]);
  });
  afterAll(async () => {
    await app.close();
    await teardown();
  });

  it('an instance admin who is not a member lists, adds, changes and removes members', async () => {
    const boss = await newUser('boss', true);
    const spaceAdmin = await newUser('spaceadmin');
    const guest = await newUser('guest');
    await store.setMembership(space, spaceAdmin.user.id, 'admin');

    const list = await call('GET', `/api/spaces/${space}/members`, { cookie: boss.cookie });
    expect(list.statusCode).toBe(200);
    expect(list.json().members.map((m: { user: { id: string } }) => m.user.id)).toEqual([spaceAdmin.user.id]);

    const added = await call('PUT', `/api/spaces/${space}/members/${guest.user.id}`, { cookie: boss.cookie }, { role: 'editor' });
    expect(added.statusCode).toBe(200);
    expect(await store.getMembershipRole(space, guest.user.id)).toBe('editor');

    const removed = await call('DELETE', `/api/spaces/${space}/members/${guest.user.id}`, { cookie: boss.cookie });
    expect(removed.statusCode).toBe(200);
    expect(await store.getMembershipRole(space, guest.user.id)).toBeUndefined();

    // The last-admin guard still holds.
    const last = await call('DELETE', `/api/spaces/${space}/members/${spaceAdmin.user.id}`, { cookie: boss.cookie });
    expect(last.statusCode).toBe(409);
  });

  it('being an instance admin gives no content access to the space', async () => {
    const boss = await newUser('boss2', true);
    expect(await session.effectiveRole(boss.user, space)).toBeUndefined();
    expect(await session.canAdministerSpace(boss.user, space)).toBe(true);
    await expect(session.requireSpaceRole({ authUser: boss.user } as never, space, 'viewer')).rejects.toMatchObject({ status: 403 });
  });

  it('a space admin manages members; a plain member or outsider gets 403; an unknown space 404', async () => {
    const spaceAdmin = await newUser('sadmin');
    const editor = await newUser('editor');
    const outsider = await newUser('outsider');
    const target = await newUser('target');
    await store.setMembership(space, spaceAdmin.user.id, 'admin');
    await store.setMembership(space, editor.user.id, 'editor');

    expect((await call('GET', `/api/spaces/${space}/members`, { cookie: spaceAdmin.cookie })).statusCode).toBe(200);
    expect((await call('PUT', `/api/spaces/${space}/members/${target.user.id}`, { cookie: spaceAdmin.cookie }, { role: 'viewer' })).statusCode).toBe(200);
    for (const who of [editor, outsider]) {
      expect((await call('GET', `/api/spaces/${space}/members`, { cookie: who.cookie })).statusCode).toBe(403);
      expect((await call('PUT', `/api/spaces/${space}/members/${target.user.id}`, { cookie: who.cookie }, { role: 'admin' })).statusCode).toBe(403);
      expect((await call('DELETE', `/api/spaces/${space}/members/${target.user.id}`, { cookie: who.cookie })).statusCode).toBe(403);
    }
    expect(await store.getMembershipRole(space, target.user.id)).toBe('viewer');

    const boss = await newUser('boss3', true);
    expect((await call('GET', '/api/spaces/no-such-space/members', { cookie: boss.cookie })).statusCode).toBe(404);
  });

  it('a personal access token is still refused (cookie sessions only)', async () => {
    const boss = await newUser('boss4', true);
    const pat = await store.createApiToken(boss.user.id, 'ci', ['read', 'write']);
    const res = await call('GET', `/api/spaces/${space}/members`, { authorization: `Bearer ${pat.token}` });
    expect(res.statusCode).toBe(403);
  });
});
