/**
 * The authorization_code grant (RFC 6749 §4.1.3 + PKCE RFC 7636 §4.6), shared by the HTTP token
 * endpoint (routes.ts) and Folio's own internal clients (the Slack and Teams link previews,
 * server/integrations/chat), which redeem their code in-process instead of calling themselves
 * over HTTP. One implementation, so the checks can never drift apart:
 *   - code, client, redirect_uri and the PKCE verifier must all match before anything else is said;
 *   - a replayed code (already used) revokes the grant it produced;
 *   - a disabled owner gets nothing.
 */
import type { ApiTokenScope } from '../../shared/contracts.js';
import { recordAudit } from '../audit.js';
import * as authStore from '../auth/store.js';
import * as store from './store.js';
import { isValidCodeVerifier, pkceMatches } from './validate.js';

export type CodeExchangeOutcome =
  | { ok: true; tokens: store.IssuedTokens; userId: string; scopes: ApiTokenScope[] }
  | { ok: false; error: 'invalid_request' | 'invalid_grant'; description: string };

export async function exchangeAuthorizationCode(input: { clientId: string; code?: string; redirectUri?: string; codeVerifier?: string }): Promise<CodeExchangeOutcome> {
  const { clientId, code, redirectUri, codeVerifier } = input;
  if (!code || !redirectUri || !codeVerifier) return { ok: false, error: 'invalid_request', description: 'code, redirect_uri and code_verifier are required' };
  if (!isValidCodeVerifier(codeVerifier)) return { ok: false, error: 'invalid_grant', description: 'code_verifier is not valid' };
  const row = await store.findCode(code);
  if (!row || row.clientId !== clientId || row.redirectUri !== redirectUri || !pkceMatches(codeVerifier, row.codeChallenge)) {
    return { ok: false, error: 'invalid_grant', description: 'the authorization code is invalid' };
  }
  // Everything the caller must prove has been proven; only now is a replay conclusive.
  if (row.usedAt) {
    if (row.grantId) await store.revokeGrant(row.grantId);
    recordAudit(row.userId, 'oauth.code_replayed', row.clientId);
    return { ok: false, error: 'invalid_grant', description: 'the authorization code was already used' };
  }
  if (row.expired) return { ok: false, error: 'invalid_grant', description: 'the authorization code has expired' };
  const owner = await authStore.findUserById(row.userId);
  if (!owner || owner.disabled) return { ok: false, error: 'invalid_grant', description: 'the authorization code is invalid' };
  const grantId = await store.createGrant({ userId: row.userId, clientId: row.clientId, scopes: row.scopes, resource: row.resource });
  if (!(await store.markCodeUsed(code, grantId))) {
    await store.revokeGrant(grantId);
    return { ok: false, error: 'invalid_grant', description: 'the authorization code was already used' };
  }
  const tokens = await store.issueFirstTokens(grantId);
  recordAudit(row.userId, 'oauth.connected', grantId, { client: row.clientId, scopes: row.scopes });
  return { ok: true, tokens, userId: row.userId, scopes: row.scopes };
}
