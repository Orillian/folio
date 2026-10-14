/**
 * AI assistant - shared Cursor keys (db/migrations/037_assistant_shared_keys.sql):
 * one optional key per space (`space_assistant_settings`) and one instance-wide
 * key plus the instance policy `personal_keys_allowed`
 * (`instance_assistant_settings`, a single row with id = 1).
 *
 * Same split as store.ts: the readers that feed an HTTP response
 * (`getInstanceKeyInfo`, `getSpaceKeyInfo`) never touch the ciphertext's
 * plaintext - they return only the Cursor key name, the account email and who
 * set it when - and the decrypted key comes out only of `getDecryptedInstanceKey`
 * / `getDecryptedSpaceKey`, which feed the outbound Cursor SDK call. Encryption
 * is the same AES-256-GCM through FOLIO_SECRET (server/secretCrypto.ts).
 */
import { saveSharedAssistantKeyBodySchema } from '../../shared/contracts.js';
import type { SharedAssistantKeyInfo, SharedAssistantKeyScope } from '../../shared/contracts.js';
import { query, queryOne } from '../db/pool.js';
import { badRequest, conflict, HttpError } from '../errors.js';
import { decryptSecret, encryptSecret, hasSecretConfigured } from '../secretCrypto.js';
import { parseBody } from '../validate.js';
import { cursorRuntimeAvailable, verifyCursorApiKey } from './cursorRuntime.js';

/** What a shared-key GET needs from the database, before the route adds `encryptionAvailable` / `runtimeAvailable`. */
export interface SharedKeyRow {
  configured: boolean;
  apiKeyName: string | null;
  email: string | null;
  updatedAt: string | null;
  updatedBy: { id: string; name: string } | null;
}

interface RawKeyInfoRow {
  has_key: boolean;
  cursor_key_name: string | null;
  cursor_email: string | null;
  updated_at: Date | null;
  updated_by: string | null;
  updated_by_name: string | null;
}

const EMPTY_KEY_ROW: SharedKeyRow = { configured: false, apiKeyName: null, email: null, updatedAt: null, updatedBy: null };

function toKeyRow(row: RawKeyInfoRow | undefined): SharedKeyRow {
  if (!row || !row.has_key) return { ...EMPTY_KEY_ROW };
  return {
    configured: true,
    apiKeyName: row.cursor_key_name,
    email: row.cursor_email,
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
    updatedBy: row.updated_by && row.updated_by_name !== null ? { id: row.updated_by, name: row.updated_by_name } : null,
  };
}

function requireSecret(): void {
  if (!hasSecretConfigured()) throw new Error('FOLIO_SECRET is not set - cannot encrypt/decrypt saved Cursor API keys.');
}

// ---------------------------------------------------------------------------
// Instance level
// ---------------------------------------------------------------------------

/** Never returns the key. A missing row (the singleton is created by the migration) reads as "not configured". */
export async function getInstanceKeyInfo(): Promise<SharedKeyRow> {
  const row = await queryOne<RawKeyInfoRow>(
    `SELECT (s.cursor_key_enc IS NOT NULL) AS has_key, s.cursor_key_name, s.cursor_email, s.updated_at, s.updated_by, u.name AS updated_by_name
       FROM instance_assistant_settings s
       LEFT JOIN users u ON u.id = s.updated_by
      WHERE s.id = 1`,
  );
  return toKeyRow(row);
}

/** Server-side only - feeds the outbound Cursor SDK call. Never wired to an HTTP response. */
export async function getDecryptedInstanceKey(): Promise<{ apiKey: string; apiKeyName: string | null } | null> {
  const row = await queryOne<{ cursor_key_enc: Buffer | null; cursor_key_name: string | null }>(
    'SELECT cursor_key_enc, cursor_key_name FROM instance_assistant_settings WHERE id = 1',
  );
  if (!row?.cursor_key_enc) return null;
  return { apiKey: decryptSecret(row.cursor_key_enc), apiKeyName: row.cursor_key_name };
}

/** Throws if FOLIO_SECRET is not set - callers check hasSecretConfigured() first for a clean 409. */
export async function saveInstanceKey(apiKey: string, keyName: string, email: string | null, actorId: string): Promise<void> {
  requireSecret();
  const enc = encryptSecret(apiKey);
  await query(
    `INSERT INTO instance_assistant_settings (id, cursor_key_enc, cursor_key_name, cursor_email, updated_by)
     VALUES (1, $1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET cursor_key_enc = EXCLUDED.cursor_key_enc, cursor_key_name = EXCLUDED.cursor_key_name,
       cursor_email = EXCLUDED.cursor_email, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [enc, keyName, email, actorId],
  );
}

/** Removes the key only - the policy flag stays as it is. */
export async function deleteInstanceKey(actorId: string | null = null): Promise<void> {
  await query(
    `UPDATE instance_assistant_settings
        SET cursor_key_enc = NULL, cursor_key_name = NULL, cursor_email = NULL, updated_by = $1, updated_at = now()
      WHERE id = 1`,
    [actorId],
  );
}

/** Default true (the pre-shared-keys behaviour) when the singleton row is somehow missing. */
export async function getPersonalKeysAllowed(): Promise<boolean> {
  const row = await queryOne<{ personal_keys_allowed: boolean }>('SELECT personal_keys_allowed FROM instance_assistant_settings WHERE id = 1');
  return row?.personal_keys_allowed ?? true;
}

export async function setPersonalKeysAllowed(allowed: boolean, actorId: string): Promise<void> {
  await query(
    `INSERT INTO instance_assistant_settings (id, personal_keys_allowed, updated_by)
     VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET personal_keys_allowed = EXCLUDED.personal_keys_allowed, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [allowed, actorId],
  );
}

