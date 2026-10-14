-- "Connect with GitHub" (OAuth App): a saved git credential is now either a
-- pasted personal access token ('pat', every row before this migration) or a
-- token obtained through the OAuth authorization-code flow ('oauth', see
-- server/auth/githubConnect.ts). account_login is the provider account the
-- OAuth token belongs to (GitHub login), shown in the "Git access" list; NULL
-- for a pasted token, whose owner Folio never looks up.
ALTER TABLE git_credentials ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'pat';
ALTER TABLE git_credentials DROP CONSTRAINT IF EXISTS git_credentials_source_check;
ALTER TABLE git_credentials ADD CONSTRAINT git_credentials_source_check CHECK (source IN ('pat', 'oauth'));
ALTER TABLE git_credentials ADD COLUMN IF NOT EXISTS account_login text;
