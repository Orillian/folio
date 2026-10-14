-- Shared Folio AI keys (13.10.2026). Until now the Cursor key was strictly
-- per user (user_assistant_settings). This adds two shared levels so an admin
-- can pay for the assistant once for everybody:
--   * instance_assistant_settings - ONE row (id = 1): an instance-wide key set
--     by an instance admin, plus the instance policy `personal_keys_allowed`
--     (false = members may not use their own key, the shared key is used for
--     everyone and a stored personal key is ignored).
--   * space_assistant_settings - one optional key per space, set by a space
--     admin (or an instance admin); removed together with the space.
-- Keys are encrypted exactly like the personal key (server/secretCrypto.ts,
-- FOLIO_SECRET) and are never returned by any API - only the Cursor key name
-- and who set it when. Resolution order at run time (server/assistant/routes.ts
-- resolveApiKey): personal -> space -> instance -> CURSOR_API_KEY.
CREATE TABLE IF NOT EXISTS instance_assistant_settings (
  id                    smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cursor_key_enc        bytea,
  cursor_key_name       text,
  cursor_email          text,
  personal_keys_allowed boolean NOT NULL DEFAULT true,
  updated_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO instance_assistant_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS space_assistant_settings (
  space_slug      text PRIMARY KEY REFERENCES spaces(slug) ON DELETE CASCADE,
  cursor_key_enc  bytea NOT NULL,
  cursor_key_name text,
  cursor_email    text,
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
