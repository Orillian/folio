-- Public sites (13.10.2026): a space can be published as a read-only website
-- for anonymous visitors.
--
-- 1. `spaces.visibility` gains a third value, 'public'. It is a SUPERSET of
--    'instance': every active user of the instance still reads the space as an
--    implicit viewer (nothing an `instance` space gives is taken away), and in
--    addition anonymous visitors (no session) read it through the public site
--    routes (/api/public/**, /files/<space>/..., /collab/<pageId> read-only).
--    Restricted pages (page_access rows), `.agent/**` and `_templates/` are
--    never part of the public site. Existing spaces keep their visibility:
--    publishing is an explicit opt-in by a space or instance admin.
--
-- 2. Publish settings live next to the visibility, in Postgres only - NOT in
--    git, for the same reason as `visibility` itself (migration 016): who may
--    read a space is an instance decision, not repository content, and a
--    clone/mirror of the repo must never publish or unpublish anything.
--      * public_subdomain       - DNS label under PUBLIC_SITES_DOMAIN
--                                 (<label>.<PUBLIC_SITES_DOMAIN>); unique.
--      * public_domain          - custom domain (CNAME to the instance host);
--                                 unique.
--      * public_allow_download  - anonymous visitors may export a page
--                                 (md/pdf/docx).
--      * public_allow_assistant - anonymous visitors may use the AI assistant
--                                 over this space (opt-in; uses the space or
--                                 instance shared key).
--    The values are kept while the space is not public (so un-publishing and
--    re-publishing does not lose them), but are only honoured while
--    `visibility = 'public'`.
ALTER TABLE spaces DROP CONSTRAINT IF EXISTS spaces_visibility_check;
ALTER TABLE spaces ADD CONSTRAINT spaces_visibility_check
  CHECK (visibility IN ('private', 'instance', 'public'));

ALTER TABLE spaces ADD COLUMN IF NOT EXISTS public_subdomain text;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS public_domain text;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS public_allow_download boolean NOT NULL DEFAULT false;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS public_allow_assistant boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS spaces_public_subdomain_key ON spaces (public_subdomain) WHERE public_subdomain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS spaces_public_domain_key ON spaces (public_domain) WHERE public_domain IS NOT NULL;