// ---------------------------------------------------------------------------
// Space level
// ---------------------------------------------------------------------------

/** Never returns the key. A space without a row is "not configured". */
export async function getSpaceKeyInfo(space: string): Promise<SharedKeyRow> {
  const row = await queryOne<RawKeyInfoRow>(
    `SELECT TRUE AS has_key, s.cursor_key_name, s.cursor_email, s.updated_at, s.updated_by, u.name AS updated_by_name
       FROM space_assistant_settings s
       LEFT JOIN users u ON u.id = s.updated_by
      WHERE s.space_slug = $1`,
    [space],
  );
  return toKeyRow(row);
}

/** Server-side only - feeds the outbound Cursor SDK call. Never wired to an HTTP response. */
export async function getDecryptedSpaceKey(space: string): Promise<{ apiKey: string; apiKeyName: string | null } | null> {
  const row = await queryOne<{ cursor_key_enc: Buffer; cursor_key_name: string | null }>(
    'SELECT cursor_key_enc, cursor_key_name FROM space_assistant_settings WHERE space_slug = $1',
    [space],
  );
  if (!row) return null;
  return { apiKey: decryptSecret(row.cursor_key_enc), apiKeyName: row.cursor_key_name };
}

/** Throws if FOLIO_SECRET is not set, or (FK) if the space does not exist - routes check both first. */
export async function saveSpaceKey(space: string, apiKey: string, keyName: string, email: string | null, actorId: string): Promise<void> {
  requireSecret();
  const enc = encryptSecret(apiKey);
  await query(
    `INSERT INTO space_assistant_settings (space_slug, cursor_key_enc, cursor_key_name, cursor_email, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (space_slug) DO UPDATE SET cursor_key_enc = EXCLUDED.cursor_key_enc, cursor_key_name = EXCLUDED.cursor_key_name,
       cursor_email = EXCLUDED.cursor_email, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [space, enc, keyName, email, actorId],
  );
}

export async function deleteSpaceKey(space: string): Promise<void> {
  await query('DELETE FROM space_assistant_settings WHERE space_slug = $1', [space]);
}

// ---------------------------------------------------------------------------
// Shared by the instance and the space routes
// ---------------------------------------------------------------------------

/** The `SharedAssistantKeyInfo` an instance/space key route answers with. `personalKeysAllowed` is the instance policy for `instance` scope and null for `space`. */
export function toSharedKeyInfo(
  scope: SharedAssistantKeyScope,
  space: string | null,
  row: SharedKeyRow,
  personalKeysAllowed: boolean | null,
): SharedAssistantKeyInfo {
  return {
    scope,
    space,
    ...row,
    personalKeysAllowed,
    encryptionAvailable: hasSecretConfigured(),
    runtimeAvailable: cursorRuntimeAvailable(),
  };
}

export async function buildInstanceKeyInfo(): Promise<SharedAssistantKeyInfo> {
  const [row, personalKeysAllowed] = await Promise.all([getInstanceKeyInfo(), getPersonalKeysAllowed()]);
  return toSharedKeyInfo('instance', null, row, personalKeysAllowed);
}

export async function buildSpaceKeyInfo(space: string): Promise<SharedAssistantKeyInfo> {
  return toSharedKeyInfo('space', space, await getSpaceKeyInfo(space), null);
}

/**
 * The checks every shared-key PUT runs before it stores anything: encryption
 * configured (409), Cursor runtime available (503), a well-formed body (400),
 * and the key accepted by Cursor (400 - the key itself is never echoed).
 * Returns what Cursor reported about the key.
 */
export async function verifySharedKeyBody(body: unknown): Promise<{ apiKey: string; apiKeyName: string; email: string | null }> {
  if (!hasSecretConfigured()) throw conflict('FOLIO_SECRET is not configured on this server — Cursor API keys cannot be stored securely.');
  if (!cursorRuntimeAvailable()) throw new HttpError(503, 'Cursor SDK requires Node.js 22.13 or newer');
  const input = parseBody(saveSharedAssistantKeyBodySchema, body);
  let identity: Awaited<ReturnType<typeof verifyCursorApiKey>>;
  try {
    identity = await verifyCursorApiKey(input.apiKey);
  } catch {
    throw badRequest('Cursor API key was not accepted');
  }
  return { apiKey: input.apiKey, apiKeyName: identity.apiKeyName, email: identity.email };
}
