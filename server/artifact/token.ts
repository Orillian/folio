/**
 * Artifacts: the capability token of `/art/<token>/…` (docs/spec-artifacts.md §3).
 *
 * The sandboxed iframe has an opaque origin and therefore no Folio cookies; the
 * token alone says "this reader may load the files of this page until `exp`".
 * HMAC-SHA256 with a key derived from FOLIO_SECRET (the same secret as the other
 * signed tickets, e.g. integrations/chat/ticket.ts), its own derivation label so
 * a token of one kind can never verify as another. The page is named by id and
 * resolved when the file is requested, so a token survives a rename or a move.
 *
 *   token = base64url(JSON {p: pageId, u: userId | null, e: exp seconds}) "." base64url(mac)
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ARTIFACT_LIMITS } from '../../shared/contracts.js';
import { loadEnv } from '../env.js';

export interface ArtifactTokenClaims {
  pageId: string;
  /** The signed-in reader the token was minted for; null for a share link / public site reader. */
  userId: string | null;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

let cachedKey: { secret: string; key: Buffer } | null = null;

function key(): Buffer {
  loadEnv();
  const secret = process.env.FOLIO_SECRET;
  if (!secret) throw new Error('FOLIO_SECRET is not set');
  if (cachedKey?.secret !== secret) cachedKey = { secret, key: createHash('sha256').update(`folio-artifact-token:${secret}`, 'utf8').digest() };
  return cachedKey.key;
}

export function signArtifactToken(pageId: string, userId: string | null, now = Date.now(), ttlSeconds: number = ARTIFACT_LIMITS.tokenTtlSeconds): string {
  const body = Buffer.from(JSON.stringify({ p: pageId, u: userId, e: Math.floor(now / 1000) + ttlSeconds })).toString('base64url');
  const mac = createHmac('sha256', key()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** The claims of a valid, unexpired token; null for anything else. */
export function verifyArtifactToken(raw: string | undefined, now = Date.now()): ArtifactTokenClaims | null {
  if (!raw || raw.length > 1024) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0 || raw.indexOf('.', dot + 1) !== -1) return null;
  const body = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(mac)) return null;
  const expected = createHmac('sha256', key()).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { p?: unknown; u?: unknown; e?: unknown };
    if (typeof p.p !== 'string' || !p.p || typeof p.e !== 'number') return null;
    if (p.u !== null && typeof p.u !== 'string') return null;
    if (p.e * 1000 <= now) return null;
    return { pageId: p.p, userId: p.u, exp: p.e };
  } catch {
    return null;
  }
}

/** `ARTIFACTS_ORIGIN` without a trailing slash, or '' (same host). Only an http(s) origin is honoured. */
export function artifactsOrigin(): string {
  const raw = process.env.ARTIFACTS_ORIGIN?.trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

/** Encodes a bundle path for a URL, segment by segment. */
export function encodeBundlePath(rel: string): string {
  return rel.split('/').map(encodeURIComponent).join('/');
}

/** `/art/<token>/<path>` (absolute on ARTIFACTS_ORIGIN when set). */
export function artifactFileUrl(token: string, rel: string): string {
  return `${artifactsOrigin()}/art/${token}/${encodeBundlePath(rel)}`;
}
