-- Artifacts (21.10.2026): a tenth page kind. A `<slug>.artifact/` DIRECTORY (a
-- bundle: artifact.yaml + an HTML entry + assets) is one page — a Claude
-- artifact, a Cursor canvas or any self-contained HTML page, shown in a
-- sandboxed iframe (docs/spec-artifacts.md, server/artifact/**). Like a pdf its
-- id lives only in pages_index.
ALTER TABLE pages_index DROP CONSTRAINT IF EXISTS pages_index_kind_check;
ALTER TABLE pages_index ADD CONSTRAINT pages_index_kind_check
  CHECK (kind IN ('doc', 'board', 'table', 'pdf', 'office', 'form', 'canvas', 'base', 'artifact'));

-- trash_items.kind mirrors the page kinds plus its own 'folder'/'space'.
ALTER TABLE trash_items DROP CONSTRAINT IF EXISTS trash_items_kind_check;
ALTER TABLE trash_items ADD CONSTRAINT trash_items_kind_check
  CHECK (kind IN ('doc', 'board', 'table', 'pdf', 'office', 'form', 'canvas', 'base', 'artifact', 'folder', 'space'));

-- What an artifact keeps through window.storage / localStorage (the bridge):
-- user_id NULL = the state shared by every reader of the page, otherwise the
-- reader's own. No foreign key to pages_index on purpose: the row of a page is
-- dropped and re-created by scans (trash and restore keep the id), and the
-- state must survive that. Values are strings (spec limits: key ≤ 200 chars,
-- value ≤ 256 KB, ≤ 5 MB per reader per page and 5 MB shared — enforced by
-- server/artifact/state.ts).
CREATE TABLE IF NOT EXISTS artifact_state (
  page_id    text NOT NULL,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_state_key_idx
  ON artifact_state (page_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), key);
