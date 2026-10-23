/**
 * The one role resolver: the TypeScript side (access/roles.ts, through
 * session.ts) and the SQL side (access/roleSql.ts, through every query that
 * enumerates readers) must give the same answer for every (user, space, page).
 * Random fixtures — users (some disabled, some instance admins, the system
 * user), spaces of every visibility, memberships, groups (some archived) with
 * members and space roles, restricted pages with grants to people and to
 * groups, `.agent/**` and `_templates/**` pages — are generated from fixed
 * seeds and compared exhaustively. Stage 7: the pages form a tree (index
 * pages, `X.md` + `X/`, boards and tables with children, the root index), so
 * restrictions nest and are inherited; the fixture is then reshuffled (pages
 * moved between folders, like a move or rename does) and compared again.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setUpTestSchema } from '../db/testSchema.js';
import { query } from '../db/pool.js';
import * as authStore from '../auth/store.js';
import * as session from '../auth/session.js';
import * as storage from '../storage.js';
import * as notificationsStore from '../notifications/store.js';
import { visiblePagesSql, userViewer } from '../accessSql.js';
import { closedPagesSql, effectiveRolesSql, spaceRoleSql } from './roleSql.js';
import * as pageAccess from '../pageAccess.js';
import * as roles from './roles.js';
import type { SpaceRole, SpaceVisibility, User } from '../../shared/contracts.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** mulberry32: a tiny deterministic PRNG, so a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VISIBILITIES: SpaceVisibility[] = ['private', 'instance', 'public'];
const SPACE_ROLES: SpaceRole[] = ['viewer', 'editor', 'admin'];
/** A small tree: every shape that has children (index page, `X.md` + `X/`, a board / table / pdf with a same-named folder) and the root index. */
const PAGE_PATHS = [
  'index.md',
  'a.md',
  'a/child.md',
  'a/child/deep.md',
  'b.md',
  'd/index.md',
  'd/x.md',
  'd/sub/README.md',
  'd/sub/y.table.md',
  'd/sub/y/leaf.md',
  'e.excalidraw.svg',
  'e/z.md',
  'f.pdf',
  'f/inside.md',
  '.agent/rules.md',
  '.agent/rules/more.md',
  '_templates/t.md',
  '_templates/t/inner.md',
];

function kindOf(relPath: string): string {
  if (relPath.endsWith('.table.md')) return 'table';
  if (relPath.endsWith('.excalidraw.svg')) return 'board';
  if (relPath.endsWith('.pdf')) return 'pdf';
  return 'doc';
}

function isIndexPath(relPath: string): boolean {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  return base === 'index.md' || base === 'README.md';
}

interface Fixture {
  users: User[];
  spaces: string[];
  pages: Array<{ id: string; space: string; path: string }>;
}

