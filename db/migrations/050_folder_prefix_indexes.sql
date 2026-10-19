-- "Is this folder a folder of the space?" (indexV2/store.ts loadFiles) asks, for every folder a scoped link
-- resolution could mean, whether any file or page path starts with `<folder>/`. Written as
-- `left(path, length(d) + 1) = d || '/'` that is a scan of every file and page of the space PER candidate
-- folder: a subtree copy (make template / from template / duplicate) of 40 pages spent 7 s there on a
-- 6000-page space. The same test as a byte-order range (`path >= 'd/' AND path < 'd0'`, '0' being the
-- character after '/') walks these indexes instead; they are in the "C" collation so the range is exactly the
-- prefix, whatever the database's own collation is.
CREATE INDEX IF NOT EXISTS space_files_path_prefix_idx ON space_files (space_slug, (path COLLATE "C"));
CREATE INDEX IF NOT EXISTS pages_index_path_prefix_idx ON pages_index (space_slug, (path COLLATE "C"));
