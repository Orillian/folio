/**
 * Registry of the live sockets (the collab editor socket, the /events notification socket) that
 * were authorized by a SESSION COOKIE. A socket is authenticated once, at upgrade; when the
 * account is deactivated or a session is revoked, the socket must not keep working until the tab
 * is closed, so the registry lets the revoking code close exactly the right ones.
 *
 * Keyed by the sha256 of the session token (the same hash the sessions table stores), never the
 * raw token. A guest on a share link or an anonymous public visitor has no session and is never
 * registered here.
 */
import { createHash } from 'node:crypto';

export interface ClosableSocket {
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: 'close' | 'error', listener: () => void): unknown;
}

interface Entry {
  userId: string;
  tokenHash: string;
  socket: ClosableSocket;
}

const entries = new Set<Entry>();

/** WebSocket close code for "your session ended" (private-use range 4000-4999). */
export const SESSION_ENDED_CLOSE_CODE = 4401;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Remembers a session-authenticated socket until it closes. */
export function trackConnection(userId: string, sessionToken: string, socket: ClosableSocket): void {
  const entry: Entry = { userId, tokenHash: hashSessionToken(sessionToken), socket };
  entries.add(entry);
  const forget = (): void => {
    entries.delete(entry);
  };
  socket.on('close', forget);
  socket.on('error', forget);
}

function closeMatching(match: (entry: Entry) => boolean): number {
  let closed = 0;
  for (const entry of [...entries]) {
    if (!match(entry)) continue;
    entries.delete(entry);
    closed += 1;
    try {
      entry.socket.close(SESSION_ENDED_CLOSE_CODE, 'session ended');
      // A peer that never answers the close handshake must not keep the connection alive.
      setTimeout(() => entry.socket.terminate?.(), 2000).unref?.();
    } catch {
      entry.socket.terminate?.();
    }
  }
  return closed;
}

/** Closes every live socket of this user (all tabs, all sessions). Returns how many. */
export function disconnectUser(userId: string): number {
  return closeMatching((e) => e.userId === userId);
}

/** Closes the live sockets authorized by these sessions (by token hash). Returns how many. */
export function disconnectSessions(tokenHashes: ReadonlySet<string>): number {
  if (tokenHashes.size === 0) return 0;
  return closeMatching((e) => tokenHashes.has(e.tokenHash));
}

export function liveConnectionCount(userId?: string): number {
  if (userId === undefined) return entries.size;
  let n = 0;
  for (const e of entries) if (e.userId === userId) n += 1;
  return n;
}
