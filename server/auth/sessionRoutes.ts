/**
 * Session management (cookie sessions only; a PAT never reaches these routes):
 *   own    — GET /api/me/sessions, DELETE /api/me/sessions/:id, POST /api/me/sessions/revoke-others
 *   admin  — GET/DELETE /api/users/:id/sessions, DELETE /api/users/:id/sessions/:sessionId  (instance admin)
 * Ending a session also closes the live collab / notification sockets it opened.
 * Audit: session.revoke (one), session.revoke_all (many); target = the user whose session it was.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SessionInfo } from '../../shared/contracts.js';
import { HttpError } from '../errors.js';
import { recordAudit } from '../audit.js';
import { assertNotDemo, assertNotDemoAccount } from '../demo.js';
import * as store from './store.js';
import * as session from './session.js';

async function requireTargetPerson(id: string): Promise<{ id: string; email: string }> {
  const target = await store.findStoredUserById(id);
  // A system account holds no sessions and is not a person an admin manages.
  if (!target || target.isSystem) throw new HttpError(404, 'user not found');
  return { id: target.id, email: target.email };
}

function adminGuard(request: FastifyRequest): void {
  session.requireCookieAuth(request);
  session.requireInstanceAdmin(request);
  // A shared demo login must not be used to sign other visitors out.
  assertNotDemoAccount(request.authUser!, 'Revoking sessions');
}

export function registerSessionRoutes(app: FastifyInstance): void {
  // --- Own sessions --------------------------------------------------------

  app.get('/api/me/sessions', async (request): Promise<{ sessions: SessionInfo[] }> => {
    session.requireCookieAuth(request);
    return { sessions: await store.listActiveSessions(request.authUser!.id, request.cookies?.[session.SESSION_COOKIE_NAME]) };
  });

  app.delete('/api/me/sessions/:id', async (request, reply) => {
    session.requireCookieAuth(request);
    assertNotDemo('Signing out a device');
    const { id } = request.params as { id: string };
    const user = request.authUser!;
    const sessions = await store.listActiveSessions(user.id, request.cookies?.[session.SESSION_COOKIE_NAME]);
    const target = sessions.find((s) => s.id === id);
    if (!target || !(await store.revokeSessionById(user.id, id))) throw new HttpError(404, 'session not found');
    recordAudit(user.id, 'session.revoke', user.id, { sessionId: id, self: true, current: target.current });
    if (target.current) session.clearSessionCookie(reply);
    return { ok: true };
  });

  /** "Sign out other devices": every session of the caller except the one making the request. */
  app.post('/api/me/sessions/revoke-others', async (request) => {
    session.requireCookieAuth(request);
    assertNotDemo('Signing out other devices');
    const user = request.authUser!;
    const revoked = await store.revokeSessionsForUser(user.id, request.cookies?.[session.SESSION_COOKIE_NAME]);
    if (revoked > 0) recordAudit(user.id, 'session.revoke_all', user.id, { count: revoked, scope: 'others', self: true });
    return { revoked };
  });

  // --- Instance admin: another person's sessions ---------------------------

  app.get('/api/users/:id/sessions', async (request): Promise<{ sessions: SessionInfo[] }> => {
    session.requireCookieAuth(request);
    session.requireInstanceAdmin(request);
    const { id } = request.params as { id: string };
    await requireTargetPerson(id);
    // `current` is meaningless for someone else's list (it would mark the admin's own row only when looking at themselves).
    return { sessions: await store.listActiveSessions(id, id === request.authUser!.id ? request.cookies?.[session.SESSION_COOKIE_NAME] : undefined) };
  });

  app.delete('/api/users/:id/sessions/:sessionId', async (request) => {
    adminGuard(request);
    const { id, sessionId } = request.params as { id: string; sessionId: string };
    const target = await requireTargetPerson(id);
    if (!(await store.revokeSessionById(id, sessionId))) throw new HttpError(404, 'session not found');
    recordAudit(request.authUser!.id, 'session.revoke', id, { sessionId, email: target.email });
    return { ok: true };
  });

  app.delete('/api/users/:id/sessions', async (request) => {
    adminGuard(request);
    const { id } = request.params as { id: string };
    const target = await requireTargetPerson(id);
    const revoked = await store.revokeSessionsForUser(id);
    recordAudit(request.authUser!.id, 'session.revoke_all', id, { count: revoked, scope: 'all', email: target.email });
    return { revoked };
  });
}
