import { describe, expect, it } from 'vitest';
import type { FormField, TableColumn } from '../contracts.js';
import {
  buildFormChoices,
  deriveFieldsFromColumns,
  formatSubmittedAt,
  SUBMITTED_AT_COLUMN_ID,
  SUBMITTER_COLUMN_ID,
  systemColumns,
  validateSubmission,
} from './fields.js';

describe('deriveFieldsFromColumns', () => {
  const columns: TableColumn[] = [
    { id: 'name', name: 'Name', type: 'text', description: 'Full name' },
    { id: 'age', name: 'Age', type: 'number' },
    { id: SUBMITTED_AT_COLUMN_ID, name: 'Submitted at', type: 'date' },
    { id: SUBMITTER_COLUMN_ID, name: 'Submitter', type: 'text' },
  ];

  it('maps one field per non-system column, in order', () => {
    const fields = deriveFieldsFromColumns(columns);
    expect(fields).toEqual([
      { columnId: 'name', label: 'Name', help: 'Full name', required: false, kind: 'text' },
      { columnId: 'age', label: 'Age', help: undefined, required: false, kind: 'number' },
    ]);
  });

  it('systemColumns() are excluded from a re-derive', () => {
    const fields = deriveFieldsFromColumns(systemColumns());
    expect(fields).toEqual([]);
  });
});

