import { describe, expect, it } from 'vitest';
import { MAX_COMPARE, addCompareItem, comparePath, parseCompareParam, parseStoredList, type CompareItem } from './compareList';

const item = (pageId: string, sha?: string): CompareItem => ({ pageId, sha, space: 'docs', title: pageId });

describe('compare list', () => {
  it('round-trips the URL param and drops garbage, duplicates and extras', () => {
    expect(parseCompareParam('01ABC,01ABC@3a4f9c1')).toEqual([{ pageId: '01ABC' }, { pageId: '01ABC', sha: '3a4f9c1' }]);
    expect(comparePath(parseCompareParam('01ABC,01ABC@3a4f9c1'))).toBe('/compare?items=01ABC,01ABC@3a4f9c1');
    expect(parseCompareParam('a,a,b@zz,c@d@e,<x>,,')).toEqual([{ pageId: 'a' }]);
    expect(parseCompareParam('a,b,c,d,e,f,g')).toHaveLength(MAX_COMPARE);
    expect(parseCompareParam(null)).toEqual([]);
  });

  it('refuses duplicates and a sixth item; a page and its version are different entries', () => {
    let list: CompareItem[] = [];
    list = addCompareItem(list, item('a')).list;
    expect(addCompareItem(list, item('a')).result).toBe('duplicate');
    expect(addCompareItem(list, item('a', 'abcdef1')).result).toBe('added');
    for (const id of ['b', 'c', 'd', 'e']) list = addCompareItem(list, item(id)).list;
    expect(list).toHaveLength(MAX_COMPARE);
    expect(addCompareItem(list, item('f')).result).toBe('full');
  });

  it('reads a stored list defensively', () => {
    expect(parseStoredList('not json')).toEqual([]);
    expect(parseStoredList(JSON.stringify([{ pageId: 'a', space: 's', title: 'A' }, { pageId: '!!' }, 7, { pageId: 'a', space: 's', title: 'dup' }]))).toEqual([
      { pageId: 'a', space: 's', title: 'A' },
    ]);
  });
});
