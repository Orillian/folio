import { describe, expect, it } from 'vitest';
import { highlightChanges, splitBlocks } from './compareDiff';

describe('highlightChanges', () => {
  it('keeps a fenced code block with blank lines in one block', () => {
    expect(splitBlocks(['# T', '', '```', 'a', '', 'b', '```', 'tail', '', 'x'])).toEqual([
      { start: 0, end: 0 },
      { start: 2, end: 7 },
      { start: 9, end: 9 },
    ]);
  });

  it('marks changed blocks, merges untouched runs and keeps removed text as a placeholder', () => {
    const base = ['# Title', '', 'one', '', 'two', '', 'three', '', 'four'].join('\n');
    const next = ['# Title', '', 'one', '', 'two CHANGED', '', 'three', '', 'five'].join('\n');
    const result = highlightChanges(base, next);
    if (result.tooLarge) throw new Error('unexpected');
    expect(result.segments.map((s) => s.kind)).toEqual(['same', 'removed', 'changed', 'same', 'removed', 'changed']);
    expect(result.segments[0]).toEqual({ kind: 'same', text: '# Title\n\none' });
    expect(result.segments[1]).toEqual({ kind: 'removed', lines: ['two'] });
    expect(result.changedBlocks).toBe(2);
  });

  it('reports no changes for equal texts and a removal at the end', () => {
    const same = highlightChanges('a\n\nb', 'a\n\nb');
    expect(same).toMatchObject({ tooLarge: false, changedBlocks: 0, removedGroups: 0 });
    const tail = highlightChanges('a\n\nb', 'a');
    if (tail.tooLarge) throw new Error('unexpected');
    expect(tail.segments).toEqual([{ kind: 'same', text: 'a' }, { kind: 'removed', lines: ['b'] }]);
  });

  it('gives up on a page too large for the diff', () => {
    const big = (tag: string) => Array.from({ length: 2500 }, (_, i) => `${tag}${i}`).join('\n');
    expect(highlightChanges(big('a'), big('b'))).toEqual({ tooLarge: true });
  });
});
