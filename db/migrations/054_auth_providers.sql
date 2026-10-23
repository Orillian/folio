-- Single sign-on through any OpenID Connect provider (Keycloak, Authentik,
-- Entra ID, Okta, Google...). See docs/AUTH.md.
--
-- auth_providers: one row per configured identity provider. A provider comes
-- either from the environment (source = 'env', FOLIO_OIDC_<SLUG>_* or the
-- legacy GOOGLE_* variables; the row is kept in sync at boot and is read-only
-- in the admin UI, its client secret is never stored here) or from the admin
-- screen /admin/auth (source = 'db', client secret encrypted with FOLIO_SECRET,
-- server/secretCrypto.ts). kind leaves room for 'saml' later.
CREATE TABLE IF NOT EXISTS auth_providers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  kind               text NOT NULL DEFAULT 'oidc' CHECK (kind IN ('oidc', 'saml')),
  source             text NOT NULL DEFAULT 'db' CHECK (source IN ('db', 'env')),
  display_name       text NOT NULL,
  -- The issuer identifier (discovery is <issuer>/.well-known/openid-configuration),
  -- or a full discovery document URL.
  issuer             text NOT NULL,
  client_id          text NOT NULL,
  client_secret_enc  bytea,
  scopes             text NOT NULL DEFAULT 'openid email profile',
  -- Which claim carries what: {"email": "email", "name": "name", "groups": "groups"}.
  claim_mapping      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Lower-case email domains: who may sign in through this provider, which
  -- emails the login page routes to it, which existing accounts it may link.
  allowed_domains    text[] NOT NULL DEFAULT '{}',
  jit_enabled        boolean NOT NULL DEFAULT false,
  -- {"space-slug": "viewer" | "editor" | "admin"} granted to a just-created account.
  jit_default_spaces jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Accounts in allowed_domains cannot use a password (instance admins keep
  -- an audited break-glass login at /login?local).
  enforce_sso        boolean NOT NULL DEFAULT false,
  enabled            boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- A person's account at a provider: (issuer, subject) is the stable key, never
-- the email. groups is the raw value of the provider's groups claim as last
-- seen at sign-in (mapped to Folio groups later; nothing reads it yet).
CREATE TABLE IF NOT EXISTS user_identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id   uuid NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  issuer        text NOT NULL,
  subject       text NOT NULL,
  email         citext,
  groups        jsonb,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
CREATE INDEX IF NOT EXISTS user_identities_user_idx ON user_identities (user_id);
CREATE INDEX IF NOT EXISTS user_identities_provider_user_idx ON user_identities (provider_id, user_id);

-- Existing "Sign in with Google" accounts (users.google_sub, migration 027)
-- become identities of a 'google' provider. The row is created disabled; boot
-- (server/auth/providers.ts) enables it and fills it from GOOGLE_CLIENT_ID /
-- GOOGLE_CLIENT_SECRET / GOOGLE_ALLOWED_DOMAINS when those are set.
-- users.google_sub stays for now but nothing writes or reads it any more.
INSERT INTO auth_providers (slug, kind, source, display_name, issuer, client_id, enabled, jit_enabled)
SELECT 'google', 'oidc', 'env', 'Google', 'https://accounts.google.com', '', false, false
 WHERE EXISTS (SELECT 1 FROM users WHERE google_sub IS NOT NULL)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO user_identities (user_id, provider_id, issuer, subject, email)
SELECT u.id, p.id, 'https://accounts.google.com', u.google_sub, u.email
  FROM users u
  JOIN auth_providers p ON p.slug = 'google'
 WHERE u.google_sub IS NOT NULL
ON CONFLICT (issuer, subject) DO NOTHING;
