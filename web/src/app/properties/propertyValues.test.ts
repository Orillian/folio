import { describe, expect, it } from 'vitest';
import {
  addChips,
  countProperties,
  dateInputValue,
  datetimeInputValue,
  editableProperties,
  editorKindFor,
  normalizeTagInput,
  toDisplayProperties,
  toWireProperties,
} from './propertyValues';

describe('editorKindFor', () => {
  it('follows the type when the value fits it', () => {
    expect(editorKindFor('year', 'number', 2026)).toBe('number');
    expect(editorKindFor('done', 'checkbox', true)).toBe('checkbox');
    expect(editorKindFor('due', 'date', '2026-10-14')).toBe('date');
    expect(editorKindFor('at', 'datetime', null)).toBe('datetime');
    expect(editorKindFor('tags', 'tags', ['a'])).toBe('chips');
    expect(editorKindFor('aliases', 'aliases', 'a, b')).toBe('chips'); // Obsidian also accepts a comma-separated string
  });

  it('falls back to the shape of the value when the type does not fit, and keeps maps read-only', () => {
    expect(editorKindFor('year', 'number', 'many')).toBe('text');
    expect(editorKindFor('flag', 'text', true)).toBe('checkbox');
    expect(editorKindFor('meta', 'text', { a: 1 })).toBe('readonly');
    expect(editorKindFor('rows', 'list', [{ a: 1 }])).toBe('readonly');
    expect(editorKindFor('status', 'text', 'draft')).toBe('status');
  });
});

describe('tags', () => {
  it('normalizes like the index does: no #, lowercase, trimmed slashes, at least one letter', () => {
    expect(normalizeTagInput('#Project/Alpha/')).toBe('project/alpha');
    expect(normalizeTagInput('  ##Idea ')).toBe('idea');
    expect(normalizeTagInput('2026')).toBeNull();
    expect(normalizeTagInput('two words')).toBeNull();
  });

  it('adds several typed chips at once and drops duplicates and invalid ones', () => {
    expect(addChips(['a'], '#A, b c, 12', 'tags')).toEqual(['a', 'b', 'c']);
    expect(addChips(['x'], 'new item, x', 'list')).toEqual(['x', 'new item']);
  });
});

describe('labels: as a synonym of tags:', () => {
  it('shows labels as the tags row and writes them back untouched until the row is edited', () => {
    const original = { title: 'T', labels: ['a', 'b'] };
    const display = toDisplayProperties(original);
    expect(display).toEqual({ title: 'T', tags: ['a', 'b'] });
    expect(toWireProperties(display, original)).toEqual(original);
    // Edited: written as tags:, labels: gone.
    expect(toWireProperties({ title: 'T', tags: ['a'] }, original)).toEqual({ title: 'T', tags: ['a'] });
  });

  it('leaves a page that has both alone', () => {
    const original = { tags: ['a'], labels: ['b'] };
    expect(toDisplayProperties(original)).toBe(original);
    expect(toWireProperties(original, original)).toBe(original);
  });
});

describe('small helpers', () => {
  it('reads dates out of the stored text', () => {
    expect(dateInputValue('2026-10-14T00:00:00.000Z')).toBe('2026-10-14');
    expect(dateInputValue('next friday')).toBe('');
    expect(datetimeInputValue('2026-10-14T09:30:00')).toBe('2026-10-14T09:30');
  });

  it('counts and sends only what the editor may touch', () => {
    const props = { id: 'x', title: 'T', tags: [] };
    expect(countProperties(props, ['id'])).toBe(2);
    expect(editableProperties(props, ['id'])).toEqual({ title: 'T', tags: [] });
  });
});
