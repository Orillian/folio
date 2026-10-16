-- Obsidian canvas (16.10.2026): an eighth page kind. A `*.canvas` file (JSON
-- Canvas 1.0) is shown read-only and never written by Folio (shared/canvas/**,
-- server/canvasView.ts) — same shape 026/028/030 used for 'pdf'/'office'/'form'.
-- Numbered 046, not 045: 045 is taken by another branch in flight (chat links).
ALTER TABLE pages_index DROP CONSTRAINT IF EXISTS pages_index_kind_check;
ALTER TABLE pages_index ADD CONSTRAINT pages_index_kind_check
  CHECK (kind IN ('doc', 'board', 'table', 'pdf', 'office', 'form', 'canvas'));

-- trash_items.kind mirrors the page kinds plus its own 'folder'/'space'.
ALTER TABLE trash_items DROP CONSTRAINT IF EXISTS trash_items_kind_check;
ALTER TABLE trash_items ADD CONSTRAINT trash_items_kind_check
  CHECK (kind IN ('doc', 'board', 'table', 'pdf', 'office', 'form', 'canvas', 'folder', 'space'));

-- A file card of a canvas is a link of its own syntax (page_links.syntax): its
-- path is from the space root and matched exactly (indexV2/resolve.ts).
ALTER TABLE page_links DROP CONSTRAINT IF EXISTS page_links_syntax_check;
ALTER TABLE page_links ADD CONSTRAINT page_links_syntax_check
  CHECK (syntax IN ('md', 'wikilink', 'embed', 'image', 'html', 'reference', 'canvas'));
