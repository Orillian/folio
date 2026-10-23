/**
 * SCIM-provisioned accounts and sign-in (migration 059). Used by the SCIM layer (users.ts) and by the shared
 * sign-in decision (auth/sso.ts).
 *
 * A person created (or adopted) over SCIM gets a user_identities row at the provider straight away, so the
 * provider's token can manage the account before the person ever signs in. Until then the row is a PLACEHOLDER:
 * issuer = 'urn:folio:scim:<provider id>', subject = the account id — it can never match a real sign-in by itself.
 *
 * How a SCIM-created account is matched at its first sign-in through the same provider (sso.ts), in order:
 *  1. the identity (issuer, subject) the provider presents already exists -> that account (nothing SCIM-specific);
 *  2. a placeholder of THIS provider whose SCIM externalId equals the sign-in subject (an IdP that uses one id
 *     for both, e.g. Keycloak's user id; Okta's user id when externalId is mapped to it) — or, for a SAML provider,
 *     whose SCIM userName equals the NameID (Entra ID and Okta send the UPN / username in both by default) ->
 *     that account; the placeholder becomes the real identity;
 *  3. otherwise the existing linking rule: an account with the same email, linked only when the email counts as
 *     verified (OIDC email_verified; SAML: provider marked authoritative) and its domain is allowed — the
 *     placeholder of that account is then replaced by the real identity (not an "already linked" refusal).
 *  2b. no identity and no step-2 match, but a placeholder of THIS provider whose SCIM email (or userName) equals the
 *     sign-in email, case-insensitively and exactly, with the email's domain in the provider's allowed domains (when
 *     that list is non-empty) -> that account, even without email_verified. Owner decision 22.10.2026/23.10.2026:
 *     Entra ID over OIDC sends no email_verified and a per-app `sub`, and the SCIM channel already vouches for the
 *     email. Only ever a placeholder, never an ordinary account (those keep step 3), never another provider's.
 * Both values in step 2 come from the same provider (its SCIM channel and its signed sign-in answer), never from
 * the person. JIT creation is off while SCIM is on (tokens.ts isScimEnabled).
 */
import { query, queryOne } from '../db/pool.js';
import { groupsColumnValue } from '../auth/groupSyncConfig.js';

export const SCIM_PLACEHOLDER_ISSUER_PREFIX = 'urn:folio:scim:';

export function placeholderIssuer(providerId: string): string {
  return `${SCIM_PLACEHOLDER_ISSUER_PREFIX}${providerId}`;
}

/** Step 2: a placeholder of `providerId` waiting for this subject. */
export async function findPendingScimIdentity(
  providerId: string,
  subject: string,
  opts: { matchUserName: boolean },
): Promise<{ id: string; userId: string } | undefined> {
  const row = await queryOne<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM user_identities
      WHERE provider_id = $1 AND issuer = $2 AND scim_deleted_at IS NULL
        AND (scim_external_id = $3 OR ($4 AND lower(scim_user_name) = lower($3)))
      ORDER BY (scim_external_id = $3) DESC NULLS LAST, created_at
      LIMIT 1`,
    [providerId, placeholderIssuer(providerId), subject, opts.matchUserName],
  );
  return row ? { id: row.id, userId: row.user_id } : undefined;
}

/** Step 2b: a placeholder of `providerId` whose SCIM email or userName is exactly `email` (case-insensitive). */
export async function findPendingScimIdentityByEmail(
  providerId: string,
  email: string,
): Promise<{ id: string; userId: string } | undefined> {
  const row = await queryOne<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM user_identities
      WHERE provider_id = $1 AND issuer = $2 AND scim_deleted_at IS NULL
        AND (lower(email::text) = lower($3) OR lower(scim_user_name) = lower($3))
      ORDER BY (lower(email::text) = lower($3)) DESC, created_at
      LIMIT 1`,
    [providerId, placeholderIssuer(providerId), email.trim()],
  );
  return row ? { id: row.id, userId: row.user_id } : undefined;
}

/**
 * The account's placeholder at `providerId` becomes the real identity (steps 2 and 3). True when there was one.
 * The SCIM columns (externalId, userName, scim_provisioned) stay: the provider keeps managing the account.
 */
export async function completeScimPlaceholder(
  providerId: string,
  userId: string,
  identity: { issuer: string; subject: string; email: string | null; groups: unknown },
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE user_identities SET issuer = $3, subject = $4, email = COALESCE($5, email), groups = $6, last_login_at = now()
      WHERE provider_id = $1 AND user_id = $2 AND issuer = $7
      RETURNING id`,
    [providerId, userId, identity.issuer, identity.subject, identity.email, groupsColumnValue(identity.groups), placeholderIssuer(providerId)],
  );
  return rows.length > 0;
}
