/**
 * Account links of the chat link previews: one chat user (a Slack member, a Teams user) to one
 * Folio user, made through Folio's own OAuth 2.1 (authorization code + PKCE, scope `read`) with
 * one of Folio's internal clients (`folio_chat_slack`, `folio_chat_teams`).
 *
 * The OAuth tokens are what makes a link valid, not the row: every preview resolves the viewer
 * FROM the access token (oauth/store.resolveAccessToken), refreshing it through the ordinary
 * rotation when it has expired. So revoking the grant (Settings → API tokens → Chat apps, an
 * admin, or the user being disabled) ends the previews at the next link, and a link nobody uses
 * for the refresh token's 30 days lapses by itself. Tokens are stored AES-256-GCM with
 * FOLIO_SECRET (secretCrypto.ts); nothing here logs a token, a nonce or a code.
 *
 * Refresh is serialized per link (in-process promise + a PostgreSQL advisory lock): presenting a
 * rotated refresh token twice counts as theft and revokes the grant (oauth/store.ts), so two
 * previews racing on one expired token must never both rotate it.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AdminChatLinkInfo, ChatLinkInfo, User } from '../../../shared/contracts.js';
import { recordAudit } from '../../audit.js';
import * as authStore from '../../auth/store.js';
import { query, queryOne, withTransaction } from '../../db/pool.js';
import * as oauthStore from '../../oauth/store.js';
import { decryptSecret, encryptSecret } from '../../secretCrypto.js';
import type { ChatPlatform } from './config.js';

export const PENDING_TTL_SECONDS = 10 * 60;
export const PENDING_UNFURL_TTL_MINUTES = 30;
/** An access token this close to expiry is refreshed first. */
const ACCESS_SKEW_MS = 60_000;

export const INTERNAL_CLIENTS: Record<ChatPlatform, { clientId: string; clientName: string }> = {
  slack: { clientId: 'folio_chat_slack', clientName: 'Folio link previews for Slack' },
  teams: { clientId: 'folio_chat_teams', clientName: 'Folio link previews for Microsoft Teams' },
};

export function chatCallbackUrl(base: string): string {
  return `${base}/api/integrations/chat/callback`;
}

/** Creates or refreshes the internal OAuth client of `platform`, its redirect URI on this instance's current address. */
export async function ensureInternalClient(platform: ChatPlatform, base: string): Promise<oauthStore.OAuthClient> {
  const c = INTERNAL_CLIENTS[platform];
  return oauthStore.upsertInternalClient({ clientId: c.clientId, clientName: c.clientName, redirectUri: chatCallbackUrl(base) });
}

const sha256 = (raw: string): string => createHash('sha256').update(raw).digest('hex');
export const randomSecret = (bytes = 32): string => randomBytes(bytes).toString('base64url');

// ---------------------------------------------------------------------------
// Connections in progress
// ---------------------------------------------------------------------------

export interface PendingIdentity {
  tenantId: string;
  platformUserId: string;
  platformUserName: string | null;
}

export interface PendingConnect {
  platform: ChatPlatform;
  identity: PendingIdentity | null;
  oidcNonce: string | null;
  codeVerifier: string | null;
}

interface PendingRow {
  platform: ChatPlatform;
  tenant_id: string | null;
  platform_user_id: string | null;
  platform_user_name: string | null;
  oidc_nonce: string | null;
  code_verifier_enc: Buffer | null;
}

function rowToPending(row: PendingRow): PendingConnect {
  return {
    platform: row.platform,
    identity: row.tenant_id && row.platform_user_id ? { tenantId: row.tenant_id, platformUserId: row.platform_user_id, platformUserName: row.platform_user_name } : null,
    oidcNonce: row.oidc_nonce,
    codeVerifier: row.code_verifier_enc ? decryptSecret(row.code_verifier_enc) : null,
  };
}

/** Expired attempts go; a Teams attempt abandoned after the Folio consent also takes its (never used) grant with it. */
async function prunePending(): Promise<void> {
  await query(
    `UPDATE oauth_grants SET revoked_at = now()
      WHERE revoked_at IS NULL AND id IN (SELECT grant_id FROM chat_connect_pending WHERE expires_at < now() AND grant_id IS NOT NULL)`,
  );
  await query(`DELETE FROM chat_connect_pending WHERE expires_at < now()`);
}

