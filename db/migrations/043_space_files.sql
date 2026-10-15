-- Obsidian brief, wave 3 (14.10.2026): the files of a space, indexed AS FILES.
--
-- Owner's decision: every regular file under a space's content root that is
-- not a page (`assets/`, attachments next to notes, any other file) gets a row
-- here — a separate table, never a page kind, never in the tree or the search.
-- The scan (storage.ts scanSpace) mirrors the working tree into it
-- incrementally (mtime + size, like pages_index), and the link resolver
-- (indexV2/store.ts resolveLinks) resolves non-page link and embed targets
-- against it: a file that exists is kind 'asset' with target_path set to the
-- file's own path, a file that does not is 'unresolved' (so a missing
-- attachment shows up in /unresolved-links).
--
-- Never recorded: dotfiles and anything under a dot folder (`.git/`, `.folio/`,
-- `.obsidian/`, `.agent/`), `*.folio` metadata files, the space's scan-ignore
-- list, symlinks, and the files that ARE pages (outside `assets/`).
--
--   path    POSIX path relative to the content root, e.g. "assets/diagram.png"
--   size    bytes
--   mtime   the file's modification time (the incremental scan compares it)
--   sha256  content hash; NULL until something needs it (not computed by the scan)
CREATE TABLE IF NOT EXISTS space_files (
  space_slug text NOT NULL REFERENCES spaces(slug) ON DELETE CASCADE,
  path       text NOT NULL,
  size       bigint NOT NULL,
  mtime      timestamptz NOT NULL,
  sha256     text,
  PRIMARY KEY (space_slug, path)
);

-- The wikilink basename rule (`![[diagram.png]]` finds `assets/diagram.png`) loads candidates by file name.
CREATE INDEX IF NOT EXISTS space_files_basename_idx ON space_files (space_slug, lower(regexp_replace(path, '^.*/', '')));

-- GET /api/spaces/:space/files counts the pages that link to each listed file.
CREATE INDEX IF NOT EXISTS page_links_asset_target_idx ON page_links (target_path) WHERE kind = 'asset';
