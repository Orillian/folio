/**
 * Saved searches (Obsidian brief wave 3), real PG: CRUD per user, the cap of 50
 * (also under parallel saves), cookie and PAT scopes, a search pinned to a space.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SavedSearch, SavedSearchesResponse, User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { MAX_SAVED_SEARCHES } from './savedSearches.js';
import { registerSavedSearchRoutes } from './savedSearchesRoutes.js';
import * as storage from './storage.js';

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
    registerSavedSearchRoutes(scope);
  });
  await app.ready();
  return app;
}

describe('saved searches (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let alice: User;
  let bob: User;
  let aliceAuth: { cookie: string };
  let bobAuth: { cookie: string };
  let space: string;

  const cookieOf = async (user: User): Promise<{ cookie: string }> => ({ cookie: `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}` });
  const list = async (headers: Record<string, string>): Promise<SavedSearch[]> => (await app.inject({ method: 'GET', url: '/api/me/saved-searches', headers })).json<SavedSearchesResponse>().searches;
  const create = (headers: Record<string, string>, payload: unknown) => app.inject({ method: 'POST', url: '/api/me/saved-searches', headers, payload: payload as object });
  const remove = (headers: Record<string, string>, id: string) => app.inject({ method: 'DELETE', url: `/api/me/saved-searches/${id}`, headers });

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    app = await buildApp();
    const stamp = Date.now();
    alice = await authStore.createUser({ email: `alice-${stamp}@saved-test.local`, name: 'Alice', passwordHash: 'x', isAdmin: false });
    bob = await authStore.createUser({ email: `bob-${stamp}@saved-test.local`, name: 'Bob', passwordHash: 'x', isAdmin: false });
    aliceAuth = await cookieOf(alice);
    bobAuth = await cookieOf(bob);
    space = (await storage.createSpace(`Saved Searches ${stamp}`, alice.id)).slug;
    await authStore.setMembership(space, alice.id, 'admin');
  });

  afterAll(async () => {
    await app.close();
    await deleteTestSpace(space);
    await teardownSchema();
  });

  it('saves, lists in the order saved, and deletes — the search is the text as typed', async () => {
    expect(await list(aliceAuth)).toEqual([]);
    const first = await create(aliceAuth, { name: '  Open tasks ', query: '  tag:todo -status:archived  ' });
    expect(first.statusCode).toBe(201);
    const saved = first.json<SavedSearch>();
    expect(saved).toMatchObject({ name: 'Open tasks', query: 'tag:todo -status:archived', space: null });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(saved.createdAt).toString()).not.toBe('Invalid Date');
    const second = (await create(aliceAuth, { name: 'In docs', query: 'in:docs/ "release notes"', space })).json<SavedSearch>();
    expect(second.space).toBe(space);

    expect((await list(aliceAuth)).map((s) => s.id)).toEqual([saved.id, second.id]);
    expect(await list(bobAuth)).toEqual([]); // theirs alone

    const gone = await remove(aliceAuth, saved.id);
    expect(gone.statusCode).toBe(204);
    expect(gone.body).toBe('');
    expect((await list(aliceAuth)).map((s) => s.id)).toEqual([second.id]);
    expect((await remove(aliceAuth, saved.id)).statusCode).toBe(404);
    await remove(aliceAuth, second.id);
  });

  it("someone else's saved search cannot be deleted or seen; a malformed id is a plain 404", async () => {
    const mine = (await create(aliceAuth, { name: 'Mine', query: 'secret' })).json<SavedSearch>();
    expect((await remove(bobAuth, mine.id)).statusCode).toBe(404);
    expect((await list(aliceAuth)).map((s) => s.id)).toContain(mine.id);
    expect((await remove(aliceAuth, 'not-a-uuid')).statusCode).toBe(404);
    await remove(aliceAuth, mine.id);
  });

  it('validates the body: name 1..80, query 1..500, a space the person can see', async () => {
    expect((await create(aliceAuth, { name: '', query: 'x' })).statusCode).toBe(400);
    expect((await create(aliceAuth, { name: '   ', query: 'x' })).statusCode).toBe(400);
    expect((await create(aliceAuth, { name: 'x'.repeat(81), query: 'x' })).statusCode).toBe(400);
    expect((await create(aliceAuth, { name: 'ok', query: '' })).statusCode).toBe(400);
    expect((await create(aliceAuth, { name: 'ok', query: 'q'.repeat(501) })).statusCode).toBe(400);
    expect((await create(aliceAuth, { name: 'ok' })).statusCode).toBe(400);
    const edge = await create(aliceAuth, { name: 'x'.repeat(80), query: 'q'.repeat(500) });
    expect(edge.statusCode).toBe(201);
    await remove(aliceAuth, edge.json<SavedSearch>().id);
    // A space that does not exist, and one the person cannot see, are the same 404.
    expect((await create(aliceAuth, { name: 'ok', query: 'x', space: 'no-such-space' })).statusCode).toBe(404);
    expect((await create(bobAuth, { name: 'ok', query: 'x', space })).statusCode).toBe(404);
    expect(await list(bobAuth)).toEqual([]);
  });

  it('keeps at most 50 per person: the 51st is a 409, also under parallel saves; deleting one makes room', async () => {
    const results = await Promise.all(Array.from({ length: MAX_SAVED_SEARCHES + 5 }, (_, i) => create(bobAuth, { name: `s${i}`, query: `word${i}` })));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(MAX_SAVED_SEARCHES);
    const refused = results.filter((r) => r.statusCode === 409);
    expect(refused).toHaveLength(5);
    expect(refused[0].json<{ error: string }>().error).toContain('50');
    const all = await list(bobAuth);
    expect(all).toHaveLength(MAX_SAVED_SEARCHES);
    // The cap is per person.
    expect((await create(aliceAuth, { name: 'alice', query: 'x' })).statusCode).toBe(201);
    expect((await remove(bobAuth, all[0].id)).statusCode).toBe(204);
    expect((await create(bobAuth, { name: 'again', query: 'x' })).statusCode).toBe(201);
    expect((await create(bobAuth, { name: 'again', query: 'x' })).statusCode).toBe(409);
    for (const s of await list(bobAuth)) await remove(bobAuth, s.id);
    for (const s of await list(aliceAuth)) await remove(aliceAuth, s.id);
  });

  it('a PAT: read scope lists, write scope saves and deletes; anonymous is 401', async () => {
    const read = { authorization: `Bearer ${(await authStore.createApiToken(alice.id, 'read', ['read'])).token}` };
    const write = { authorization: `Bearer ${(await authStore.createApiToken(alice.id, 'write', ['read', 'write'])).token}` };
    expect((await create(read, { name: 'nope', query: 'x' })).statusCode).toBe(403);
    const made = await create(write, { name: 'via pat', query: 'tag:a' });
    expect(made.statusCode).toBe(201);
    const id = made.json<SavedSearch>().id;
    expect((await list(read)).map((s) => s.id)).toEqual([id]); // the same person's list, whichever way they sign in
    expect((await list(aliceAuth)).map((s) => s.id)).toEqual([id]);
    expect((await remove(read, id)).statusCode).toBe(403);
    expect((await list(aliceAuth)).map((s) => s.id)).toEqual([id]);
    expect((await remove(write, id)).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/me/saved-searches' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/me/saved-searches', payload: { name: 'x', query: 'x' } })).statusCode).toBe(401);
  });

  it('a search pinned to a space is left out once the person can no longer see it, and goes when the space is deleted', async () => {
    await authStore.setMembership(space, bob.id, 'viewer');
    const pinned = (await create(bobAuth, { name: 'pinned', query: 'x', space })).json<SavedSearch>();
    const everywhere = (await create(bobAuth, { name: 'everywhere', query: 'x' })).json<SavedSearch>();
    expect((await list(bobAuth)).map((s) => s.id)).toEqual([pinned.id, everywhere.id]);
    await authStore.removeMembership(space, bob.id);
    expect((await list(bobAuth)).map((s) => s.id)).toEqual([everywhere.id]);

    const doomed = (await storage.createSpace(`Saved Doomed ${Date.now()}`, bob.id)).slug;
    await authStore.setMembership(doomed, bob.id, 'admin');
    const onDoomed = (await create(bobAuth, { name: 'doomed', query: 'x', space: doomed })).json<SavedSearch>();
    expect((await list(bobAuth)).map((s) => s.id)).toContain(onDoomed.id);
    await deleteTestSpace(doomed);
    expect((await list(bobAuth)).map((s) => s.id)).toEqual([everywhere.id]);
    expect((await remove(bobAuth, onDoomed.id)).statusCode).toBe(404);
  });
});
