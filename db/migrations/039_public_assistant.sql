-- "Ask Folio AI" on a public site (13.10.2026): anonymous visitors of a
-- published space (visibility 'public', public_allow_assistant) ask questions
-- about that ONE space. Every assistant table (ai_conversations, ai_runs,
-- ai_unanswered_questions, ...) has `user_id NOT NULL REFERENCES users`, so the
-- anonymous visitor is represented by one built-in SYSTEM user.
--
-- 1. users.is_system - a system account is never a person: it cannot sign in
--    (password login, Google, invites), never gets a session or an API token,
--    never appears in a people listing (GET /api/users, the access matrix,
--    @mentions, page-access candidates) and never counts as "the instance has
--    users" for the first-run setup. Its access is decided in code, not by
--    memberships: server/auth/session.ts gives it an implicit viewer role in
--    PUBLIC spaces only (the public page set: no restricted page, no
--    `.agent/**`, no `_templates/`), and the assistant's tools additionally
--    confine a public run to the one space it was started from.
--
-- 2. The public visitor user, fixed id 00000000-0000-4000-8000-0000000f0110
--    (server/auth/store.ts PUBLIC_VISITOR_USER_ID). No password (NULL), not an
--    admin, not disabled. Admin analytics show public conversations as this
--    user ("Public visitor").
--
-- 3. ai_conversations.public_space / guest_token_hash - a public conversation
--    belongs to the visitor user AND to one space; the browser that started it
--    holds a random guest token (returned once, never stored in clear: only
--    its sha256, like sessions and API tokens). Continuing the conversation,
--    reading its run events, stopping a run and reloading its messages all
--    require that token. NULL for every ordinary (signed-in) conversation.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

INSERT INTO users (id, email, name, password_hash, is_admin, disabled, is_system)
VALUES ('00000000-0000-4000-8000-0000000f0110', 'public-visitor@folio.local', 'Public visitor', NULL, false, false, true)
ON CONFLICT DO NOTHING;

ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS guest_token_hash text;
ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS public_space text;
CREATE INDEX IF NOT EXISTS ai_conversations_guest_token_idx ON ai_conversations (guest_token_hash) WHERE guest_token_hash IS NOT NULL;
