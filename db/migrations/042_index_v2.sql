-- Index v2 (Obsidian vault compatibility, wave 1b, 14.10.2026). Forward-only,
-- safe to re-run.
--
-- One mdast parse per document page (server/indexV2/parse.ts), at scan and at
-- save, feeds the derived tables below; links are resolved in a SECOND,
-- set-based phase per space (server/indexV2/store.ts resolveLinks), so a target
-- that appears later resolves old links and a deleted target turns its links
-- into 'unresolved' instead of deleting them. Table names are fixed in
-- docs/spec.md §7.4.
--
--   pages_index.meta_version  parser version the row's metadata was built with
--                             (shared/contracts.ts INDEX_META_VERSION); the scan
--                             re-parses documents below it even when their
--                             mtime/size are unchanged. 0 = never parsed.
--   pages_index.frontmatter   the document's whole front matter as jsonb ({}
--                             when it has none; NULL for non-documents).
--   page_headings             level, text (label), slug (the outline's anchor,
--                             duplicate suffixes included), line, position.
--   page_blocks               `^block-id`s and their line.
--   page_tags                 body `#tags` (with line) and front matter
--                             `tags:`/`labels:` (line NULL).
--   page_links                every link of every syntax, typed and positioned.
--                             target_page_id is ON DELETE SET NULL: deleting the
--                             target keeps the row, the resolution phase marks
--                             it 'unresolved'.
--
-- The old `links` table becomes a VIEW over page_links with its old columns
-- (kind 'unresolved' shown as 'broken'), so any reader not yet migrated keeps
-- working; every write goes to page_links. The view is simple enough to stay
-- auto-updatable for DELETE.

ALTER TABLE pages_index ADD COLUMN IF NOT EXISTS meta_version int NOT NULL DEFAULT 0;
ALTER TABLE pages_index ADD COLUMN IF NOT EXISTS frontmatter jsonb;
CREATE INDEX IF NOT EXISTS pages_index_frontmatter_idx ON pages_index USING GIN (frontmatter);

CREATE TABLE IF NOT EXISTS page_headings (
  page_id  text NOT NULL REFERENCES pages_index(id) ON DELETE CASCADE,
  position int NOT NULL,
  level    smallint NOT NULL CHECK (level BETWEEN 1 AND 6),
  text     text NOT NULL,
  slug     text NOT NULL,
  line     int NOT NULL,
  PRIMARY KEY (page_id, position)
);
CREATE INDEX IF NOT EXISTS page_headings_slug_idx ON page_headings (page_id, slug);

CREATE TABLE IF NOT EXISTS page_blocks (
  page_id  text NOT NULL REFERENCES pages_index(id) ON DELETE CASCADE,
  block_id text NOT NULL,
  line     int NOT NULL,
  UNIQUE (page_id, block_id)
);

CREATE TABLE IF NOT EXISTS page_tags (
  page_id text NOT NULL REFERENCES pages_index(id) ON DELETE CASCADE,
  tag     text NOT NULL,
  source  text NOT NULL CHECK (source IN ('body', 'frontmatter')),
  line    int
);
CREATE INDEX IF NOT EXISTS page_tags_tag_idx ON page_tags (tag);
CREATE INDEX IF NOT EXISTS page_tags_page_idx ON page_tags (page_id);

-- target_path: what the link points at, space-relative — for a markdown-style
-- link the path resolved against the source's folder; for a wikilink the page
-- it resolved to, or the `.md` file it would create. link_path: the target as
-- written (no fragment), which the resolution phase re-reads.
-- fragment_key: what the fragment is matched by (a heading slug, a lowercased
-- block id); fragment_resolved is NULL without a fragment or a page target.
CREATE TABLE IF NOT EXISTS page_links (
  id                bigserial PRIMARY KEY,
  source_page_id    text NOT NULL REFERENCES pages_index(id) ON DELETE CASCADE,
  target_path       text NOT NULL,
  link_path         text NOT NULL,
  target_page_id    text REFERENCES pages_index(id) ON DELETE SET NULL,
  syntax            text NOT NULL CHECK (syntax IN ('md', 'wikilink', 'embed', 'image', 'html', 'reference')),
  kind              text NOT NULL CHECK (kind IN ('page', 'asset', 'external', 'unresolved')),
  fragment          text,
  fragment_kind     text CHECK (fragment_kind IN ('heading', 'block')),
  fragment_key      text,
  fragment_resolved boolean,
  display_text      text,
  line              int NOT NULL DEFAULT 0,
  context           text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS page_links_source_idx ON page_links (source_page_id);
CREATE INDEX IF NOT EXISTS page_links_target_idx ON page_links (target_page_id);
CREATE INDEX IF NOT EXISTS page_links_unresolved_idx ON page_links (source_page_id) WHERE kind = 'unresolved';

-- Backfill from the old table (until the next scan re-parses every document —
-- meta_version is 0 everywhere), then replace it with the compatibility view.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'links' AND c.relkind = 'r' AND n.nspname = current_schema()
  ) THEN
    INSERT INTO page_links (source_page_id, target_path, link_path, target_page_id, syntax, kind)
      SELECT source_page_id, target_path, target_path, target_page_id, 'md',
             CASE kind WHEN 'broken' THEN 'unresolved' ELSE kind END
        FROM links
       ORDER BY id;
    DROP TABLE links;
  END IF;
END $$;

CREATE OR REPLACE VIEW links AS
  SELECT id, source_page_id, target_page_id, target_path,
         CASE kind WHEN 'unresolved' THEN 'broken' ELSE kind END AS kind
    FROM page_links;
