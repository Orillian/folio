/**
 * Groups API (migration 053, docs/spec-access.md §15). Same layout as
 * server/access/routes.ts: every handler is a thin wrapper over an exported
 * function that carries the authorization, so the rules are unit-tested
 * directly against a real PG schema (groups/routes.test.ts).
 *
 * Who may do what (owner decisions, 23.10.2026):
 *  - create / rename / describe / archive / unarchive / delete a group — an
 *    instance admin only;
 *  - add / remove members and set the manager flag — an instance admin, or a
 *    manager of THAT group (an archived group is read-only to its managers);
 *  - grant / change / revoke a group's role in a space — whoever administers
 *    the space (session.canAdministerSpace: instance admin or space admin);
 *  - list groups — an instance admin (all, archived too); a space admin or a
 *    group manager (active ones, to pick from); nobody else.
 * Everything is cookie-only (a PAT is refused whatever its scope, like every
 * access-administration route), and every change is audited.
 *
 * Every change that can take an admin away from a space (archive, delete,
 * member removal, a group's space role lowered or removed) runs in one
 * transaction with the last-admin guard (groups/store.ts
 * assertSpacesKeepAdmin): a 409 rolls the whole change back.
 */
import type { FastifyInstance } from 'fastify';
import {
  addGroupMembersBodySchema,
  createGroupBodySchema,
  setGroupManagerBodySchema,
  setSpaceGroupRoleBodySchema,
  updateGroupBodySchema,
  type AddGroupMembersBody,
  type CreateGroupBody,
  type GroupDetail,
  type GroupInfo,
  type GroupSpaceRoleInfo,
  type SpaceGroupMemberInfo,
  type SpaceRole,
  type UpdateGroupBody,
  type User,
} from '../../shared/contracts.js';
import { withTransaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { recordAudit } from '../audit.js';
import { parseBody } from '../validate.js';
import { assertNotDemoAccount } from '../demo.js';
import * as authStore from '../auth/store.js';
import * as session from '../auth/session.js';
import * as storage from '../storage.js';
import * as groupStore from './store.js';
import type { StoredGroup } from './store.js';

function groupMeta(group: Pick<StoredGroup, 'name' | 'slug'>): Record<string, unknown> {
  return { groupName: group.name, groupSlug: group.slug };
}

/** Instance admin, or a manager of `groupId`. */
async function canManageGroup(actor: User, groupId: string): Promise<boolean> {
  if (session.isSystemUser(actor) || actor.disabled) return false;
  if (actor.isAdmin) return true;
  return (await groupStore.getGroupMembership(groupId, actor.id))?.isManager === true;
}

function requireAdmin(actor: User): void {
  if (!actor.isAdmin || session.isSystemUser(actor)) throw forbidden('requires instance admin');
}

/** The group, if `actor` may edit its membership; 403 otherwise, 409 when a manager meets an archived group. */
async function requireManageableGroup(actor: User, groupId: string): Promise<StoredGroup> {
  const group = await groupStore.getGroup(groupId);
  if (!group) throw notFound('group');
  if (!(await canManageGroup(actor, groupId))) throw forbidden('requires instance admin, or manager of this group');
  if (group.archivedAt && !actor.isAdmin) throw conflict('this group is archived');
  return group;
}

// --- groups ---------------------------------------------------------------------

export async function listGroupsFor(actor: User): Promise<GroupInfo[]> {
  if (session.isSystemUser(actor)) throw forbidden('requires instance admin');
  if (actor.isAdmin) return (await groupStore.listGroups({ includeArchived: true })).map((g) => ({ ...g, canManage: true }));
  const managed = await groupStore.managedGroupIds(actor.id);
  if (managed.size === 0 && (await authStore.listAdminSpaceSlugs(actor.id)).length === 0) {
    throw forbidden('requires instance admin, a space admin role, or managing a group');
  }
  return (await groupStore.listGroups({ includeArchived: false })).map((g) => ({ ...g, canManage: managed.has(g.id) }));
}

export async function createGroupFor(actor: User, body: CreateGroupBody): Promise<GroupInfo> {
  requireAdmin(actor);
  const group = await groupStore.createGroup({ slug: body.slug, name: body.name, description: body.description }, actor.id);
  recordAudit(actor.id, 'group.create', group.id, groupMeta(group));
  return { ...group, canManage: true };
}

export async function getGroupDetailFor(actor: User, groupId: string): Promise<GroupDetail> {
  const group = await groupStore.getGroup(groupId);
  if (!group) throw notFound('group');
  if (!(await canManageGroup(actor, groupId))) throw forbidden('requires instance admin, or manager of this group');
  const [members, spaces] = await Promise.all([groupStore.listGroupMembers(groupId), groupStore.listGroupSpaceRoles(groupId)]);
  return { ...group, canManage: actor.isAdmin || !group.archivedAt, members, spaces };
}

export async function updateGroupFor(actor: User, groupId: string, body: UpdateGroupBody): Promise<GroupInfo> {
  requireAdmin(actor);
  const before = await groupStore.requireGroup(groupId);
  if (body.name !== undefined || body.description !== undefined) {
    await groupStore.updateGroup(groupId, { name: body.name, description: body.description });
    recordAudit(actor.id, 'group.update', groupId, {
      ...groupMeta({ name: body.name ?? before.name, slug: before.slug }),
      ...(body.name !== undefined && body.name !== before.name ? { previousName: before.name } : {}),
    });
  }
  if (body.archived !== undefined && body.archived !== (before.archivedAt !== null)) {
    await withTransaction(async (client) => {
      await groupStore.setGroupArchived(client, groupId, body.archived!);
      if (body.archived) await groupStore.assertSpacesKeepAdmin(client, await groupStore.adminSpacesOfGroup(client, groupId));
    });
    recordAudit(actor.id, body.archived ? 'group.archive' : 'group.restore', groupId, { ...groupMeta(before), archived: body.archived });
  }
  return { ...(await groupStore.requireGroup(groupId)), canManage: true };
}

export async function deleteGroupFor(actor: User, groupId: string): Promise<void> {
  requireAdmin(actor);
  const group = await groupStore.requireGroup(groupId);
  await withTransaction(async (client) => {
    const adminSpaces = await groupStore.adminSpacesOfGroup(client, groupId);
    await groupStore.deleteGroup(client, groupId);
    await groupStore.assertSpacesKeepAdmin(client, adminSpaces);
  });
  recordAudit(actor.id, 'group.delete', groupId, groupMeta(group));
}

// --- members --------------------------------------------------------------------

export async function addGroupMembersFor(actor: User, groupId: string, body: AddGroupMembersBody): Promise<GroupDetail> {
  const group = await requireManageableGroup(actor, groupId);
  const targets: User[] = [];
  for (const userId of new Set(body.userIds)) {
    const user = await authStore.findUserById(userId);
    if (!user || session.isSystemUser(user)) throw badRequest(`user not found: ${userId}`);
    targets.push(user);
  }
  for (const user of targets) {
    const before = await groupStore.getGroupMembership(groupId, user.id);
    const inserted = await groupStore.addGroupMember(null, groupId, user.id, body.isManager);
    const meta = { ...groupMeta(group), targetUserId: user.id, targetUserName: user.name };
    if (inserted) recordAudit(actor.id, 'group.member_add', groupId, { ...meta, isManager: body.isManager === true });
    else if (body.isManager !== undefined && before && before.isManager !== body.isManager) {
      recordAudit(actor.id, 'group.manager_set', groupId, { ...meta, isManager: body.isManager });
    }
  }
  return getGroupDetailFor(actor, groupId);
}

export async function removeGroupMemberFor(actor: User, groupId: string, userId: string): Promise<GroupDetail> {
  const group = await requireManageableGroup(actor, groupId);
  const membership = await groupStore.getGroupMembership(groupId, userId);
  if (!membership) throw notFound('group member');
  // Put there by the identity provider at sign-in: it takes them out (or keeps them) at the next one.
  if (membership.source === 'oidc' || membership.source === 'saml') throw conflict('this membership comes from the identity provider and changes at the next sign-in');
  const target = await authStore.findUserById(userId);
  await withTransaction(async (client) => {
    await groupStore.removeGroupMember(client, groupId, userId);
    await groupStore.assertSpacesKeepAdmin(client, await groupStore.adminSpacesOfGroup(client, groupId));
  });
  recordAudit(actor.id, 'group.member_remove', groupId, { ...groupMeta(group), targetUserId: userId, targetUserName: target?.name ?? null });
  return getGroupDetailFor(actor, groupId);
}

export async function setGroupManagerFor(actor: User, groupId: string, userId: string, isManager: boolean): Promise<GroupDetail> {
  const group = await requireManageableGroup(actor, groupId);
  const current = await groupStore.getGroupMembership(groupId, userId);
  if (!current) throw notFound('group member');
  if (current.isManager !== isManager) {
    await groupStore.setGroupManager(groupId, userId, isManager);
    const target = await authStore.findUserById(userId);
    recordAudit(actor.id, 'group.manager_set', groupId, { ...groupMeta(group), targetUserId: userId, targetUserName: target?.name ?? null, isManager });
  }
  return getGroupDetailFor(actor, groupId);
}

export async function listGroupSpacesFor(actor: User, groupId: string): Promise<GroupSpaceRoleInfo[]> {
  return (await getGroupDetailFor(actor, groupId)).spaces;
}

/**
 * An invitation's groups, joined on acceptance by `userId`. Deleted and
 * archived groups are skipped silently — the invite was valid when made.
 * Audited as membership changes made by the invite's acceptor.
 */
export async function joinInviteGroups(userId: string, groupIds: readonly string[]): Promise<void> {
  if (groupIds.length === 0) return;
  const groups = await groupStore.getGroupsByIds(groupIds);
  const user = await authStore.findUserById(userId);
  for (const group of groups.values()) {
    if (group.archivedAt) continue;
    if (await groupStore.addGroupMember(null, group.id, userId)) {
      recordAudit(userId, 'group.member_add', group.id, { ...groupMeta(group), targetUserId: userId, targetUserName: user?.name ?? null, viaInvite: true });
    }
  }
}

/**
 * Who may put an invited person into `groupIds` (POST /api/invites): an
 * instance admin — any active group; anybody else — only active groups they
 * manage. Throws 400 for an unknown or archived group, 403 for one not theirs.
 */
export async function assertMayInviteIntoGroups(actor: User, groupIds: readonly string[]): Promise<void> {
  if (groupIds.length === 0) return;
  const groups = await groupStore.getGroupsByIds(groupIds);
  const managed = actor.isAdmin ? null : await groupStore.managedGroupIds(actor.id);
  for (const id of groupIds) {
    const group = groups.get(id);
    if (!group || group.archivedAt) throw badRequest(`group not found: ${id}`);
    if (managed && !managed.has(id)) throw forbidden(`requires managing group "${group.name}" to invite into it`);
  }
}

/** True when `actor` manages at least one active group — lets a non-space-admin manager create invites (groups only). */
export async function managesAnyActiveGroup(actor: User): Promise<boolean> {
  const managed = await groupStore.managedGroupIds(actor.id);
  if (managed.size === 0) return false;
  const groups = await groupStore.getGroupsByIds([...managed]);
  return [...groups.values()].some((group) => !group.archivedAt);
}

// --- a group's role in a space ----------------------------------------------------

async function requireSpaceAdministration(actor: User, space: string): Promise<void> {
  if (!(await storage.spaceExists(space))) throw notFound('space');
  if (!(await session.canAdministerSpace(actor, space))) throw forbidden('requires instance admin, or admin role in this space');
}

export async function listSpaceGroupsFor(space: string): Promise<SpaceGroupMemberInfo[]> {
  return groupStore.listSpaceGroups(space);
}

export async function setSpaceGroupRoleFor(actor: User, space: string, groupId: string, role: SpaceRole): Promise<SpaceGroupMemberInfo> {
  await requireSpaceAdministration(actor, space);
  const group = await groupStore.getGroup(groupId);
  if (!group) throw notFound('group');
  if (group.archivedAt) throw conflict('this group is archived');
  const previousRole = await groupStore.getSpaceGroupRole(space, groupId);
  await withTransaction(async (client) => {
    await groupStore.setSpaceGroupRole(client, space, groupId, role);
    if (previousRole === 'admin' && role !== 'admin') await groupStore.assertSpacesKeepAdmin(client, [space]);
  });
  if (previousRole !== role) {
    recordAudit(actor.id, 'access.group_grant', space, { groupId, ...groupMeta(group), role, previousRole: previousRole ?? null });
  }
  const row = (await groupStore.listSpaceGroups(space)).find((entry) => entry.group.id === groupId);
  return row!;
}

export async function removeSpaceGroupFor(actor: User, space: string, groupId: string): Promise<void> {
  await requireSpaceAdministration(actor, space);
  const group = await groupStore.getGroup(groupId);
  if (!group) throw notFound('group');
  const previousRole = await groupStore.getSpaceGroupRole(space, groupId);
  if (!previousRole) throw notFound('group role in this space');
  await withTransaction(async (client) => {
    await groupStore.removeSpaceGroupRole(client, space, groupId);
    if (previousRole === 'admin') await groupStore.assertSpacesKeepAdmin(client, [space]);
  });
  recordAudit(actor.id, 'access.group_revoke', space, { groupId, ...groupMeta(group), previousRole });
}

// --- routes -----------------------------------------------------------------------

export function registerGroupRoutes(app: FastifyInstance): void {
  const params = (request: { params: unknown }) => request.params as { id: string; userId: string; space: string; groupId: string };

  app.get('/api/groups', async (request) => {
    session.requireCookieAuth(request);
    return { groups: await listGroupsFor(request.authUser!) };
  });

  app.post('/api/groups', async (request, reply) => {
    assertNotDemoAccount(request.authUser!, 'Creating a group');
    session.requireCookieAuth(request);
    const body = parseBody(createGroupBodySchema, request.body);
    reply.status(201);
    return createGroupFor(request.authUser!, body);
  });

  app.get('/api/groups/:id', async (request) => {
    session.requireCookieAuth(request);
    return getGroupDetailFor(request.authUser!, params(request).id);
  });

  app.patch('/api/groups/:id', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Changing a group');
    session.requireCookieAuth(request);
    const body = parseBody(updateGroupBodySchema, request.body);
    return updateGroupFor(request.authUser!, params(request).id, body);
  });

  app.delete('/api/groups/:id', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Deleting a group');
    session.requireCookieAuth(request);
    await deleteGroupFor(request.authUser!, params(request).id);
    return { ok: true };
  });

  app.get('/api/groups/:id/spaces', async (request) => {
    session.requireCookieAuth(request);
    return { spaces: await listGroupSpacesFor(request.authUser!, params(request).id) };
  });

  app.post('/api/groups/:id/members', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Changing group members');
    session.requireCookieAuth(request);
    const body = parseBody(addGroupMembersBodySchema, request.body);
    return addGroupMembersFor(request.authUser!, params(request).id, body);
  });

  app.put('/api/groups/:id/members/:userId', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Changing group members');
    session.requireCookieAuth(request);
    const body = parseBody(setGroupManagerBodySchema, request.body);
    return setGroupManagerFor(request.authUser!, params(request).id, params(request).userId, body.isManager);
  });

  app.delete('/api/groups/:id/members/:userId', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Changing group members');
    session.requireCookieAuth(request);
    return removeGroupMemberFor(request.authUser!, params(request).id, params(request).userId);
  });

  app.put('/api/spaces/:space/groups/:groupId', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Changing space members and roles');
    session.requireCookieAuth(request);
    const body = parseBody(setSpaceGroupRoleBodySchema, request.body);
    return setSpaceGroupRoleFor(request.authUser!, params(request).space, params(request).groupId, body.role);
  });

  app.delete('/api/spaces/:space/groups/:groupId', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Removing a space member');
    session.requireCookieAuth(request);
    await removeSpaceGroupFor(request.authUser!, params(request).space, params(request).groupId);
    return { ok: true };
  });
}
