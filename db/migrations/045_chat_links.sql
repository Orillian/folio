-- Link previews in Slack and Microsoft Teams (16.10.2026). Forward-only, safe to re-run.
--
-- A chat user (a Slack member of one workspace, a Teams user of one tenant) is linked to ONE
-- Folio user through Folio's own OAuth 2.1 flow (authorization code + PKCE, scope read): the
-- link holds the OAuth grant and its tokens, so revoking the grant (Settings, API tokens) or
-- disabling the user ends the previews at once. Tokens are AES-256-GCM with FOLIO_SECRET
-- (server/secretCrypto.ts), like saved git credentials.
--
--   oauth_clients.source 'internal'  Folio's own clients (folio_chat_slack, folio_chat_teams):
--                                    created by the server, never self-registered, never pruned.
--   chat_links                       one row per chat user; (platform, tenant_id, platform_user_id)
--                                    is unique. tenant_id is the Slack team id or the Entra tenant id;
--                                    platform_user_id the Slack user id or the Entra object id.
--   chat_connect_pending             a connection being made (10 minutes): the browser-binding
--                                    nonce (sha256), the PKCE verifier, the chat identity once known,
--                                    and for Teams the tokens waiting for the sign-in popup's code.
--   chat_pending_unfurls             Slack messages whose links were not previewed because their
--                                    author had not connected yet; previewed after they do (30 min).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_clients_source_check') THEN
    ALTER TABLE oauth_clients DROP CONSTRAINT oauth_clients_source_check;
  END IF;
END $$;
ALTER TABLE oauth_clients ADD CONSTRAINT oauth_clients_source_check CHECK (source IN ('dcr', 'cimd', 'internal'));

CREATE TABLE IF NOT EXISTS chat_links (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform           text NOT NULL CHECK (platform IN ('slack', 'teams')),
  tenant_id          text NOT NULL,
  platform_user_id   text NOT NULL,
  platform_user_name text,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_id           uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  access_token_enc   bytea NOT NULL,
  refresh_token_enc  bytea NOT NULL,
  access_expires_at  timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  UNIQUE (platform, tenant_id, platform_user_id)
);
CREATE INDEX IF NOT EXISTS chat_links_user_idx ON chat_links (user_id);

CREATE TABLE IF NOT EXISTS chat_connect_pending (
  nonce_hash         text PRIMARY KEY,
  platform           text NOT NULL CHECK (platform IN ('slack', 'teams')),
  tenant_id          text,
  platform_user_id   text,
  platform_user_name text,
  oidc_nonce         text,
  code_verifier_enc  bytea,
  user_id            uuid REFERENCES users(id) ON DELETE CASCADE,
  grant_id           uuid REFERENCES oauth_grants(id) ON DELETE CASCADE,
  access_token_enc   bytea,
  refresh_token_enc  bytea,
  access_expires_at  timestamptz,
  magic_code_hash    text,
  expires_at         timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_connect_pending_magic_idx ON chat_connect_pending (magic_code_hash) WHERE magic_code_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_pending_unfurls (
  id               bigserial PRIMARY KEY,
  tenant_id        text NOT NULL,
  platform_user_id text NOT NULL,
  payload          jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_pending_unfurls_user_idx ON chat_pending_unfurls (tenant_id, platform_user_id);
