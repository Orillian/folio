/**
 * The Teams sign-in ticket: the Teams identity (tenant, Entra object id, name) the bot saw in an
 * authenticated invoke, signed (HMAC-SHA256, key derived from FOLIO_SECRET) and short lived, carried
 * in the sign-in URL Teams opens. It only says WHICH Teams user a connection attempt is for; the
 * link is completed only when Teams hands the popup's one-time code back in an invoke of that same
 * user (links.completeTeamsLink), so a forwarded sign-in URL links nobody.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { loadEnv } from '../../env.js';

export const TICKET_TTL_SECONDS = 10 * 60;

export interface TeamsTicket {
  tenantId: string;
  platformUserId: string;
  platformUserName: string | null;
}

function key(): Buffer {
  loadEnv();
  const secret = process.env.FOLIO_SECRET;
  if (!secret) throw new Error('FOLIO_SECRET is not set');
  return createHash('sha256').update(`folio-chat-ticket:${secret}`, 'utf8').digest();
}

export function signTicket(t: TeamsTicket, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ t: t.tenantId, u: t.platformUserId, n: t.platformUserName, e: Math.floor(now / 1000) + TICKET_TTL_SECONDS })).toString('base64url');
  const mac = createHmac('sha256', key()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyTicket(raw: string | undefined, now = Date.now()): TeamsTicket | null {
  if (!raw || raw.length > 2048) return null;
  const [body, mac] = raw.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', key()).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { t?: unknown; u?: unknown; n?: unknown; e?: unknown };
    if (typeof p.t !== 'string' || typeof p.u !== 'string' || typeof p.e !== 'number' || p.e * 1000 < now) return null;
    return { tenantId: p.t, platformUserId: p.u, platformUserName: typeof p.n === 'string' ? p.n : null };
  } catch {
    return null;
  }
}
