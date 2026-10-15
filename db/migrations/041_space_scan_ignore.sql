-- Obsidian vault compatibility, wave 1a (14.10.2026): two per-space scan settings.
--
--   * scan_ignore      - extra top-level entries (names or `prefix*` patterns,
--                        relative to the content root; a trailing `/` means
--                        "directories only") the scan must not index. The
--                        defaults `.obsidian/ .trash/ .git/` always apply on top
--                        of this list (they are dotfolders, which the scan has
--                        never indexed), so '{}' means "just the defaults".
--                        Editing the list triggers a rescan of the space.
--   * light_footprint  - explicit light footprint for a space whose content root
--                        is the repository root (rootPath ''): a vault. Folio
--                        then never adds an `id` to a file and keeps its `.folio`
--                        metadata in a dotfile, exactly as for a rootPath space.
--                        A space with a non-empty root_path is light regardless.
--                        Set on creation when the repository holds `.obsidian/`,
--                        or by hand; existing spaces keep false, so nothing that
--                        carries ids in its files changes.
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS scan_ignore text[] NOT NULL DEFAULT '{}';
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS light_footprint boolean NOT NULL DEFAULT false;
