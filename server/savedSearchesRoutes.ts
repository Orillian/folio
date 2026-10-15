/**
 * The HTTP wrapper of server/savedSearches.ts (Obsidian brief, wave 3). Cookie or
 * PAT: GET needs a read-scope token (any PAT), POST and DELETE a write-scope one.
 * A person's saved searches are theirs alone — no space role is involved, except
 * that a search may only be pinned to a space the person can see, and a search
 * pinned to a space they can no longer see is left out of the list.
 *
 *   GET    /api/me/saved-searches        -> { searches }
 *   POST   /api/me/saved-searches        { name, query, space } -> 201 SavedSearch    (409 over 50)
 *   DELETE /api/me/saved-searches/:id    -> 204
 */
import type { FastifyInstance } from 'fastify';
import { createSavedSearchBodySchema, type SavedSearchesResponse } from '../shared/contracts.js';
import * as session from './auth/session.js';
import { conflict, notFound } from './errors.js';
import { createSavedSearch, deleteSavedSearch, listSavedSearches, MAX_SAVED_SEARCHES } from './savedSearches.js';
import { parseBody } from './validate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerSavedSearchRoutes(app: FastifyInstance): void {
  app.get('/api/me/saved-searches', async (request): Promise<SavedSearchesResponse> => {
    const user = request.authUser!;
    const all = await listSavedSearches(user.id);
    const pinned = all.some((s) => s.space !== null);
    const visible = pinned ? await session.visibleSpaceSlugs(user) : new Set<string>();
    return { searches: all.filter((s) => s.space === null || visible.has(s.space)) };
  });

  app.post('/api/me/saved-searches', async (request, reply) => {
    session.requireWriteScope(request);
    const user = request.authUser!;
    const body = parseBody(createSavedSearchBodySchema, request.body);
    // A space the person cannot see is "space not found", whether it exists or not.
    if (body.space !== null && !(await session.visibleSpaceSlugs(user)).has(body.space)) throw notFound('space');
    const created = await createSavedSearch(user.id, { name: body.name, query: body.query, space: body.space });
    if (!created) throw conflict(`you can keep at most ${MAX_SAVED_SEARCHES} saved searches; delete one first`);
    reply.status(201);
    return created;
  });

  app.delete('/api/me/saved-searches/:id', async (request, reply) => {
    session.requireWriteScope(request);
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id) || !(await deleteSavedSearch(request.authUser!.id, id))) throw notFound('saved search');
    reply.status(204).send();
  });
}
