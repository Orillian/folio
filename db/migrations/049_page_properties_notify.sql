-- "The properties of a page changed" — one NOTIFY, from the one place every
-- properties write has to pass through: pages_index.frontmatter.
--
-- The index stores a page's own properties as jsonb (indexV2/store.ts
-- writePageMeta): a document's front matter, a table's / form's block without
-- the keys that define it, a board's / file's sidecar. Whatever changed them —
-- the properties panel (PUT /api/pages/:id/properties), a base cell, the MCP
-- tool set_page_properties, a tag rename, a markdown PUT that carries a block,
-- scanSpace after a git sync that brought a new block or sidecar — ends in an
-- UPDATE of that column. As with the tree signal (031), a trigger cannot be
-- forgotten by a write path added next year.
--
-- Payload: {"schema", "space", "id"}. The page id travels only inside the
-- server: server/propertiesSignal.ts forwards it ONLY to the open sessions
-- that may read that page (its own access list included). The schema name
-- keeps several schemas in one database (the isolated test schemas) apart.
--
-- Folio's own keys are watched in their columns too (sort_order, status, icon,
-- cover): the page chrome's icon picker and a drag in the tree write the file's
-- block and those columns without re-indexing the jsonb. A frame for a page
-- whose properties did not really change costs a tab nothing: it compares the
-- frame's etag with the one it holds.
--
-- Fires only when the jsonb really changed (jsonb equality is semantic, so a
-- re-index with the same block — every body autosave re-reads the block — stays
-- silent) and not for a row's FIRST indexing (OLD.frontmatter IS NULL: a page
-- that was just created or synced in has nobody looking at its properties yet;
-- the tree signal announces it).

CREATE OR REPLACE FUNCTION folio_notify_page_properties() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('folio_page_properties', json_build_object('schema', current_schema(), 'space', NEW.space_slug, 'id', NEW.id)::text);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS pages_index_properties_notify ON pages_index;
CREATE TRIGGER pages_index_properties_notify
  AFTER UPDATE OF frontmatter, sort_order, status, icon, cover ON pages_index
  FOR EACH ROW
  WHEN (
    OLD.frontmatter IS NOT NULL
    AND (
      OLD.frontmatter IS DISTINCT FROM NEW.frontmatter
      OR OLD.sort_order IS DISTINCT FROM NEW.sort_order
      OR OLD.status IS DISTINCT FROM NEW.status
      OR OLD.icon IS DISTINCT FROM NEW.icon
      OR OLD.cover IS DISTINCT FROM NEW.cover
    )
  )
  EXECUTE PROCEDURE folio_notify_page_properties();
