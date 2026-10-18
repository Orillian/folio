/**
 * Who may hear about a page over the `/events` socket — the one ACL filter the
 * page-scoped frames share (the shared page timer, server/pageTimerRoutes.ts;
 * "the properties of this page changed", server/propertiesSignal.ts).
 *
 * First the cheap question, for every open session at once: may this session
 * read the SPACE (one query, authStore.sessionsThatCanReadSpace — a valid
 * session of a member, or anybody for an instance-visible space, never a
 * disabled user). Then, for a page, the page's own access list for each of
 * those (session.effectivePageRole: page restrictions, `.agent/**`). A reader
 * who cannot open a restricted page never learns that anything happened to it.
 */
import * as authStore from '../auth/store.js';
import * as session from '../auth/session.js';
import type { PageIndexEntry } from '../storage.js';
import * as notificationSocket from './socket.js';

/** The open sessions that may read `space` (an empty set when nobody is connected). */
export async function sessionsThatCanReadSpace(space: string): Promise<Set<string>> {
  const tokens = notificationSocket.openSessionTokens();
  if (tokens.length === 0) return new Set();
  return authStore.sessionsThatCanReadSpace(space, tokens);
}

/** Of `spaceReaders` (sessionsThatCanReadSpace of the page's space), the ones whose user may read the page itself. */
export async function sessionsThatCanReadPage(entry: PageIndexEntry, spaceReaders: ReadonlySet<string>): Promise<Set<string>> {
  if (spaceReaders.size === 0) return new Set();
  const checks = await Promise.all(
    [...spaceReaders].map(async (token) => {
      const user = await session.userForToken(token);
      if (!user) return null;
      return session.roleAtLeast(await session.effectivePageRole(user, entry), 'viewer') ? token : null;
    }),
  );
  return new Set(checks.filter((token): token is string => token !== null));
}
