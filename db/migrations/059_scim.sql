-- SCIM 2.0 provisioning (RFC 7643 / 7644 subset; server/scim/, docs/AUTH.md).
--
-- An identity provider (Okta, Entra ID, Keycloak, OneLogin, JumpCloud...) that
-- is already configured as an OIDC or SAML sign-in provider (054, 056) can
-- also create, update and deactivate the people and groups it owns, through
-- /scim/v2 with a bearer token generated in /admin/auth.
--
-- scim_tokens: the provider's bearer token, stored as sha256(token) only (the
-- raw value is shown once, at generation). At most one active token per
-- provider: rotating revokes the old one in the same transaction. "SCIM is
-- enabled for a provider" means exactly "it has an active token" — and then
-- JIT account creation at sign-in is off for that provider (sso.ts).
CREATE TABLE IF NOT EXISTS scim_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  uuid NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  -- The first characters of the raw token, so an admin can tell tokens apart.
  token_prefix text NOT NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Last authenticated SCIM request with this token ("last sync" in /admin/auth).
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS scim_tokens_one_active_per_provider ON scim_tokens (provider_id) WHERE revoked_at IS NULL;

-- A SCIM-provisioned person is a Folio account plus its user_identities row at
-- the provider. Until the person first signs in, the row is a placeholder:
-- issuer = 'urn:folio:scim:<provider id>', subject = the account id. The first
-- sign-in through the provider replaces both with the real (issuer, subject)
-- (sso.ts: by externalId — or, for SAML, the userName — equal to the subject;
-- otherwise by the existing verified-email linking rule).
--   scim_provisioned  the provider manages this account through SCIM (any SCIM write sets it)
--   scim_external_id  the IdP's externalId (Entra: mailNickname or objectId; Keycloak: the user id)
--   scim_user_name    the SCIM userName (usually the email / UPN)
--   scim_attributes   what else SCIM said that Folio keeps: {"name": {...}, "displayName": ...}
--   scim_deleted_at   DELETE /Users/:id — the account is deactivated (never deleted) and hidden from SCIM
ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS scim_provisioned boolean NOT NULL DEFAULT false;
ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS scim_external_id text;
ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS scim_user_name text;
ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS scim_attributes jsonb;
ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS scim_updated_at timestamptz;
ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS scim_deleted_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS user_identities_scim_external_id_key ON user_identities (provider_id, scim_external_id) WHERE scim_external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_identities_scim_user_name_idx ON user_identities (provider_id, lower(scim_user_name)) WHERE scim_user_name IS NOT NULL;

-- A group created over SCIM (groups.source = 'scim', external_id = the IdP's
-- externalId when it sends one) belongs to the provider whose token created
-- it: only that token sees or changes it. DELETE /Groups/:id archives it.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS scim_provider_id uuid REFERENCES auth_providers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS groups_scim_provider_idx ON groups (scim_provider_id) WHERE scim_provider_id IS NOT NULL;
