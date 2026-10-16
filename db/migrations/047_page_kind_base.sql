-- Obsidian Bases (16.10.2026): a ninth page kind. A `*.base` file (Obsidian's
-- Bases YAML: filters, formulas, views) is a VIEW over the pages of its space —
-- shown as a table / cards / list, edited by the visual editor (shared/bases/**,
-- server/bases/**). Like a pdf its id lives only in pages_index (the file is
-- Obsidian's and carries none).
-- Numbered 047: 045 (chat links) and 046 (canvas) are taken by branches in
-- flight. The set below already includes 'canvas' so the two migrations can
-- land in either order and the last one leaves both kinds allowed.
ALTER TABLE pages_index DROP CONSTRAINT IF EXISTS pages_index_kind_check;
ALTER TABLE pages_index ADD CONSTRAINT pages_index_kind_check
  CHECK (kind IN ('doc', 'board', 'table', 'pdf', 'office', 'form', 'canvas', 'base'));

-- trash_items.kind mirrors the page kinds plus its own 'folder'/'space'.
ALTER TABLE trash_items DROP CONSTRAINT IF EXISTS trash_items_kind_check;
ALTER TABLE trash_items ADD CONSTRAINT trash_items_kind_check
  CHECK (kind IN ('doc', 'board', 'table', 'pdf', 'office', 'form', 'canvas', 'base', 'folder', 'space'));
