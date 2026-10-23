-- Session management and the audit log screen.
--
-- sessions: what an admin / the person needs to recognise a session in a list ("Chrome on macOS,
-- 203.0.113.7, last active 5 minutes ago"). last_seen_at is a throttled bookkeeping column
-- (server/auth/store.ts touchSession: at most once per 5 minutes per session); user_agent is
-- truncated by the server, ip is request.ip (the real client address only with TRUST_PROXY set).
-- created_at already exists since 001_init.sql.
-- id: an opaque handle for the list / revoke API (token_hash, the primary key, is never sent out).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS sessions_id_idx ON sessions (id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip text;

-- audit_log: the /admin/audit screen filters by actor, action prefix and target and pages by id
-- (keyset), newest first. The table had a single partial index (033) and the primary key.
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor_id, id DESC);
CREATE INDEX IF NOT EXISTS audit_log_target_idx ON audit_log (target, id DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action text_pattern_ops, id DESC);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at);
