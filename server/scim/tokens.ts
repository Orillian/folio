/**
 * SCIM bearer tokens (migration 059): one active token per sign-in provider, generated in /admin/auth, shown once,
 * stored as sha256 only. "SCIM is enabled for a provider" = the provider has an active token.
 */
import { createHash, randomBytes } from 'node:crypto';
import { query, queryOne, withTransaction } from '../db/pool.js';

export const SCIM_TOKEN_PREFIX = 'folio_scim_';

export interface ScimTokenInfo {
  id: string;
  providerId: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface TokenRow {
  id: string;
  provider_id: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
}

function rowToInfo(row: TokenRow): ScimTokenInfo {
  return {
    id: row.id,
    providerId: row.provider_id,
    prefix: row.token_prefix,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  };
}

export function hashScimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A new token for `providerId`; the previous active one (if any) is revoked in the same transaction.
 * Returns the raw token (never stored) and whether an older one was replaced.
 */
export async function issueScimToken(providerId: string, createdBy: string | null): Promise<{ token: string; info: ScimTokenInfo; rotated: boolean }> {
  const token = `${SCIM_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return withTransaction(async (client) => {
    const revoked = await client.query('UPDATE scim_tokens SET revoked_at = now() WHERE provider_id = $1 AND revoked_at IS NULL', [providerId]);
    const inserted = await client.query<TokenRow>(
      `INSERT INTO scim_tokens (provider_id, token_hash, token_prefix, created_by) VALUES ($1, $2, $3, $4)
       RETURNING id, provider_id, token_prefix, created_at, last_used_at`,
      [providerId, hashScimToken(token), token.slice(0, SCIM_TOKEN_PREFIX.length + 4), createdBy],
    );
    return { token, info: rowToInfo(inserted.rows[0]), rotated: (revoked.rowCount ?? 0) > 0 };
  });
}

/** Revokes the provider's active token. False when there was none. */
export async function revokeScimToken(providerId: string): Promise<boolean> {
  const rows = await query<{ id: string }>('UPDATE scim_tokens SET revoked_at = now() WHERE provider_id = $1 AND revoked_at IS NULL RETURNING id', [providerId]);
  return rows.length > 0;
}

export async function activeScimToken(providerId: string): Promise<ScimTokenInfo | undefined> {
  const row = await queryOne<TokenRow>(
    'SELECT id, provider_id, token_prefix, created_at, last_used_at FROM scim_tokens WHERE provider_id::text = $1 AND revoked_at IS NULL',
    [providerId],
  );
  return row ? rowToInfo(row) : undefined;
}

/** True when SCIM is on for the provider — JIT account creation at sign-in is then off for it. */
export async function isScimEnabled(providerId: string): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>('SELECT EXISTS(SELECT 1 FROM scim_tokens WHERE provider_id = $1 AND revoked_at IS NULL) AS exists', [providerId]);
  return row?.exists ?? false;
}

/** Ids of every provider with SCIM on (the admin list). */
export async function scimEnabledProviderIds(): Promise<Set<string>> {
  const rows = await query<{ provider_id: string }>('SELECT provider_id FROM scim_tokens WHERE revoked_at IS NULL');
  return new Set(rows.map((r) => r.provider_id));
}

/** The active token with this raw value, or undefined (unknown, revoked, malformed). */
export async function resolveScimToken(raw: string): Promise<ScimTokenInfo | undefined> {
  if (!raw.startsWith(SCIM_TOKEN_PREFIX) || raw.length > 200) return undefined;
  const row = await queryOne<TokenRow>(
    'SELECT id, provider_id, token_prefix, created_at, last_used_at FROM scim_tokens WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashScimToken(raw)],
  );
  return row ? rowToInfo(row) : undefined;
}

/** "Last sync": every authenticated request. Never fails the request. */
export async function touchScimToken(id: string): Promise<void> {
  await query('UPDATE scim_tokens SET last_used_at = now() WHERE id = $1', [id]).catch(() => {});
}
