import { describe, expect, it } from 'vitest';
import { actionLabelKey, describeUserAgent, displayAction, filtersFromSearch, filtersToQuery, hasActiveFilters, metaParts, EMPTY_AUDIT_FILTERS } from './logic';

describe('audit logic', () => {
  it('builds flat i18n keys from action names', () => {
    expect(actionLabelKey('access.grant')).toBe('audit.action.access_grant');
    expect(actionLabelKey('page.file.replaced')).toBe('audit.action.page_file_replaced');
    expect(actionLabelKey('space.property-types')).toBe('audit.action.space_property_types');
  });

  it('reads an old unarchive (group.archive with archived:false) as a restore', () => {
    expect(displayAction('group.archive', { archived: false })).toBe('group.restore');
    expect(displayAction('group.archive', { archived: true })).toBe('group.archive');
    expect(displayAction('group.archive', null)).toBe('group.archive');
    expect(displayAction('group.restore', { archived: false })).toBe('group.restore');
  });

  it('drops empty filters from the query and trims text', () => {
    expect(filtersToQuery(EMPTY_AUDIT_FILTERS)).toEqual({ actor: undefined, action: undefined, target: undefined, from: undefined, to: undefined });
    expect(filtersToQuery({ ...EMPTY_AUDIT_FILTERS, action: ' user. ', from: '2026-10-01' })).toMatchObject({ action: 'user.', from: '2026-10-01' });
    expect(hasActiveFilters(EMPTY_AUDIT_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_AUDIT_FILTERS, target: 'x' })).toBe(true);
  });

  it('reads filters from a query string', () => {
    expect(filtersFromSearch(new URLSearchParams('action=auth.&target=abc'))).toEqual({ ...EMPTY_AUDIT_FILTERS, action: 'auth.', target: 'abc' });
  });

  it('shows every meta field, truncating long values, so unknown actions lose nothing', () => {
    const parts = metaParts({ visibility: 'instance', n: 3, flag: false, nothing: null, empty: '', obj: { a: 1 }, long: 'x'.repeat(200) });
    expect(parts.map((p) => p.key)).toEqual(['visibility', 'n', 'flag', 'nothing', 'obj', 'long']);
    expect(parts.find((p) => p.key === 'obj')?.value).toBe('{"a":1}');
    expect(parts.find((p) => p.key === 'long')?.value.length).toBe(81);
    expect(metaParts(null)).toEqual([]);
  });

  it('names the browser and system of a user agent', () => {
    expect(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBe('Chrome · macOS');
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge · Windows');
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile Safari/604.1')).toBe('Safari · iOS');
    expect(describeUserAgent('curl/8.0')).toBe('curl/8.0');
    expect(describeUserAgent(null)).toBeNull();
  });
});
