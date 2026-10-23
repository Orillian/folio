/**
 * Group sync at sign-in (migration 057, groupSync.ts) against a real (per-run schema) PostgreSQL: matching by
 * name / slug or an explicit table, create-missing, adding and removing IdP-sourced memberships only, the
 * allowlist, archived groups, Entra overage, and the last-admin protection. The OIDC and SAML sign-in paths
 * that call it are covered in oidc.test.ts and saml.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import { query } from '../db/pool.js';
import * as storage from '../storage.js';
import * as groupStore from '../groups/store.js';
import * as store from './store.js';
import * as providers from './providers.js';
import { syncIdpGroups } from './groupSync.js';
import { allowPredicate, extractGroupValues, groupSyncFromEnv, parseGroupMap, slugifyGroupValue } from './groupSyncConfig.js';
import type { SsoGroupSync } from '../../shared/contracts.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

describe('group sync: pure helpers', () => {
  it('reads the groups claim: a list, one string, absent = empty, anything else unusable', () => {
    expect(extractGroupValues(['a', ' b ', 'a', '', 5, 'x'.repeat(301)])).toEqual(['a', 'b']);
    expect(extractGroupValues('solo')).toEqual(['solo']);
    expect(extractGroupValues(undefined)).toEqual([]);
    expect(extractGroupValues(null)).toEqual([]);
    expect(extractGroupValues({ a: 1 })).toBeNull();
  });

  it('allowlist: empty = all, prefixes (case-insensitive), /regex/, a broken regex matches nothing', () => {
    expect(allowPredicate('')('anything')).toBe(true);
    const prefixes = allowPredicate('folio-, Team-');
    expect(prefixes('FOLIO-eng')).toBe(true);
    expect(prefixes('team-ops')).toBe(true);
    expect(prefixes('other')).toBe(false);
    const re = allowPredicate('/^(eng|ops)$/');
    expect(re('eng')).toBe(true);
    expect(re('engineering')).toBe(false);
    expect(allowPredicate('/(/')('x')).toBe(false);
  });

  it('slugs, the mapping list and the environment', () => {
    expect(slugifyGroupValue('Platform Team / EMEA')).toBe('platform-team-emea');
    expect(slugifyGroupValue('Інженери')).toMatch(/^idp-[0-9a-f]{10}$/);
    expect(slugifyGroupValue('Інженери')).toBe(slugifyGroupValue('Інженери'));
    expect(parseGroupMap('Engineering=eng, 3f2a-uuid = admins\nbad=Not A Slug')).toEqual({ Engineering: 'eng', '3f2a-uuid': 'admins' });
    expect(groupSyncFromEnv({}, 'FOLIO_OIDC_KC_')).toEqual({ enabled: false, mode: 'name', mapping: {}, createMissing: false, allow: '' });
    expect(
      groupSyncFromEnv(
        { FOLIO_SAML_OKTA_GROUP_SYNC: 'true', FOLIO_SAML_OKTA_GROUP_MAP: 'Eng=eng', FOLIO_SAML_OKTA_GROUP_CREATE: '1', FOLIO_SAML_OKTA_GROUP_ALLOW: 'folio-' },
        'FOLIO_SAML_OKTA_',
      ),
    ).toEqual({ enabled: true, mode: 'mapping', mapping: { Eng: 'eng' }, createMissing: true, allow: 'folio-' });
    expect(groupSyncFromEnv({ FOLIO_OIDC_KC_GROUP_SYNC: 'on', FOLIO_OIDC_KC_GROUP_MAP: 'Eng=eng', FOLIO_OIDC_KC_GROUP_SYNC_MODE: 'name' }, 'FOLIO_OIDC_KC_').mode).toBe('name');
  });
});

describe('group sync: provider settings from the environment', () => {
  it('both kinds read their _GROUP_* variables; without them sync is off', () => {
    const env = {
      FOLIO_OIDC_KC_ISSUER: 'https://op.test',
      FOLIO_OIDC_KC_CLIENT_ID: 'folio',
      FOLIO_OIDC_KC_GROUP_SYNC: 'true',
      FOLIO_SAML_OKTA_SSO_URL: 'https://idp.test/sso',
      FOLIO_SAML_OKTA_GROUP_SYNC: 'true',
      FOLIO_SAML_OKTA_GROUP_MAP: 'Eng=eng',
      FOLIO_SAML_PLAIN_SSO_URL: 'https://idp2.test/sso',
    } as NodeJS.ProcessEnv;
    const all = providers.readEnvProviders(env);
    expect(all.get('kc')!.groupSync).toMatchObject({ enabled: true, mode: 'name' });
    expect(all.get('okta')!.groupSync).toMatchObject({ enabled: true, mode: 'mapping', mapping: { Eng: 'eng' } });
    expect(all.get('plain')!.groupSync.enabled).toBe(false);
  });
});

describe('group sync at sign-in (real PG)', () => {
  let teardown: () => Promise<void>;
  const spaces: string[] = [];
  let counter = 0;
  const savedSecret = process.env.FOLIO_SECRET;

  beforeAll(async () => {
    teardown = await setUpTestSchema();
    process.env.FOLIO_SECRET = 'group-sync-test-secret';
  });
  afterAll(async () => {
    for (const s of spaces) await deleteTestSpace(s).catch(() => {});
    await teardown();
    if (savedSecret === undefined) delete process.env.FOLIO_SECRET;
    else process.env.FOLIO_SECRET = savedSecret;
  });

  async function provider(sync: Partial<SsoGroupSync> = {}): Promise<providers.AuthProvider> {
    counter += 1;
    return providers.createProvider({
      slug: `gs${counter}`,
      displayName: `GS ${counter}`,
      issuer: 'https://op.test',
      clientId: 'folio',
      clientSecret: 'shh',
      groupSync: { enabled: true, mode: 'name', mapping: {}, createMissing: false, allow: '', ...sync },
    });
  }
  async function person() {
    counter += 1;
    return store.createUser({ email: `gs-${counter}-${Date.now()}@sync.test`, name: `Person ${counter}`, passwordHash: 'x', isAdmin: false });
  }
  async function makeGroup(slug: string, name: string, extra: { archived?: boolean } = {}) {
    const g = await groupStore.createGroup({ slug: `${slug}-${counter}`, name: `${name} ${counter}`, description: '' }, (await person()).id);
    if (extra.archived) await query('UPDATE groups SET archived_at = now() WHERE id = $1', [g.id]);
    return g;
  }
  async function members(userId: string) {
    return query<{ slug: string; source: string; is_manager: boolean; source_provider_id: string | null }>(
      `SELECT g.slug, gm.source, gm.is_manager, gm.source_provider_id FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = $1 ORDER BY g.slug`,
      [userId],
    );
  }
  async function audits(userId: string, action: string) {
    await new Promise((r) => setTimeout(r, 40)); // recordAudit is fire-and-forget
    const rows = await query<{ target: string | null; meta: Record<string, unknown> }>('SELECT target, meta FROM audit_log WHERE actor_id = $1 AND action = $2 ORDER BY id', [userId, action]);
    return rows;
  }

  it('does nothing while sync is off for the provider', async () => {
    const p = await provider({ enabled: false });
    const u = await person();
    const g = await makeGroup('off', 'Off');
    const res = await syncIdpGroups(u.id, p.id, 'oidc', [g.name], { provider: p });
    expect(res.status).toBe('off');
    expect(await members(u.id)).toEqual([]);
    expect(await audits(u.id, 'auth.group_sync')).toEqual([]);
  });

  it('matches an IdP group to a Folio group by name or by slug, and records where the membership came from', async () => {
    const p = await provider();
    const u = await person();
    const byName = await makeGroup('payments', 'Payments Team');
    const bySlug = await makeGroup('ops', 'Operations');
    const res = await syncIdpGroups(u.id, p.id, 'oidc', [byName.name.toUpperCase(), bySlug.slug, 'unknown-group'], { provider: p });
    expect(res).toMatchObject({ status: 'synced', added: 2, removed: 0, unmatched: 1, created: 0 });
    expect(await members(u.id)).toEqual([
      { slug: bySlug.slug, source: 'oidc', is_manager: false, source_provider_id: p.id },
      { slug: byName.slug, source: 'oidc', is_manager: false, source_provider_id: p.id },
    ]);
    const adds = await audits(u.id, 'group.member_add');
    expect(adds).toHaveLength(2);
    expect(adds[0]!.meta).toMatchObject({ source: 'idp', provider: p.slug, targetUserId: u.id });
    const summary = await audits(u.id, 'auth.group_sync');
    expect(summary).toHaveLength(1);
    expect(summary[0]!.meta).toMatchObject({ provider: p.slug, added: 2, unmatched: 1 });

    // The same sign-in again changes nothing.
    const again = await syncIdpGroups(u.id, p.id, 'oidc', [byName.name, bySlug.slug], { provider: p });
    expect(again).toMatchObject({ added: 0, removed: 0, unchanged: 2 });
  });

  it('explicit mapping: only the table counts, even when a name would match', async () => {
    const eng = await makeGroup('eng', 'Engineering');
    const decoy = await makeGroup('decoy', 'Decoy');
    const p = await provider({ mode: 'mapping', mapping: { 'CN=Eng Team': eng.slug, '3f2a-uuid': 'missing-slug' } });
    const u = await person();
    const res = await syncIdpGroups(u.id, p.id, 'oidc', ['cn=eng team', decoy.name, '3f2a-uuid'], { provider: p });
    expect(res).toMatchObject({ added: 1, unmatched: 2 });
    expect((await members(u.id)).map((m) => m.slug)).toEqual([eng.slug]);
  });

  it('create missing: a group is made with the provider kind as its source and the IdP value as external_id, once', async () => {
    const p = await provider({ createMissing: true });
    const a = await person();
    const b = await person();
    const res = await syncIdpGroups(a.id, p.id, 'saml', ['Data Science', 'Інженери'], { provider: p });
    expect(res).toMatchObject({ added: 2, created: 2 });
    const created = await query<{ slug: string; name: string; source: string; external_id: string }>("SELECT slug, name, source, external_id FROM groups WHERE source = 'saml' AND external_id = ANY($1)", [['Data Science', 'Інженери']]);
    expect(created).toHaveLength(2);
    expect(created.find((g) => g.external_id === 'Data Science')).toMatchObject({ slug: 'data-science', name: 'Data Science' });
    expect(created.find((g) => g.external_id === 'Інженери')!.slug).toMatch(/^idp-/);
    expect((await audits(a.id, 'group.create')).map((r) => r.meta.source)).toEqual(['idp', 'idp']);
    expect((await members(a.id)).every((m) => m.source === 'saml')).toBe(true);

    // Another person with the same value joins the group that exists now.
    const res2 = await syncIdpGroups(b.id, p.id, 'saml', ['Data Science'], { provider: p });
    expect(res2).toMatchObject({ added: 1, created: 0 });
    expect((await query('SELECT 1 FROM groups WHERE slug = $1', ['data-science'])).length).toBe(1);
  });

  it('removes memberships this provider no longer asserts, and nothing else', async () => {
    const p = await provider();
    const other = await provider();
    const u = await person();
    const kept = await makeGroup('kept', 'Kept');
    const dropped = await makeGroup('dropped', 'Dropped');
    const manual = await makeGroup('manual', 'Manual');
    const manualAsserted = await makeGroup('manual-asserted', 'Manual Asserted');
    const fromOther = await makeGroup('from-other', 'From Other');
    await groupStore.addGroupMember(null, manual.id, u.id, true); // local, manager
    await groupStore.addGroupMember(null, manualAsserted.id, u.id);
    await query("INSERT INTO group_members (group_id, user_id, source, source_provider_id) VALUES ($1, $2, 'oidc', $3)", [fromOther.id, u.id, other.id]);

    await syncIdpGroups(u.id, p.id, 'oidc', [kept.name, dropped.name, manualAsserted.name], { provider: p });
    expect((await members(u.id)).map((m) => `${m.slug}:${m.source}`)).toEqual(
      [`${dropped.slug}:oidc`, `${fromOther.slug}:oidc`, `${kept.slug}:oidc`, `${manual.slug}:local`, `${manualAsserted.slug}:local`].sort(),
    );

    const res = await syncIdpGroups(u.id, p.id, 'oidc', [kept.name], { provider: p });
    expect(res).toMatchObject({ added: 0, removed: 1 });
    const after = await members(u.id);
    expect(after.map((m) => m.slug).sort()).toEqual([fromOther.slug, kept.slug, manual.slug, manualAsserted.slug].sort());
    // The local membership keeps its source and its manager flag; the other provider's one is not this provider's to remove.
    expect(after.find((m) => m.slug === manual.slug)).toMatchObject({ source: 'local', is_manager: true });
    expect(after.find((m) => m.slug === manualAsserted.slug)!.source).toBe('local');
    expect(after.find((m) => m.slug === fromOther.slug)!.source_provider_id).toBe(other.id);
    const removes = await audits(u.id, 'group.member_remove');
    expect(removes).toHaveLength(1);
    expect(removes[0]!.meta).toMatchObject({ source: 'idp', provider: p.slug, groupSlug: dropped.slug });

    // An empty list (the claim is gone for a person in no group) removes the rest of this provider's memberships.
    const empty = await syncIdpGroups(u.id, p.id, 'oidc', undefined, { provider: p });
    expect(empty).toMatchObject({ status: 'synced', removed: 1 });
    expect((await members(u.id)).map((m) => m.slug).sort()).toEqual([fromOther.slug, manual.slug, manualAsserted.slug].sort());
  });

  it('skips archived groups: nobody joins them and nobody is taken out of them', async () => {
    const p = await provider();
    const u = await person();
    const live = await makeGroup('live', 'Live');
    const frozen = await makeGroup('frozen', 'Frozen');
    await syncIdpGroups(u.id, p.id, 'oidc', [live.name, frozen.name], { provider: p });
    await query('UPDATE groups SET archived_at = now() WHERE id = $1', [frozen.id]);
    const res = await syncIdpGroups(u.id, p.id, 'oidc', [live.name], { provider: p });
    expect(res.removed).toBe(0);
    expect((await members(u.id)).map((m) => m.slug)).toContain(frozen.slug);

    const v = await person();
    const archived = await makeGroup('arch', 'Archived', { archived: true });
    const res2 = await syncIdpGroups(v.id, p.id, 'oidc', [archived.name], { provider: p });
    expect(res2).toMatchObject({ added: 0, archived: 1 });
    expect(await members(v.id)).toEqual([]);
  });

  it('Entra overage: nothing is added or removed and the skip is audited with its reason', async () => {
    const p = await provider();
    const u = await person();
    const g = await makeGroup('ov', 'Overage');
    await syncIdpGroups(u.id, p.id, 'oidc', [g.name], { provider: p });
    const res = await syncIdpGroups(u.id, p.id, 'oidc', undefined, { provider: p, overage: true });
    expect(res).toMatchObject({ status: 'skipped', reason: 'overage', removed: 0 });
    expect((await members(u.id)).map((m) => m.slug)).toEqual([g.slug]);
    const skipped = await audits(u.id, 'auth.group_sync_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.meta).toMatchObject({ reason: 'overage', provider: p.slug });
  });

  it('an unusable claim (an object) is skipped without removing anything', async () => {
    const p = await provider();
    const u = await person();
    const g = await makeGroup('inv', 'Invalid');
    await syncIdpGroups(u.id, p.id, 'oidc', [g.name], { provider: p });
    const res = await syncIdpGroups(u.id, p.id, 'oidc', { nested: true }, { provider: p });
    expect(res).toMatchObject({ status: 'skipped', reason: 'invalid_claim' });
    expect(await members(u.id)).toHaveLength(1);
  });

  it('allowlist: prefixes and a regular expression drop unrelated IdP groups before matching', async () => {
    const mine = await makeGroup('folio-eng', 'Folio Eng');
    const foreign = await makeGroup('unrelated', 'Unrelated');
    const p = await provider({ allow: 'folio-' });
    const u = await person();
    const res = await syncIdpGroups(u.id, p.id, 'oidc', [mine.slug, foreign.slug], { provider: p });
    expect(res).toMatchObject({ added: 1, filtered: 1 });
    expect((await members(u.id)).map((m) => m.slug)).toEqual([mine.slug]);

    const rx = await provider({ allow: `/^${foreign.slug}$/` });
    const v = await person();
    const res2 = await syncIdpGroups(v.id, rx.id, 'oidc', [mine.slug, foreign.slug], { provider: rx });
    expect(res2).toMatchObject({ added: 1, filtered: 1 });
    expect((await members(v.id)).map((m) => m.slug)).toEqual([foreign.slug]);
  });

  it('last-admin protection: a removal that would leave a space without an admin is kept and audited, the rest still applies', async () => {
    const p = await provider();
    const u = await person();
    const space = await storage.createSpace(`Guard ${counter} ${Date.now()}`, u.id);
    spaces.push(space.slug);
    const adminGroup = await makeGroup('space-admins', 'Space Admins');
    const plain = await makeGroup('plain', 'Plain');
    await query("INSERT INTO group_members (group_id, user_id, source, source_provider_id) VALUES ($1, $2, 'oidc', $3), ($4, $2, 'oidc', $3)", [adminGroup.id, u.id, p.id, plain.id]);
    await query('DELETE FROM space_members WHERE space_slug = $1', [space.slug]); // the creator's own admin role: the group is the only admin source
    const client = await (await import('../db/pool.js')).getPool().connect();
    try {
      await groupStore.setSpaceGroupRole(client, space.slug, adminGroup.id, 'admin');
    } finally {
      client.release();
    }

    const res = await syncIdpGroups(u.id, p.id, 'oidc', [], { provider: p });
    expect(res).toMatchObject({ status: 'synced', removed: 1, keptLastAdmin: 1 });
    expect((await members(u.id)).map((m) => m.slug)).toEqual([adminGroup.slug]);
    const warnings = await audits(u.id, 'auth.group_sync_warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.meta).toMatchObject({ reason: 'last_admin', space: space.slug, groupSlug: adminGroup.slug });
  });
});

describe('groups claim shape', () => {
  it('a single string becomes a one-element list; arrays, absent and unusable values pass through', async () => {
    const { normalizeGroupsClaim, groupsColumnValue } = await import('./groupSyncConfig.js');
    expect(normalizeGroupsClaim('sales')).toEqual(['sales']);
    expect(normalizeGroupsClaim('  sales ')).toEqual(['sales']);
    expect(normalizeGroupsClaim('  ')).toEqual([]);
    expect(normalizeGroupsClaim(['a', 'b'])).toEqual(['a', 'b']);
    expect(normalizeGroupsClaim(undefined)).toBeUndefined();
    expect(normalizeGroupsClaim({ a: 1 })).toEqual({ a: 1 });
    expect(groupsColumnValue('sales')).toBe('["sales"]');
    expect(groupsColumnValue(undefined)).toBeNull();
  });
});
