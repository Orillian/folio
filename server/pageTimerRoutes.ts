/**
 * The HTTP surface of the shared page timer (server/pageTimer.ts explains the
 * mechanism). Registered in the protected scope.
 *
 *   GET  /api/pages/:id/timer          viewer+ on the page      -> PageTimerResponse
 *   POST /api/pages/:id/timer          editor+ on the page, cookie or write-scope PAT
 *                                      body PageTimerActionBody -> PageTimerResponse
 *   GET  /api/spaces/:space/timer      viewer+ on the space     -> PageTimerResponse   (a folder listing — the space home is an ordinary page)
 *   POST /api/spaces/:space/timer      editor+ on the space     -> PageTimerResponse
 *
 * Anyone who can read the page may SEE its timer; only an editor may change
 * it. After a change the new state is sent over the `/events` socket to the
 * open sessions that can read the page: first the cheap question (may this
 * session read the SPACE — one query for all of them), then, for a page timer,
 * the page's own access list for each of those. A reader who cannot open a
 * restricted page therefore never learns that it has a timer.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pageTimerActionBodySchema, SPACE_TIMER_KEY_PREFIX, type PageTimerResponse, type PageTimerState } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { tooManyRequests } from './errors.js';
import * as notificationSocket from './notifications/socket.js';
import { applyTimerAction, currentRev, readTimer } from './pageTimer.js';
import { rateLimited } from './rateLimit.js';
import type { PageIndexEntry } from './storage.js';
import { parseBody } from './validate.js';

/** A person starting and stopping timers does a handful of actions a minute; this stops a script, not a meeting. */
const ACTIONS_PER_MINUTE = 60;

export const spaceTimerKey = (space: string): string => `${SPACE_TIMER_KEY_PREFIX}${space}`;

/** Sends the state of `key` to every open session that may read the page (or, without `entry`, the space). Never throws. */
export async function fanOutTimer(args: { key: string; space: string; entry?: PageIndexEntry; timer: PageTimerState | null; rev: number }): Promise<void> {
  const { key, space, entry, timer, rev } = args;
  try {
    const tokens = notificationSocket.openSessionTokens();
    if (tokens.length === 0) return;
    let allowed = await authStore.sessionsThatCanReadSpace(space, tokens);
    if (allowed.size === 0) return;
    if (entry) {
      const checks = await Promise.all(
        [...allowed].map(async (token) => {
          const user = await session.userForToken(token);
          if (!user) return null;
          return session.roleAtLeast(await session.effectivePageRole(user, entry), 'viewer') ? token : null;
        }),
      );
      allowed = new Set(checks.filter((token): token is string => token !== null));
      if (allowed.size === 0) return;
    }
    notificationSocket.sendToSessions(allowed, { type: 'timer', key, timer, rev, serverNow: Date.now() });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[page-timer] could not fan out a change of "${key}": ${(err as Error).message}`);
  }
}

function mayWrite(request: FastifyRequest): boolean {
  return request.tokenScopes === undefined || request.tokenScopes.includes('write');
}

function respond(timer: PageTimerState | null, canControl: boolean, rev = currentRev()): PageTimerResponse {
  return { timer, rev, serverNow: Date.now(), canControl };
}

export function registerPageTimerRoutes(app: FastifyInstance): void {
  app.get('/api/pages/:id/timer', async (request) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    const role = await session.effectivePageRole(request.authUser!, entry);
    return respond(readTimer(id), session.roleAtLeast(role, 'editor') && mayWrite(request));
  });

  app.post('/api/pages/:id/timer', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(pageTimerActionBodySchema, request.body);
    const entry = await session.requirePageRole(request, id, 'editor');
    session.requireWriteScope(request);
    const user = request.authUser!;
    if (rateLimited('page-timer', user.id, ACTIONS_PER_MINUTE, 60_000)) throw tooManyRequests('too many timer actions, wait a moment');
    const change = applyTimerAction(id, body, user.name);
    if (change.changed) void fanOutTimer({ key: id, space: entry.space, entry, timer: change.timer, rev: change.rev });
    return respond(change.timer, true, change.rev);
  });

  app.get('/api/spaces/:space/timer', async (request) => {
    const { space } = request.params as { space: string };
    const role = await session.requireSpaceRole(request, space, 'viewer');
    return respond(readTimer(spaceTimerKey(space)), session.roleAtLeast(role, 'editor') && mayWrite(request));
  });

  app.post('/api/spaces/:space/timer', async (request) => {
    const { space } = request.params as { space: string };
    const body = parseBody(pageTimerActionBodySchema, request.body);
    await session.requireSpaceRole(request, space, 'editor');
    session.requireWriteScope(request);
    const user = request.authUser!;
    if (rateLimited('page-timer', user.id, ACTIONS_PER_MINUTE, 60_000)) throw tooManyRequests('too many timer actions, wait a moment');
    const key = spaceTimerKey(space);
    const change = applyTimerAction(key, body, user.name);
    if (change.changed) void fanOutTimer({ key, space, timer: change.timer, rev: change.rev });
    return respond(change.timer, true, change.rev);
  });
}