async function buildFixture(seed: number): Promise<Fixture> {
  const random = rng(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const tag = `s${seed}`;

  const users: User[] = [];
  for (let i = 0; i < 7; i++) {
    const created = await authStore.createUser({
      email: `${tag}-u${i}@roles.test`,
      name: `${tag} user ${i}`,
      passwordHash: 'x',
      isAdmin: random() < 0.25,
      username: `${tag}u${i}`,
    });
    users.push(random() < 0.2 ? await authStore.updateUser(created.id, { disabled: true }) : created);
  }

  const groups: string[] = [];
  for (let i = 0; i < 3; i++) {
    const row = await query<{ id: string }>('INSERT INTO groups (slug, name, archived_at) VALUES ($1, $1, $2) RETURNING id', [
      `${tag}-g${i}`,
      random() < 0.25 ? new Date() : null,
    ]);
    groups.push(row[0].id);
    for (const user of users) {
      if (random() < 0.4) await query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [row[0].id, user.id]);
    }
  }

  const spaces: string[] = [];
  for (let i = 0; i < 4; i++) {
    const slug = `${tag}-space-${i}`;
    await query('INSERT INTO spaces (slug, name, visibility) VALUES ($1, $1, $2)', [slug, i < VISIBILITIES.length ? VISIBILITIES[i] : pick(VISIBILITIES)]);
    spaces.push(slug);
    for (const user of users) {
      if (random() < 0.4) await authStore.setMembership(slug, user.id, pick(SPACE_ROLES));
    }
    for (const groupId of groups) {
      if (random() < 0.5) await query('INSERT INTO space_group_roles (space_slug, group_id, role) VALUES ($1, $2, $3)', [slug, groupId, pick(SPACE_ROLES)]);
    }
  }

  const pages: Fixture['pages'] = [];
  for (const space of spaces) {
    for (const [j, relPath] of PAGE_PATHS.entries()) {
      const id = `${tag}-${space}-p${j}`;
      await query('INSERT INTO pages_index (id, space_slug, path, kind, title, is_index) VALUES ($1, $2, $3, $4, $1, $5)', [id, space, relPath, kindOf(relPath), isIndexPath(relPath)]);
      pages.push({ id, space, path: relPath });
      if (random() < 0.3) {
        await query('INSERT INTO page_access (page_id, owner_id) VALUES ($1, $2)', [id, pick(users).id]);
        for (const user of users) {
          if (random() < 0.35) {
            await query('INSERT INTO page_access_grants (page_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, user.id, pick(['viewer', 'editor'])]);
          }
        }
        // Group grants regardless of whether the group is in the space: the resolver must ignore the ones that are not.
        for (const groupId of groups) {
          if (random() < 0.4) await query('INSERT INTO page_access_grants (page_id, group_id, role) VALUES ($1, $2, $3)', [id, groupId, pick(['viewer', 'editor'])]);
        }
      }
    }
  }
  return { users, spaces, pages };
}

async function sqlRole(userId: string, space: string): Promise<SpaceRole | undefined> {
  const rows = await query<{ role: SpaceRole | null }>(`SELECT ${spaceRoleSql('$1::uuid', '$2::text')} AS role`, [userId, space]);
  return rows[0]?.role ?? undefined;
}

async function sqlVisiblePageIds(user: User, space: string): Promise<Set<string>> {
  const params: unknown[] = [space];
  const visible = visiblePagesSql('p', userViewer(user), params);
  const rows = await query<{ id: string }>(`SELECT p.id FROM pages_index p WHERE p.space_slug = $1 AND ${visible}`, params);
  return new Set(rows.map((row) => row.id));
}

/** Returns how many (person, page) pairs were hidden ONLY by an inherited restriction — the fixture must exercise inheritance. */
async function checkFixture(fixture: Fixture): Promise<number> {
  let inheritedHides = 0;
  const system = (await authStore.findUserById(authStore.PUBLIC_VISITOR_USER_ID))!;
  const everyone = [...fixture.users, system];

  for (const user of everyone) {
    const tsAll = await session.membershipsFor(user);
    const sqlAll = await query<{ space_slug: string; role: SpaceRole }>(`SELECT space_slug, role FROM (${effectiveRolesSql({ user: '$1::uuid' })}) r`, [user.id]);
    expect(Object.fromEntries(sqlAll.map((r) => [r.space_slug, r.role])), `membershipsFor ${user.name}`).toEqual(tsAll);
    const adminSlugs = await authStore.listAdminSpaceSlugs(user.id);
    expect(adminSlugs.sort(), `listAdminSpaceSlugs ${user.name}`).toEqual(Object.keys(tsAll).filter((slug) => tsAll[slug] === 'admin').sort());

    for (const space of fixture.spaces) {
      const ts = await session.effectiveRole(user, space);
      expect(await sqlRole(user.id, space), `space role ${user.name} @ ${space}`).toBe(ts);
      expect(tsAll[space], `membershipsFor[${space}] ${user.name}`).toBe(ts);
      expect(await session.canAdministerSpace(user, space)).toBe(!session.isSystemUser(user) && (user.isAdmin || ts === 'admin'));
    }
  }

  // Set-shaped SQL users: members of a space, @mention list, socket audience, access-request recipients.
  const tokens = new Map<string, string>();
  for (const user of fixture.users) tokens.set((await authStore.createSession(user.id)).token, user.id);
  for (const space of fixture.spaces) {
    const expected = new Map<string, SpaceRole>();
    for (const user of fixture.users) {
      const role = await session.effectiveRole(user, space);
      if (role) expected.set(user.id, role);
    }
    const members = await roles.spaceMemberRoles(space);
    const ours = new Map([...members].filter(([id]) => fixture.users.some((u) => u.id === id)));
    expect(ours, `spaceMemberRoles ${space}`).toEqual(expected);

    const ourNames = new Set(fixture.users.map((u) => u.username));
    const mentionable = (await authStore.listMentionableUsers(space)).map((m) => m.username).filter((name) => ourNames.has(name));
    expect(mentionable.sort(), `mentionable ${space}`).toEqual(fixture.users.filter((u) => expected.has(u.id)).map((u) => u.username).sort());

    const readers = await authStore.sessionsThatCanReadSpace(space, [...tokens.keys()]);
    expect([...readers].map((t) => tokens.get(t)).sort(), `socket audience ${space}`).toEqual([...expected.keys()].sort());

    const recipients = await notificationsStore.listAccessRequestRecipients(space, authStore.PUBLIC_VISITOR_USER_ID);
    expect(
      recipients.filter((id) => fixture.users.some((u) => u.id === id)).sort(),
      `access-request recipients ${space}`,
    ).toEqual(fixture.users.filter((u) => !u.disabled && (u.isAdmin || expected.get(u.id) === 'admin')).map((u) => u.id).sort());
  }

  // Page level: effectivePageRole (TS sources + resolvePageRole) == visiblePagesSql == readablePageIds.
  for (const user of fixture.users) {
    for (const space of fixture.spaces) {
      const sqlVisible = await sqlVisiblePageIds(user, space);
      const readable = await session.readablePageIds(user, space);
      const hidden = new Set((await pageAccess.hiddenPages(user.id, space, await session.canAdministerSpace(user, space))).map((row) => row.id));
      const editClosed = new Set((await query<{ id: string }>(closedPagesSql({ user: '$1::uuid', minRole: 'editor', space: '$2' }), [user.id, space])).map((r) => r.id));
      const restricted = await pageAccess.restrictedPageIds(space);
      const spaceRole = await session.effectiveRole(user, space);
      for (const page of fixture.pages.filter((p) => p.space === space)) {
        const entry = await storage.requireEntry(page.id);
        const tsRole = await session.effectivePageRole(user, entry);
        const label = `${user.name} on ${page.id} (${entry.relPath})`;
        expect(sqlVisible.has(page.id), `visiblePagesSql ${label}`).toBe(tsRole !== undefined);
        // readablePageIds answers for a user who already passed the session gate (never a disabled one).
        if (!user.disabled) expect(readable.has(page.id), `readablePageIds ${label}`).toBe(tsRole !== undefined);
        // hiddenPages is the page-access half only (the space gate is the caller's).
        if (!user.disabled && spaceRole) expect(hidden.has(page.id), `hiddenPages ${label}`).toBe(tsRole === undefined);
        // The edit form (bases' canEdit): with restrictions on the chain, editable exactly when the page role is editor.
        const chain = await roles.loadPageRoleSources(user.id, page.id);
        if (spaceRole && tsRole === undefined && chain.restrictions.length > 0 && chain.restrictions.every((rule) => rule.pageId !== page.id)) inheritedHides++;
        if (chain.restrictions.length > 0 && spaceRole && !page.path.startsWith('.agent')) {
          expect(!editClosed.has(page.id), `editable ${label}`).toBe(tsRole === 'editor');
        }
        // Restricted for everyone (share links, public sites): its own rule or an inherited one.
        expect(restricted.has(page.id), `restrictedPageIds ${label}`).toBe(
          chain.restrictions.length > 0 || entry.relPath === '.agent' || entry.relPath.startsWith('.agent/'),
        );
      }
    }
  }

  // The access dialog's audience (one batch) == effectivePageRole per person.
  for (const space of fixture.spaces) {
    const members = [...(await roles.spaceMemberRoles(space))].map(([userId, spaceRole]) => ({ userId, spaceRole }));
    for (const page of fixture.pages.filter((p) => p.space === space && !p.path.startsWith('.agent'))) {
      const entry = await storage.requireEntry(page.id);
      const batch = await roles.pageRolesFor(page.id, members);
      for (const user of fixture.users.filter((u) => members.some((m) => m.userId === u.id))) {
        expect(batch.get(user.id), `pageRolesFor ${user.name} on ${entry.relPath}`).toBe(await session.effectivePageRole(user, entry));
      }
    }
  }
  return inheritedHides;
}

/** Moves a few pages to other folders (as a move / rename / git sync does: same id, new path) — inheritance must follow. */
async function reshuffle(fixture: Fixture, seed: number): Promise<void> {
  const random = rng(seed * 7919);
  const folders = ['', 'a/', 'a/child/', 'd/', 'd/sub/', 'd/sub/y/', 'e/', 'f/', 'g/'];
  for (const page of fixture.pages) {
    if (page.path.startsWith('.agent') || page.path.startsWith('_templates') || page.path === 'index.md' || random() > 0.35) continue;
    const base = page.path.slice(page.path.lastIndexOf('/') + 1);
    const target = `${folders[Math.floor(random() * folders.length)]}${base === 'index.md' || base === 'README.md' ? `moved-${page.id.slice(-2)}.md` : base}`;
    const taken = await query('SELECT 1 FROM pages_index WHERE space_slug = $1 AND path = $2', [page.space, target]);
    if (taken.length > 0) continue;
    await query('UPDATE pages_index SET path = $2, is_index = $3, kind = $4 WHERE id = $1', [page.id, target, isIndexPath(target), kindOf(target)]);
    page.path = target;
  }
}

describe('role resolver: TypeScript and SQL agree', () => {
  let teardown: () => Promise<void>;
  beforeAll(async () => {
    teardown = await setUpTestSchema();
  });
  afterAll(async () => teardown());

  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`random fixture, seed ${seed}`, async () => {
      const fixture = await buildFixture(seed);
      const before = await checkFixture(fixture);
      await reshuffle(fixture, seed);
      const after = await checkFixture(fixture);
      expect(before + after, 'pairs hidden only by an inherited restriction').toBeGreaterThan(0);
    });
  }

  it('resolveSpaceRole / resolvePageRole with groups: max rule, archived groups ignored, group grants need the group in the space', () => {
    const person = { disabled: false, system: false };
    expect(roles.resolveSpaceRole(person, { visibility: 'private', direct: 'viewer', groups: [{ role: 'admin', archived: false }] })).toBe('admin');
    expect(roles.resolveSpaceRole(person, { visibility: 'private', direct: 'viewer', groups: [{ role: 'admin', archived: true }] })).toBe('viewer');
    expect(roles.resolveSpaceRole(person, { visibility: 'instance', direct: undefined, groups: [{ role: 'editor', archived: false }] })).toBe('editor');
    expect(roles.resolveSpaceRole({ disabled: true, system: false }, { visibility: 'private', direct: undefined, groups: [{ role: 'admin', archived: false }] })).toBeUndefined();
    const rule = { pageId: 'p', ownerId: 'someone-else' };
    const one = (extra: Partial<roles.PageRestriction>) => ({ restrictions: [{ ...rule, ...extra }] });
    expect(roles.resolvePageRole('me', 'viewer', one({ userGrant: 'viewer', groupGrants: [{ role: 'editor', archived: false, inSpace: true }] }))).toBe('editor');
    expect(roles.resolvePageRole('me', 'viewer', one({ groupGrants: [{ role: 'editor', archived: false, inSpace: false }] }))).toBeUndefined();
    expect(roles.resolvePageRole('me', 'viewer', one({ groupGrants: [{ role: 'editor', archived: true, inSpace: true }] }))).toBeUndefined();
    expect(roles.resolvePageRole('me', undefined, one({ groupGrants: [{ role: 'editor', archived: false, inSpace: true }] }))).toBeUndefined();
  });

  it('resolvePageRole over a chain: the lowest level wins, one level not passed hides the page', () => {
    const parent: roles.PageRestriction = { pageId: 'parent', ownerId: 'alice', userGrant: 'editor' };
    const child: roles.PageRestriction = { pageId: 'child', ownerId: 'bob', userGrant: 'viewer' };
    expect(roles.resolvePageRole('me', 'admin', { restrictions: [] })).toBe('admin');
    expect(roles.resolvePageRole('me', 'viewer', { restrictions: [parent] })).toBe('editor');
    expect(roles.resolvePageRole('me', 'admin', { restrictions: [parent, child] })).toBe('viewer');
    expect(roles.resolvePageRole('me', 'editor', { restrictions: [parent, { pageId: 'child', ownerId: 'bob' }] })).toBeUndefined();
    // The owner of a child page still needs the parent: restrictions intersect.
    expect(roles.resolvePageRole('bob', 'admin', { restrictions: [{ pageId: 'parent', ownerId: 'alice' }, child] })).toBeUndefined();
    expect(roles.resolvePageRole('alice', 'viewer', { restrictions: [{ pageId: 'parent', ownerId: 'alice' }, { pageId: 'child', ownerId: 'alice' }] })).toBe('editor');
    expect(roles.resolvePageRole('me', undefined, { restrictions: [parent] })).toBeUndefined();
  });

  it('resolveSpaceRole: max of the sources, nothing for disabled, system only for public', () => {
    const person = { disabled: false, system: false };
    expect(roles.resolveSpaceRole(person, { visibility: 'instance', direct: undefined, groups: [] })).toBe('viewer');
    expect(roles.resolveSpaceRole(person, { visibility: 'instance', direct: 'editor', groups: [] })).toBe('editor');
    expect(roles.resolveSpaceRole(person, { visibility: 'private', direct: undefined, groups: [] })).toBeUndefined();
    expect(roles.resolveSpaceRole({ disabled: true, system: false }, { visibility: 'public', direct: 'admin', groups: [] })).toBeUndefined();
    expect(roles.resolveSpaceRole({ disabled: false, system: true }, { visibility: 'instance', direct: 'admin', groups: [] })).toBeUndefined();
    expect(roles.resolveSpaceRole({ disabled: false, system: true }, { visibility: 'public', direct: undefined, groups: [] })).toBe('viewer');
  });
});