describe('validateSubmission', () => {
  const fields: FormField[] = [
    { columnId: 'name', label: 'Name', required: true, kind: 'text' },
    { columnId: 'age', label: 'Age', required: false, kind: 'number' },
    { columnId: 'attends', label: 'Attends', required: false, kind: 'checkbox' },
  ];

  it('accepts a fully-filled submission and coerces types', () => {
    const result = validateSubmission(fields, { name: 'Ivan', age: '42', attends: 'on' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values).toEqual({ name: 'Ivan', age: 42, attends: true });
  });

  it('rejects a missing required field', () => {
    const result = validateSubmission(fields, { age: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual({ name: 'required' });
  });

  it('rejects a non-numeric value for a number field', () => {
    const result = validateSubmission(fields, { name: 'Ivan', age: 'not-a-number' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.age).toBe('invalid');
  });

  it('defaults an optional empty field to null rather than dropping it', () => {
    const result = validateSubmission(fields, { name: 'Ivan' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.age).toBeNull();
  });
});

describe('formatSubmittedAt', () => {
  // Owner repro: after submit, the table row's "Submitted at" cell rendered
  // empty (`dd.mm.yyyy, --:--`) — root cause was `new Date().toISOString()`
  // (a `Z`-suffixed, millisecond-precision UTC string) being handed straight
  // to a `date, time: true` cell, whose only reader is an
  // `<input type="datetime-local">` (web/src/tables/cells/CellComponents.tsx).
  // That input's `value` must be a LOCAL date-time string with no timezone
  // designator, or the browser silently blanks it — this pins the exact
  // shape that input actually accepts.
  it('formats as a local `YYYY-MM-DDTHH:mm:ss` string — no milliseconds, no timezone designator', () => {
    const value = formatSubmittedAt(new Date(2026, 8, 21, 15, 39, 5)); // month is 0-indexed: September
    expect(value).toBe('2026-09-21T15:39:05');
    expect(value).not.toContain('Z');
    expect(value).not.toContain('.');
  });

  it('zero-pads every single-digit component', () => {
    expect(formatSubmittedAt(new Date(2026, 0, 5, 9, 3, 7))).toBe('2026-01-05T09:03:07');
  });
});

describe('validateSubmission against the table columns', () => {
  const columns: TableColumn[] = [
    { id: 'size', name: 'Size', type: 'select', options: [{ value: 'S', color: 'gray' }, { value: 'M', color: 'gray' }] },
    { id: 'tags', name: 'Tags', type: 'select', multiple: true, options: [{ value: 'a, b', color: 'gray' }, { value: 'c', color: 'gray' }] },
    { id: 'state', name: 'State', type: 'status', options: [{ value: 'TODO', color: 'blue' }, { value: 'DONE', color: 'green' }] },
    { id: 'owner', name: 'Owner', type: 'user' },
    { id: 'team', name: 'Team', type: 'user', multiple: true },
    { id: 'site', name: 'Site', type: 'link' },
  ];
  const fields: FormField[] = columns.map((c) => ({ columnId: c.id, label: c.name, required: false, kind: c.type }));
  const members = new Set(['ann', 'bob']);
  const check = (input: Record<string, unknown>, users: ReadonlySet<string> | null = members) => validateSubmission(fields, input, { columns, users });
  const values = (input: Record<string, unknown>, users: ReadonlySet<string> | null = members) => {
    const r = check(input, users);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r.values;
  };
  const errors = (input: Record<string, unknown>, users: ReadonlySet<string> | null = members) => {
    const r = check(input, users);
    return r.ok ? {} : r.errors;
  };

  it('accepts an option, a list for a multiple column, and a status option', () => {
    const v = values({ size: 'M', tags: ['a, b', 'c'], state: 'DONE' });
    expect(v.size).toBe('M');
    expect(v.tags).toEqual(['a, b', 'c']);
    expect(v.state).toBe('DONE');
  });

  it('rejects a value that is not among the options', () => {
    expect(errors({ size: 'XL' })).toEqual({ size: 'invalid' });
    expect(errors({ state: 'LATER' })).toEqual({ state: 'invalid' });
    expect(errors({ tags: ['c', 'nope'] })).toEqual({ tags: 'invalid' });
  });

  it('keeps the shape of the column: a list needs a multiple column, a lone value is wrapped for one', () => {
    expect(errors({ size: ['S', 'M'] })).toEqual({ size: 'invalid' });
    expect(values({ size: ['S'] }).size).toBe('S');
    expect(values({ tags: 'c' }).tags).toEqual(['c']);
  });

  it('counts an empty list as empty (and the required check applies)', () => {
    const required = fields.map((f) => (f.columnId === 'tags' ? { ...f, required: true } : f));
    const r = validateSubmission(required, { tags: [] }, { columns, users: members });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual({ tags: 'required' });
  });

  it('accepts members only: handles are normalised, strangers are rejected', () => {
    expect(values({ owner: '@Ann', team: ['bob', '@ann'] })).toMatchObject({ owner: 'ann', team: ['bob', 'ann'] });
    expect(errors({ owner: 'mallory' })).toEqual({ owner: 'invalid' });
    expect(errors({ team: ['ann', 'mallory'] })).toEqual({ team: 'invalid' });
  });

  it('ignores user fields for an anonymous respondent, even a filled or required one', () => {
    const required = fields.map((f) => (f.kind === 'user' ? { ...f, required: true } : f));
    const r = validateSubmission(required, { owner: 'ann', team: ['bob'] }, { columns, users: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values).toMatchObject({ owner: null, team: null });
  });

  it('keeps a link as the table stores it and rejects other schemes', () => {
    expect(values({ site: 'https://example.com/a' }).site).toBe('https://example.com/a');
    expect(values({ site: '[Docs](https://example.com)' }).site).toBe('[Docs](https://example.com)');
    expect(errors({ site: 'javascript:alert(1)' })).toEqual({ site: 'invalid' });
    expect(errors({ site: '[x](javascript:alert(1))' })).toEqual({ site: 'invalid' });
    expect(errors({ site: 'example.com' })).toEqual({ site: 'invalid' });
  });
});

describe('buildFormChoices', () => {
  const columns: TableColumn[] = [
    { id: 'size', name: 'Size', type: 'select', multiple: true, options: [{ value: 'S', color: 'red' }] },
    { id: 'state', name: 'State', type: 'status', options: [{ value: 'TODO', color: 'blue' }] },
    { id: 'owner', name: 'Owner', type: 'user' },
    { id: 'secret', name: 'Not on the form', type: 'select', options: [{ value: 'hidden-option', color: 'gray' }] },
    { id: 'note', name: 'Note', type: 'text' },
  ];
  const fields: FormField[] = ['size', 'state', 'owner', 'note'].map((id) => {
    const c = columns.find((col) => col.id === id)!;
    return { columnId: id, label: c.name, required: false, kind: c.type };
  });

  it('describes the select/status/user fields of the form only, with options and multiple', () => {
    const choices = buildFormChoices(fields, columns, [{ username: 'ann', name: 'Ann' }]);
    expect(Object.keys(choices).sort()).toEqual(['owner', 'size', 'state']);
    expect(choices.size).toEqual({ options: [{ value: 'S', color: 'red' }], multiple: true });
    expect(choices.state.options).toEqual([{ value: 'TODO', color: 'blue' }]);
    expect(choices.owner).toEqual({ users: [{ username: 'ann', name: 'Ann' }] });
  });

  it('gives an anonymous reader no member list: the user field is hidden', () => {
    const choices = buildFormChoices(fields, columns, null);
    expect(choices.owner).toEqual({ hidden: true });
    expect(JSON.stringify(choices)).not.toContain('ann');
  });

  it('skips a field whose column is gone or changed type', () => {
    expect(buildFormChoices(fields, columns.filter((c) => c.id !== 'size'), [])).not.toHaveProperty('size');
    expect(buildFormChoices(fields, columns.map((c) => (c.id === 'state' ? { ...c, type: 'text' as const } : c)), [])).not.toHaveProperty('state');
  });
});
