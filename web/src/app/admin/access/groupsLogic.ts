import type { GroupInfo, GroupMemberInfo, AccessMatrixUser } from '@shared/contracts';

/** Derives a group slug from its name: lowercase ASCII letters/digits and single dashes, at most 63 chars (groupSlugSchema). A name with no Latin letters yields '' and the person types the slug by hand. */
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

/** Same pattern as groupSlugSchema in shared/contracts.ts (kept as a plain regex so the form can validate without zod). */
export function isValidGroupSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug);
}

/** Groups matching a free-text query on name or slug. */
export function matchesGroupQuery(group: Pick<GroupInfo, 'name' | 'slug'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return group.name.toLowerCase().includes(q) || group.slug.toLowerCase().includes(q);
}

/** Members of a group matching a free-text query on name, email or username. */
export function matchesMemberQuery(member: Pick<GroupMemberInfo, 'name' | 'email' | 'username'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return member.name.toLowerCase().includes(q) || member.email.toLowerCase().includes(q) || (member.username ?? '').toLowerCase().includes(q);
}

/** Active instance users who are not yet in the group and match the query, capped for display. */
export function addCandidates(users: AccessMatrixUser[], members: Pick<GroupMemberInfo, 'userId'>[], query: string, limit = 8): AccessMatrixUser[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const inGroup = new Set(members.map((m) => m.userId));
  return users
    .filter((u) => !u.disabled && !inGroup.has(u.id) && (u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)))
    .slice(0, limit);
}
