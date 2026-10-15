-- Saved searches (Obsidian brief, wave 3, 14.10.2026). Forward-only, safe to re-run.
--
-- A person's named search: the query text exactly as typed in the search box
-- (the operator grammar of shared/searchQuery.ts lives in the text, nothing is
-- parsed or stored separately), optionally pinned to one space. At most 50 per
-- user (server/savedSearches.ts enforces it under a per-user advisory lock).
--
--   space_slug  the space the search is pinned to; NULL = every space the person
--               can see. A search pinned to a space that is deleted goes with it
--               (ON DELETE CASCADE) rather than quietly widening to all spaces.
CREATE TABLE IF NOT EXISTS saved_searches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  query      text NOT NULL,
  space_slug text REFERENCES spaces(slug) ON DELETE CASCADE ON UPDATE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_searches_user_idx ON saved_searches (user_id, created_at);
