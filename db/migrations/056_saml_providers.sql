-- Single sign-on through SAML 2.0 (docs/AUTH.md, server/auth/saml.ts).
--
-- auth_providers.saml_config: a kind = 'saml' provider's settings (NULL for OIDC):
--   {"metadataUrl", "metadataXml", "idpEntityId", "ssoUrl", "idpCert",
--    "spEntityId", "nameIdFormat", "emailAuthoritative", "allowIdpInitiated"}
-- Nothing in it is secret (IdP certificates are public), so env providers
-- (FOLIO_SAML_<SLUG>_*) store it here too. For a SAML row, `issuer` holds the
-- IdP entity ID when known at save time (else the metadata URL, for display)
-- and `client_id` the SP entity ID override ('' = the default metadata URL).
ALTER TABLE auth_providers ADD COLUMN IF NOT EXISTS saml_config jsonb;

-- One-time use of SAML assertions: the ID of every accepted assertion, kept
-- until the assertion itself would expire (NotOnOrAfter + clock skew). A
-- second POST of the same assertion to the ACS is refused as a replay.
CREATE TABLE IF NOT EXISTS saml_assertion_ids (
  issuer       text NOT NULL,
  assertion_id text NOT NULL,
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (issuer, assertion_id)
);
CREATE INDEX IF NOT EXISTS saml_assertion_ids_expires_idx ON saml_assertion_ids (expires_at);
