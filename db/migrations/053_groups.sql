-- Groups (23.10.2026, docs/spec-access.md §15): a named set of people that can
-- hold a role in a space and a grant on a restricted page, the same way a
-- single person can. Operational data, PostgreSQL only — never written to the
-- git content, same reasoning as space_members (001) and page_access (020).
--
-- Owner decisions: no nested groups; groups are created and deleted by
-- instance admins; a member flagged `is_manager` may edit the group's
-- membership; a space admin can only grant or revoke a group's role in their
-- own space. `source` / `external_id` are reserved for groups provisioned by
-- an identity provider (OIDC/SAML claims, SCIM) — only 'local' exists today.
--
-- "All members" is NOT a row here: it stays what visibility 'instance' already
-- is (every active person is an implicit viewer), and the interface shows that
-- grant as "All members (viewer)". See spec-access.md §15.

CREATE TABLE IF NOT EXISTS groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  source      text NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'oidc', 'saml', 'scim')),
  external_id text,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS groups_source_external_id_key ON groups (source, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS group_members (
  group_id   uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source     text NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'oidc', 'saml', 'scim')),
  is_manager boolean NOT NULL DEFAULT false,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user_id_idx ON group_members (user_id);

CREATE TABLE IF NOT EXISTS space_group_roles (
  space_slug text NOT NULL REFERENCES spaces(slug) ON DELETE CASCADE,
  group_id   uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
  PRIMARY KEY (space_slug, group_id)
);
CREATE INDEX IF NOT EXISTS space_group_roles_group_id_idx ON space_group_roles (group_id);

-- A page grant is held by exactly one of a person or a group. The old primary
-- key (page_id, user_id) becomes a plain unique constraint (NULLs never
-- conflict), so the existing `ON CONFLICT (page_id, user_id)` statements keep
-- their arbiter; the group twin gets its own.
ALTER TABLE page_access_grants DROP CONSTRAINT IF EXISTS page_access_grants_pkey;
ALTER TABLE page_access_grants ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE page_access_grants ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES groups(id) ON DELETE CASCADE;
ALTER TABLE page_access_grants DROP CONSTRAINT IF EXISTS page_access_grants_one_grantee;
ALTER TABLE page_access_grants ADD CONSTRAINT page_access_grants_one_grantee CHECK (num_nonnulls(user_id, group_id) = 1);
ALTER TABLE page_access_grants DROP CONSTRAINT IF EXISTS page_access_grants_page_user_key;
ALTER TABLE page_access_grants ADD CONSTRAINT page_access_grants_page_user_key UNIQUE (page_id, user_id);
ALTER TABLE page_access_grants DROP CONSTRAINT IF EXISTS page_access_grants_page_group_key;
ALTER TABLE page_access_grants ADD CONSTRAINT page_access_grants_page_group_key UNIQUE (page_id, group_id);
CREATE INDEX IF NOT EXISTS page_access_grants_group_idx ON page_access_grants (group_id) WHERE group_id IS NOT NULL;

-- An invitation can put the person into groups too (instance admins: any
-- active group; a group manager: their own groups).
ALTER TABLE invites ADD COLUMN IF NOT EXISTS group_ids uuid[] NOT NULL DEFAULT '{}';
