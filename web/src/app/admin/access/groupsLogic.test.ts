import { describe, expect, it } from 'vitest';
import { addCandidates, isValidGroupSlug, matchesGroupQuery, matchesMemberQuery, slugFromName } from './groupsLogic';

describe('slugFromName', () => {
  it('lowercases and dashes', () => {
    expect(slugFromName('  Platform Team  ')).toBe('platform-team');
    expect(slugFromName('R&D / Core')).toBe('r-d-core');
  });
  it('strips diacritics', () => {
    expect(slugFromName('Café Équipe')).toBe('cafe-equipe');
  });
  it('yields an empty slug when nothing Latin is left', () => {
    expect(slugFromName('\u0406\u0422')).toBe('');
  });
  it('caps the length at 63 without a trailing dash', () => {
    const slug = slugFromName(`${'a'.repeat(62)} b`);
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(isValidGroupSlug(slug)).toBe(true);
  });
});

describe('isValidGroupSlug', () => {
  it('matches the contract pattern', () => {
    expect(isValidGroupSlug('team-1')).toBe(true);
    expect(isValidGroupSlug('-team')).toBe(false);
    expect(isValidGroupSlug('Team')).toBe(false);
    expect(isValidGroupSlug('')).toBe(false);
  });
});

describe('queries', () => {
  it('filters groups by name or slug', () => {
    expect(matchesGroupQuery({ name: 'Platform', slug: 'plat' }, 'PLAT')).toBe(true);
    expect(matchesGroupQuery({ name: 'Platform', slug: 'plat' }, 'zzz')).toBe(false);
  });
  it('filters members by name, email or username', () => {
    expect(matchesMemberQuery({ name: 'Maria', email: 'm@t.local', username: 'mk' }, 'mk')).toBe(true);
    expect(matchesMemberQuery({ name: 'Maria', email: 'm@t.local' }, 'bob')).toBe(false);
  });
  it('offers only active non-members once a query is typed', () => {
    const users = [
      { id: 'u1', name: 'Maria', email: 'maria@t.local', isAdmin: false, disabled: false },
      { id: 'u2', name: 'Marcus', email: 'marcus@t.local', isAdmin: false, disabled: true },
      { id: 'u3', name: 'Marta', email: 'marta@t.local', isAdmin: false, disabled: false },
    ];
    expect(addCandidates(users, [], '')).toEqual([]);
    expect(addCandidates(users, [{ userId: 'u3' }], 'mar').map((u) => u.id)).toEqual(['u1']);
  });
});
