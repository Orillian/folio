/**
 * Groups (migration 053, docs/spec-access.md §15): permissions of the API
 * functions, roles through groups, page grants to groups, the last-admin guard
 * counting group admins, invites into groups, and the access log.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setUpTestSchema, deleteTestSpace } from '../db/testSchema.js';
import * as authStore from '../auth/store.js';
import * as session from '../auth/session.js';
import * as storage from '../storage.js';
import * as pageAccess from '../pageAccess.js';
import { HttpError } from '../errors.js';
import { applyAccessBulk, buildAccessMatrix, getSpaceAccessLog, getUserAccess } from '../access/routes.js';
import { query } from '../db/pool.js';
import * as groups from './routes.js';
import type { User } from '../../shared/contracts.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
}

/** recordAudit is fire-and-forget: give the inserts a moment before reading the log. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe('groups', () => {
  let teardown: () => Promise<void>;
  let n = 0;
  const person = async (name: string, isAdmin = false): Promise<User> =>
    authStore.createUser({ email: `grp-${Date.now()}-${n++}@groups.test`, name, passwordHash: 'x', isAdmin });

  beforeAll(async () => {
    teardown = await setUpTestSchema();
  });
  afterAll(async () => teardown());

  it('only an instance admin creates, renames, archives and deletes groups', async () => {
    const admin = await person('Admin', true);
    const plain = await person('Plain');
    expect(await status(groups.createGroupFor(plain, { slug: 'nope', name: 'Nope', description: '' }))).toBe(403);
    const group = await groups.createGroupFor(admin, { slug: `eng-${n}`, name: 'Engineering', description: '' });
    expect(await status(groups.createGroupFor(admin, { slug: group.slug, name: 'Again', description: '' }))).toBe(409);
    expect(await status(groups.updateGroupFor(plain, group.id, { name: 'X' }))).toBe(403);
    expect((await groups.updateGroupFor(admin, group.id, { name: 'Eng' })).name).toBe('Eng');
    expect(await status(groups.listGroupsFor(plain))).toBe(403);
    expect((await groups.listGroupsFor(admin)).some((g) => g.id === group.id)).toBe(true);
    expect(await status(groups.deleteGroupFor(plain, group.id))).toBe(403);
    await groups.deleteGroupFor(admin, group.id);
    expect(await status(groups.getGroupDetailFor(admin, group.id))).toBe(404);
  });

  it('archiving logs group.archive and unarchiving logs group.restore (not archive with archived:false)', async () => {
    const admin = await person('Admin', true);
    const group = await groups.createGroupFor(admin, { slug: `arch-${n}`, name: 'Archivable', description: '' });
    await groups.updateGroupFor(admin, group.id, { archived: true });
    await groups.updateGroupFor(admin, group.id, { archived: false });
    await settle();
    const rows = await query<{ action: string; meta: Record<string, unknown> }>(
      "SELECT action, meta FROM audit_log WHERE target = $1 AND action IN ('group.archive', 'group.restore') ORDER BY id",
      [group.id],
    );
    expect(rows.map((r) => r.action)).toEqual(['group.archive', 'group.restore']);
    expect(rows[1].meta).toMatchObject({ archived: false, groupName: 'Archivable' });
  });

  it('a manager edits the membership of their own group only', async () => {
    const admin = await person('Admin', true);
    const manager = await person('Manager');
    const other = await person('Other');
    const own = await groups.createGroupFor(admin, { slug: `own-${n}`, name: 'Own', description: '' });
    const foreign = await groups.createGroupFor(admin, { slug: `foreign-${n}`, name: 'Foreign', description: '' });
    await groups.addGroupMembersFor(admin, own.id, { userIds: [manager.id], isManager: true });

    const detail = await groups.addGroupMembersFor(manager, own.id, { userIds: [other.id] });
    expect(detail.members.map((m) => m.userId).sort()).toEqual([manager.id, other.id].sort());
    expect((await groups.setGroupManagerFor(manager, own.id, other.id, true)).members.find((m) => m.userId === other.id)?.isManager).toBe(true);
    expect(await status(groups.addGroupMembersFor(manager, foreign.id, { userIds: [other.id] }))).toBe(403);
    expect(await status(groups.getGroupDetailFor(manager, foreign.id))).toBe(403);
    expect(await status(groups.updateGroupFor(manager, own.id, { name: 'Renamed' }))).toBe(403);
    // A manager sees active groups to pick from, with canManage only on their own.
    const listed = await groups.listGroupsFor(manager);
    expect(listed.find((g) => g.id === own.id)?.canManage).toBe(true);
    expect(listed.find((g) => g.id === foreign.id)?.canManage).toBe(false);
    // An archived group is read-only for its managers.
    await groups.updateGroupFor(admin, own.id, { archived: true });
    expect(await status(groups.removeGroupMemberFor(manager, own.id, other.id))).toBe(409);
    await groups.updateGroupFor(admin, own.id, { archived: false });
    expect((await groups.removeGroupMemberFor(manager, own.id, other.id)).members.map((m) => m.userId)).toEqual([manager.id]);
  });

  it('a group role counts for its active members (max rule); archived groups and disabled members do not', async () => {
    const admin = await person('Admin', true);
    const owner = await person('Owner');
    const member = await person('Member');
    const disabled = await person('Disabled');
    const space = await storage.createSpace(`Group roles ${n}`, owner.id);
    await authStore.setMembership(space.slug, owner.id, 'admin');
    await authStore.setMembership(space.slug, member.id, 'viewer');
    const group = await groups.createGroupFor(admin, { slug: `roles-${n}`, name: 'Roles', description: '' });
    await groups.addGroupMembersFor(admin, group.id, { userIds: [member.id, disabled.id] });
    const disabledUser = await authStore.updateUser(disabled.id, { disabled: true });

    await groups.setSpaceGroupRoleFor(owner, space.slug, group.id, 'editor');
    expect(await session.effectiveRole(member, space.slug)).toBe('editor');
    expect(await session.effectiveRole(disabledUser, space.slug)).toBeUndefined();
    expect((await session.membershipsFor(member))[space.slug]).toBe('editor');
    expect((await groups.listSpaceGroupsFor(space.slug))[0]).toMatchObject({ role: 'editor', memberCount: 1 });

    await groups.updateGroupFor(admin, group.id, { archived: true });
    expect(await session.effectiveRole(member, space.slug)).toBe('viewer');
    await groups.updateGroupFor(admin, group.id, { archived: false });
    await groups.setSpaceGroupRoleFor(owner, space.slug, group.id, 'admin');
    expect(await session.canAdministerSpace(member, space.slug)).toBe(true);
    await deleteTestSpace(space.slug);
  });

  it('a space admin grants a group a role in their own space only', async () => {
    const admin = await person('Admin', true);
    const spaceAdmin = await person('Space admin');
    const group = await groups.createGroupFor(admin, { slug: `grant-${n}`, name: 'Grant', description: '' });
    const mine = await storage.createSpace(`Mine ${n}`, spaceAdmin.id);
    await authStore.setMembership(mine.slug, spaceAdmin.id, 'admin');
    const theirs = await storage.createSpace(`Theirs ${n}`, admin.id);
    await authStore.setMembership(theirs.slug, admin.id, 'admin');
    await authStore.setMembership(theirs.slug, spaceAdmin.id, 'editor');

    expect((await groups.setSpaceGroupRoleFor(spaceAdmin, mine.slug, group.id, 'viewer')).role).toBe('viewer');
    expect(await status(groups.setSpaceGroupRoleFor(spaceAdmin, theirs.slug, group.id, 'viewer'))).toBe(403);
    expect(await status(groups.removeSpaceGroupFor(spaceAdmin, theirs.slug, group.id))).toBe(403);
    // A space admin (not an instance admin) can list groups to pick from, but not create one.
    expect((await groups.listGroupsFor(spaceAdmin)).some((g) => g.id === group.id)).toBe(true);
    expect(await status(groups.createGroupFor(spaceAdmin, { slug: `x-${n}`, name: 'X', description: '' }))).toBe(403);
    await groups.removeSpaceGroupFor(spaceAdmin, mine.slug, group.id);
    expect(await groups.listSpaceGroupsFor(mine.slug)).toEqual([]);
    await deleteTestSpace(mine.slug);
    await deleteTestSpace(theirs.slug);
  });

  it('the last-admin guard counts admins via a group (active members only)', async () => {
    const admin = await person('Admin', true);
    const direct = await person('Direct admin');
    const viaGroup = await person('Group admin');
    const space = await storage.createSpace(`Guard ${n}`, direct.id);
    await authStore.setMembership(space.slug, direct.id, 'admin');
    const group = await groups.createGroupFor(admin, { slug: `guard-${n}`, name: 'Guard', description: '' });
    await groups.addGroupMembersFor(admin, group.id, { userIds: [viaGroup.id] });
    await groups.setSpaceGroupRoleFor(admin, space.slug, group.id, 'admin');

    // The direct admin can step down: the group still administers the space.
    const result = await applyAccessBulk(admin, { changes: [{ userId: direct.id, space: space.slug, role: null }] });
    expect(result.errors).toEqual([]);

    // Now the group is the only admin source: none of these may go through, and each rolls back.
    expect(await status(groups.removeGroupMemberFor(admin, group.id, viaGroup.id))).toBe(409);
    expect(await status(groups.updateGroupFor(admin, group.id, { archived: true }))).toBe(409);
    expect(await status(groups.setSpaceGroupRoleFor(admin, space.slug, group.id, 'editor'))).toBe(409);
    expect(await status(groups.removeSpaceGroupFor(admin, space.slug, group.id))).toBe(409);
    expect(await status(groups.deleteGroupFor(admin, group.id))).toBe(409);
    expect(await session.effectiveRole(viaGroup, space.slug)).toBe('admin');

    // A disabled member does not count: the group alone no longer keeps the space administered.
    await authStore.setMembership(space.slug, direct.id, 'admin');
    await authStore.updateUser(viaGroup.id, { disabled: true });
    expect(await authStore.countSpaceAdmins(space.slug, direct.id)).toBe(0);
    expect((await applyAccessBulk(admin, { changes: [{ userId: direct.id, space: space.slug, role: 'editor' }] })).errors[0]?.error).toMatch(/last admin/);
    await deleteTestSpace(space.slug);
  });

  it('a page grant to a group opens a restricted page to its members, only while the group is in the space', async () => {
    const admin = await person('Admin', true);
    const owner = await person('Owner');
    const inGroup = await person('In group');
    const outside = await person('Outside');
    const space = await storage.createSpace(`Page groups ${n}`, owner.id);
    await authStore.setMembership(space.slug, owner.id, 'admin');
    await authStore.setMembership(space.slug, inGroup.id, 'viewer');
    await authStore.setMembership(space.slug, outside.id, 'viewer');
    const group = await groups.createGroupFor(admin, { slug: `page-${n}`, name: 'Page', description: '' });
    await groups.addGroupMembersFor(admin, group.id, { userIds: [inGroup.id] });
    const meta = await storage.createPage({ space: space.slug, parentPath: '', title: 'Secret', kind: 'doc' });
    const entry = await storage.requireEntry(meta.id);

    // Not in the space yet (private space, no role): refused like a non-member person.
    expect(await status(pageAccess.setAccess(owner, entry, 'restricted', [{ groupId: group.id, role: 'editor' }]))).toBe(400);
    await groups.setSpaceGroupRoleFor(owner, space.slug, group.id, 'viewer');
    await pageAccess.setAccess(owner, entry, 'restricted', [{ groupId: group.id, role: 'editor' }]);

    expect(await session.effectivePageRole(inGroup, entry)).toBe('editor');
    expect(await session.effectivePageRole(outside, entry)).toBeUndefined();
    expect((await session.readablePageIds(inGroup, space.slug)).has(entry.id)).toBe(true);
    expect((await session.readablePageIds(outside, space.slug)).has(entry.id)).toBe(false);
    const info = await pageAccess.getInfo(owner, entry, 'admin');
    expect(info.groups).toEqual([expect.objectContaining({ groupId: group.id, grant: 'editor', spaceRole: 'viewer', memberCount: 1 })]);
    // The reader sees only granted groups.
    expect((await pageAccess.getInfo(outside, entry, 'viewer')).groups.map((g) => g.groupId)).toEqual([group.id]);

    // The group leaves the space: its grant stops counting (the member still reads the space directly).
    await groups.removeSpaceGroupFor(owner, space.slug, group.id);
    expect(await session.effectivePageRole(inGroup, entry)).toBeUndefined();

    await settle();
    const log = await getSpaceAccessLog(owner, space.slug);
    expect(log.some((e) => e.action === 'access.group_grant' && e.meta.pageId === entry.id)).toBe(true);
    expect(log.some((e) => e.action === 'access.group_revoke' && !e.meta.pageId)).toBe(true);
    await deleteTestSpace(space.slug);
  });

  it('invites put people into groups; only managers (or instance admins) may name a group', async () => {
    const admin = await person('Admin', true);
    const manager = await person('Manager');
    const own = await groups.createGroupFor(admin, { slug: `inv-own-${n}`, name: 'Own', description: '' });
    const foreign = await groups.createGroupFor(admin, { slug: `inv-foreign-${n}`, name: 'Foreign', description: '' });
    await groups.addGroupMembersFor(admin, own.id, { userIds: [manager.id], isManager: true });

    await groups.assertMayInviteIntoGroups(manager, [own.id]);
    expect(await status(groups.assertMayInviteIntoGroups(manager, [foreign.id]))).toBe(403);
    await groups.assertMayInviteIntoGroups(admin, [own.id, foreign.id]);
    expect(await groups.managesAnyActiveGroup(manager)).toBe(true);

    const invited = await person('Invited');
    await groups.joinInviteGroups(invited.id, [own.id, foreign.id]);
    const access = await getUserAccess(admin, invited.id);
    expect(access.groups.map((g) => g.id).sort()).toEqual([own.id, foreign.id].sort());
    await settle();
    expect((await getUserAccess(admin, invited.id)).log.filter((e) => e.action === 'group.member_add')).toHaveLength(2);
  });

  it('the access matrix carries group rows and their space roles', async () => {
    const admin = await person('Admin', true);
    const space = await storage.createSpace(`Matrix ${n}`, admin.id);
    await authStore.setMembership(space.slug, admin.id, 'admin');
    const group = await groups.createGroupFor(admin, { slug: `matrix-${n}`, name: 'Matrix', description: '' });
    await groups.setSpaceGroupRoleFor(admin, space.slug, group.id, 'editor');
    const matrix = await buildAccessMatrix(admin);
    expect(matrix.groups.find((g) => g.id === group.id)).toMatchObject({ slug: group.slug, archived: false });
    expect(matrix.groupRoles[group.id]).toEqual({ [space.slug]: 'editor' });
    await deleteTestSpace(space.slug);
  });
});
