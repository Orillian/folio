-- Group sync from the identity provider (stage 3 of "groups and SSO").
--
-- auth_providers.group_sync: per provider, {"enabled": bool, "mode": "name" |
-- "mapping", "mapping": {"<IdP value>": "<Folio group slug>"}, "createMissing":
-- bool, "allow": "<prefix list | /regex/>"}. The claim that carries the groups
-- is claim_mapping.groups (054). Empty object = sync off.
--
-- group_members.source_provider_id: which provider put the person into the
-- group (source = 'oidc' | 'saml'), so a sign-in through one provider never
-- removes memberships that came from another. NULL for local members.
ALTER TABLE auth_providers ADD COLUMN IF NOT EXISTS group_sync jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS source_provider_id uuid REFERENCES auth_providers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS group_members_source_provider_idx ON group_members (source_provider_id, user_id) WHERE source_provider_id IS NOT NULL;