/** A new connection attempt; returns the raw nonce (the browser cookie and the OAuth `state`). */
export async function createPending(platform: ChatPlatform, fields: { identity?: PendingIdentity; oidcNonce?: string; codeVerifier?: string } = {}): Promise<string> {
  const nonce = randomSecret();
  await prunePending();
  await query(
    `INSERT INTO chat_connect_pending (nonce_hash, platform, tenant_id, platform_user_id, platform_user_name, oidc_nonce, code_verifier_enc, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
    [
      sha256(nonce),
      platform,
      fields.identity?.tenantId ?? null,
      fields.identity?.platformUserId ?? null,
      fields.identity?.platformUserName ?? null,
      fields.oidcNonce ?? null,
      fields.codeVerifier ? encryptSecret(fields.codeVerifier) : null,
      PENDING_TTL_SECONDS,
    ],
  );
  return nonce;
}

export async function getPending(nonce: string): Promise<PendingConnect | undefined> {
  const row = await queryOne<PendingRow>(`SELECT * FROM chat_connect_pending WHERE nonce_hash = $1 AND expires_at > now()`, [sha256(nonce)]);
  return row ? rowToPending(row) : undefined;
}

export async function setPendingIdentity(nonce: string, identity: PendingIdentity, codeVerifier: string): Promise<void> {
  await query(
    `UPDATE chat_connect_pending SET tenant_id = $2, platform_user_id = $3, platform_user_name = $4, code_verifier_enc = $5, oidc_nonce = NULL
      WHERE nonce_hash = $1 AND expires_at > now()`,
    [sha256(nonce), identity.tenantId, identity.platformUserId, identity.platformUserName, encryptSecret(codeVerifier)],
  );
}

export async function deletePending(nonce: string): Promise<void> {
  await query(`DELETE FROM chat_connect_pending WHERE nonce_hash = $1`, [sha256(nonce)]);
}

/**
 * Teams: the Folio side is done, the tokens wait (encrypted) for the sign-in popup to hand Teams
 * the magic code, which Teams sends back in the next invoke of the SAME Teams user. Returns the code.
 */
export async function parkTeamsTokens(nonce: string, userId: string, tokens: oauthStore.IssuedTokens): Promise<string> {
  const magic = randomSecret(24);
  await query(
    `UPDATE chat_connect_pending
        SET user_id = $2, grant_id = $3, access_token_enc = $4, refresh_token_enc = $5, access_expires_at = now() + make_interval(secs => $6),
            magic_code_hash = $7, code_verifier_enc = NULL, expires_at = now() + make_interval(secs => $8)
      WHERE nonce_hash = $1`,
    [sha256(nonce), userId, tokens.grantId, encryptSecret(tokens.accessToken), encryptSecret(tokens.refreshToken), tokens.expiresIn, sha256(magic), PENDING_TTL_SECONDS],
  );
  return magic;
}

/** The magic code from a Teams invoke's `value.state`: completes the link when it belongs to this very Teams user. */
export async function completeTeamsLink(magicCode: string, identity: { tenantId: string; platformUserId: string; platformUserName: string | null }): Promise<boolean> {
  const row = await queryOne<{ user_id: string; grant_id: string; access_token_enc: Buffer; refresh_token_enc: Buffer; access_expires_at: string; platform_user_name: string | null }>(
    `DELETE FROM chat_connect_pending
      WHERE magic_code_hash = $1 AND platform = 'teams' AND tenant_id = $2 AND platform_user_id = $3 AND expires_at > now() AND grant_id IS NOT NULL
      RETURNING user_id, grant_id, access_token_enc, refresh_token_enc, access_expires_at, platform_user_name`,
    [sha256(magicCode), identity.tenantId, identity.platformUserId],
  );
  if (!row) return false;
  await storeLink({
    platform: 'teams',
    tenantId: identity.tenantId,
    platformUserId: identity.platformUserId,
    platformUserName: identity.platformUserName ?? row.platform_user_name,
    userId: row.user_id,
    grantId: row.grant_id,
    accessTokenEnc: row.access_token_enc,
    refreshTokenEnc: row.refresh_token_enc,
    accessExpiresAt: new Date(row.access_expires_at),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

interface StoreLinkInput {
  platform: ChatPlatform;
  tenantId: string;
  platformUserId: string;
  platformUserName: string | null;
  userId: string;
  grantId: string;
  accessTokenEnc: Buffer;
  refreshTokenEnc: Buffer;
  accessExpiresAt: Date;
}

/** Upsert by chat identity; a previous link of the same chat user loses its grant. */
async function storeLink(input: StoreLinkInput): Promise<void> {
  const previous = await queryOne<{ grant_id: string }>(
    `SELECT grant_id FROM chat_links WHERE platform = $1 AND tenant_id = $2 AND platform_user_id = $3`,
    [input.platform, input.tenantId, input.platformUserId],
  );
  await query(
    `INSERT INTO chat_links (platform, tenant_id, platform_user_id, platform_user_name, user_id, grant_id, access_token_enc, refresh_token_enc, access_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (platform, tenant_id, platform_user_id) DO UPDATE SET
       platform_user_name = EXCLUDED.platform_user_name, user_id = EXCLUDED.user_id, grant_id = EXCLUDED.grant_id,
       access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
       access_expires_at = EXCLUDED.access_expires_at, created_at = now(), last_used_at = NULL`,
    [input.platform, input.tenantId, input.platformUserId, input.platformUserName, input.userId, input.grantId, input.accessTokenEnc, input.refreshTokenEnc, input.accessExpiresAt],
  );
  if (previous && previous.grant_id !== input.grantId) await oauthStore.revokeGrant(previous.grant_id);
  recordAudit(input.userId, 'chat.linked', input.grantId, { platform: input.platform });
}

export async function saveLink(input: { platform: ChatPlatform; identity: PendingIdentity; userId: string; tokens: oauthStore.IssuedTokens }): Promise<void> {
  await storeLink({
    platform: input.platform,
    tenantId: input.identity.tenantId,
    platformUserId: input.identity.platformUserId,
    platformUserName: input.identity.platformUserName,
    userId: input.userId,
    grantId: input.tokens.grantId,
    accessTokenEnc: encryptSecret(input.tokens.accessToken),
    refreshTokenEnc: encryptSecret(input.tokens.refreshToken),
    accessExpiresAt: new Date(Date.now() + input.tokens.expiresIn * 1000),
  });
}

interface LinkRow {
  id: string;
  platform: ChatPlatform;
  user_id: string;
  grant_id: string;
  access_token_enc: Buffer;
  refresh_token_enc: Buffer;
  access_expires_at: string;
}

const inflight = new Map<string, Promise<string | null>>();

async function dropLink(id: string): Promise<void> {
  await query('DELETE FROM chat_links WHERE id = $1', [id]);
}

/** The Folio user id a link's tokens stand for right now, refreshing them if needed; null (and the link removed) when they no longer work. */
async function linkUserId(link: LinkRow): Promise<string | null> {
  if (new Date(link.access_expires_at).getTime() - ACCESS_SKEW_MS > Date.now()) {
    const resolved = await oauthStore.resolveAccessToken(decryptSecret(link.access_token_enc));
    if (resolved && resolved.grantId === link.grant_id) return resolved.userId;
    // a token pruned or a grant revoked: the refresh below settles which
  }
  const running = inflight.get(link.id);
  if (running) return running;
  const p = refreshLink(link.id).finally(() => inflight.delete(link.id));
  inflight.set(link.id, p);
  return p;
}

async function refreshLink(linkId: string): Promise<string | null> {
  const clientIdOf = (platform: ChatPlatform) => INTERNAL_CLIENTS[platform].clientId;
  const outcome = await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`chat_link:${linkId}`]);
    const { rows } = await client.query<LinkRow>('SELECT * FROM chat_links WHERE id = $1 FOR UPDATE', [linkId]);
    const link = rows[0];
    if (!link) return { userId: null as string | null, drop: false };
    // Another caller may have refreshed it while we waited for the lock.
    if (new Date(link.access_expires_at).getTime() - ACCESS_SKEW_MS > Date.now()) {
      const resolved = await oauthStore.resolveAccessToken(decryptSecret(link.access_token_enc));
      if (resolved && resolved.grantId === link.grant_id) return { userId: resolved.userId, drop: false };
    }
    const rotated = await oauthStore.rotateRefreshToken(decryptSecret(link.refresh_token_enc), clientIdOf(link.platform));
    if (!rotated.ok) return { userId: null, drop: true };
    await client.query(
      `UPDATE chat_links SET access_token_enc = $2, refresh_token_enc = $3, access_expires_at = now() + make_interval(secs => $4) WHERE id = $1`,
      [linkId, encryptSecret(rotated.tokens.accessToken), encryptSecret(rotated.tokens.refreshToken), rotated.tokens.expiresIn],
    );
    return { userId: rotated.grant.userId, drop: false };
  });
  if (outcome.drop) await dropLink(linkId);
  return outcome.userId;
}

/**
 * The Folio user behind a chat identity, or null: not linked, the grant revoked or expired, the
 * user disabled. Every preview goes through here.
 */
export async function resolveLinkedUser(platform: ChatPlatform, tenantId: string, platformUserId: string): Promise<User | null> {
  const link = await queryOne<LinkRow>(
    `SELECT l.* FROM chat_links l WHERE l.platform = $1 AND l.tenant_id = $2 AND l.platform_user_id = $3`,
    [platform, tenantId, platformUserId],
  );
  if (!link) return null;
  const userId = await linkUserId(link);
  if (!userId || userId !== link.user_id) {
    if (userId) await dropLink(link.id); // should never happen: the grant belongs to another user
    return null;
  }
  const user = await authStore.findUserById(userId);
  if (!user || user.disabled) return null;
  oauthStore.touchGrantLastUsed(link.grant_id);
  void query(`UPDATE chat_links SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [link.id]).catch(() => {});
  return user;
}

interface ListRow {
  id: string;
  platform: ChatPlatform;
  platform_user_name: string | null;
  created_at: string;
  last_used_at: string | null;
}
const toInfo = (r: ListRow): ChatLinkInfo => ({
  id: r.id,
  platform: r.platform,
  platformUserName: r.platform_user_name,
  createdAt: new Date(r.created_at).toISOString(),
  lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
});

/** The person's own live links (a link whose grant was revoked elsewhere is not shown, and is cleaned up). */
export async function listLinksForUser(userId: string): Promise<ChatLinkInfo[]> {
  await query(`DELETE FROM chat_links l USING oauth_grants g WHERE l.user_id = $1 AND g.id = l.grant_id AND g.revoked_at IS NOT NULL`, [userId]);
  const rows = await query<ListRow>(`SELECT id, platform, platform_user_name, created_at, last_used_at FROM chat_links WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return rows.map(toInfo);
}

async function removeLink(where: string, params: unknown[]): Promise<{ userId: string; platform: ChatPlatform } | undefined> {
  const row = await queryOne<{ user_id: string; grant_id: string; platform: ChatPlatform }>(`DELETE FROM chat_links WHERE ${where} RETURNING user_id, grant_id, platform`, params);
  if (!row) return undefined;
  await oauthStore.revokeGrant(row.grant_id);
  return { userId: row.user_id, platform: row.platform };
}

/** Disconnects one of the person's own links (revokes its grant). False when it is not theirs. */
export async function deleteLinkForUser(userId: string, id: string): Promise<boolean> {
  const removed = await removeLink('id = $1 AND user_id = $2', [id, userId]);
  if (removed) recordAudit(userId, 'chat.unlinked', id, { platform: removed.platform });
  return removed !== undefined;
}

export async function adminListLinks(): Promise<AdminChatLinkInfo[]> {
  await query(`DELETE FROM chat_links l USING oauth_grants g WHERE g.id = l.grant_id AND g.revoked_at IS NOT NULL`);
  const rows = await query<ListRow & { user_id: string; user_name: string; user_email: string }>(
    `SELECT l.id, l.platform, l.platform_user_name, l.created_at, l.last_used_at, u.id AS user_id, u.name AS user_name, u.email AS user_email
       FROM chat_links l JOIN users u ON u.id = l.user_id ORDER BY l.created_at DESC`,
  );
  return rows.map((r) => ({ ...toInfo(r), userId: r.user_id, userName: r.user_name, userEmail: r.user_email }));
}

export async function adminDeleteLink(actorId: string, id: string): Promise<boolean> {
  const removed = await removeLink('id = $1', [id]);
  if (removed) recordAudit(actorId, 'chat.unlinked_by_admin', id, { platform: removed.platform, user: removed.userId });
  return removed !== undefined;
}

export async function countLinks(): Promise<Record<ChatPlatform, number>> {
  const rows = await query<{ platform: ChatPlatform; n: number }>(
    `SELECT l.platform, COUNT(*)::int AS n FROM chat_links l JOIN oauth_grants g ON g.id = l.grant_id WHERE g.revoked_at IS NULL GROUP BY l.platform`,
  );
  const out: Record<ChatPlatform, number> = { slack: 0, teams: 0 };
  for (const r of rows) out[r.platform] = r.n;
  return out;
}

// ---------------------------------------------------------------------------
// Slack: messages waiting for their author to connect
// ---------------------------------------------------------------------------

export async function addPendingUnfurl(tenantId: string, platformUserId: string, payload: unknown): Promise<void> {
  await query(`DELETE FROM chat_pending_unfurls WHERE created_at < now() - make_interval(mins => $1)`, [PENDING_UNFURL_TTL_MINUTES]);
  await query(`INSERT INTO chat_pending_unfurls (tenant_id, platform_user_id, payload) VALUES ($1, $2, $3)`, [tenantId, platformUserId, JSON.stringify(payload)]);
}

export async function takePendingUnfurls<T>(tenantId: string, platformUserId: string): Promise<T[]> {
  const rows = await query<{ payload: T; fresh: boolean }>(
    `DELETE FROM chat_pending_unfurls WHERE tenant_id = $1 AND platform_user_id = $2
     RETURNING payload, created_at > now() - make_interval(mins => $3) AS fresh`,
    [tenantId, platformUserId, PENDING_UNFURL_TTL_MINUTES],
  );
  return rows.filter((r) => r.fresh).map((r) => r.payload);
}
