-- Public sites, SEO (14.10.2026): two more publish settings, next to the ones
-- of migration 038 and for the same reason kept in Postgres, not in git (who
-- sees the site and where is an instance decision; how it looks lives in the
-- repository, `.folio/` at the space's content root).
--
--   * public_indexing      - may search engines index the site? false: every
--                            page carries <meta name="robots" content="noindex">,
--                            robots.txt answers `Disallow: /` on the site's own
--                            host (and disallows /public/<slug> on the main
--                            host) and the sitemap is a 404. Default true.
--   * public_primary_host  - which address is canonical (<link rel=canonical>,
--                            og:url, sitemap <loc>): 'auto' = the custom domain
--                            if set, else the subdomain if set (and the instance
--                            has PUBLIC_SITES_DOMAIN), else the path form;
--                            'path' | 'subdomain' | 'domain' pin one (falling
--                            back to 'auto' when the pinned one is not set).
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS public_indexing boolean NOT NULL DEFAULT true;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS public_primary_host text NOT NULL DEFAULT 'auto';
ALTER TABLE spaces DROP CONSTRAINT IF EXISTS spaces_public_primary_host_check;
ALTER TABLE spaces ADD CONSTRAINT spaces_public_primary_host_check
  CHECK (public_primary_host IN ('auto', 'path', 'subdomain', 'domain'));
