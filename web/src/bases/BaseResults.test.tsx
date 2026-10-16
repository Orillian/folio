// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import type { BaseQueryResponse } from '@shared/bases/types';
import { BaseResults } from './BaseResults';
import { cellText, localDateTime, columnLabel, editorFor, editText, layOut, parseEdit, propertyChoices, propertyLabel, sameAsShown } from './model';
import { cleanConfig } from './BaseEditor';
import './i18n/register';

beforeEach(async () => {
  await i18next.changeLanguage('en');
});
afterEach(cleanup);

const RESPONSE: BaseQueryResponse = {
  views: [{ name: 'By status', type: 'table', supported: true }],
  view: 'By status',
  layout: 'table',
  columns: [
    { id: 'file.name', label: 'file.name', source: 'file', editable: false },
    { id: 'status', label: 'Status', source: 'note', key: 'status', editable: true },
    { id: 'due', label: 'due', source: 'note', key: 'due', editable: true },
    { id: 'done', label: 'done', source: 'note', key: 'done', editable: true },
    { id: 'formula.x', label: 'formula.x', source: 'formula', editable: false, unsupported: 'icon() is not supported', summary: { name: 'Sum', value: { t: 'number', v: 3 } } },
  ],
  rows: [
    { id: 'a', title: 'Alpha', path: 'p/a.md', kind: 'doc', canEdit: true, group: 0, cells: { 'file.name': { t: 'link', v: 'Alpha', pageId: 'a' }, status: { t: 'text', v: 'doing' }, due: { t: 'date', v: '2026-10-01' }, done: { t: 'bool', v: false }, 'formula.x': { t: 'unsupported', v: 'icon()' } } },
    { id: 'b', title: 'Beta', path: 'p/b.md', kind: 'doc', canEdit: false, group: 1, cells: { 'file.name': { t: 'link', v: 'Beta', pageId: 'b' }, status: null, due: null, done: { t: 'bool', v: true }, 'formula.x': { t: 'error', v: 'boom' } } },
  ],
  groups: [
    { key: { t: 'text', v: 'doing' }, count: 1 },
    { key: null, count: 1 },
  ],
  total: 2,
  offset: 0,
  limit: 200,
  truncated: false,
  warnings: [],
};

describe('base UI model', () => {
  it('cell text, editors, edit values', () => {
    expect(cellText({ t: 'list', v: [{ t: 'text', v: 'a' }, { t: 'link', v: 'B' }] })).toBe('a, B');
    expect(cellText({ t: 'datetime', v: '2026-10-01T10:30:00' })).toBe(localDateTime('2026-10-01T10:30:00'));
    expect(localDateTime('2026-10-01T10:30:00')).toMatch(/^2026-10-0[12] \d{2}:30$/);
    expect(editorFor({ t: 'number', v: 1 }, undefined)).toBe('number');
    expect(editorFor({ t: 'text', v: '1' }, 'number')).toBe('number');
    expect(editorFor(null, 'tags')).toBe('list');
    expect(editText({ t: 'list', v: [{ t: 'text', v: 'a' }, { t: 'text', v: 'b' }] }, 'list')).toBe('a, b');
    expect(editText({ t: 'link', v: 'Ada', path: 'people/Ada.md', pageId: 'x' }, 'text')).toBe('[[Ada]]');
    expect(parseEdit('3,5', 'number')).toBe(3.5);
    expect(parseEdit('', 'number')).toBeNull();
    expect(parseEdit('a, b ,', 'list')).toEqual(['a', 'b']);
    expect(parseEdit('2026-10-01', 'date')).toBe('2026-10-01');
    expect(parseEdit('  ', 'text')).toBeNull();
  });

  it('knows when a value changed since it was shown', () => {
    expect(sameAsShown('doing', { t: 'text', v: 'doing' })).toBe(true);
    expect(sameAsShown('done', { t: 'text', v: 'doing' })).toBe(false);
    expect(sameAsShown(undefined, null)).toBe(true);
    expect(sameAsShown('2026-10-01', { t: 'date', v: '2026-10-01' })).toBe(true);
    expect(sameAsShown(5, { t: 'number', v: 5 })).toBe(true);
  });

  it('labels, layout with group headers, property choices', () => {
    const t = (k: string) => `T(${k})`;
    expect(columnLabel({ id: 'file.mtime', label: 'file.mtime' }, t)).toBe('T(fields.fileMtime)');
    expect(columnLabel({ id: 'status', label: 'Status' }, t)).toBe('Status');
    expect(columnLabel({ id: 'formula.ppu', label: 'formula.ppu' }, t)).toBe('ppu');
    expect(layOut(RESPONSE).map((x) => (x.kind === 'group' ? `g${x.index}` : x.row.id))).toEqual(['g0', 'a', 'g1', 'b']);
    expect(layOut(RESPONSE, new Set([0])).map((x) => (x.kind === 'group' ? `g${x.index}` : x.row.id))).toEqual(['g0', 'g1', 'b']);
    expect(propertyChoices(['zeta', 'alpha'], ['ppu'], ['status']).slice(0, 4)).toEqual(['status', 'alpha', 'zeta', 'file.name']);
    expect(propertyChoices([], ['ppu'])).toContain('formula.ppu');
  });

  it('property labels in the editor: displayName wins, then the header name; note keys lose their prefix', () => {
    const t = (k: string) => `T(${k})`;
    const props = { 'file.name': { displayName: 'Page' }, status: { displayName: 'State' }, 'note.owner': { displayName: 'Who' } };
    expect(propertyLabel('file.name', props, t)).toBe('Page');
    expect(propertyLabel('file.folder', props, t)).toBe('T(fields.fileFolder)');
    expect(propertyLabel('file.tags', undefined, t)).toBe('T(fields.fileTags)');
    expect(propertyLabel('status', props, t)).toBe('State');
    expect(propertyLabel('note.status', props, t)).toBe('State'); // the same property under its other spelling
    expect(propertyLabel('owner', props, t)).toBe('Who');
    expect(propertyLabel('note.priority', props, t)).toBe('priority');
    expect(propertyLabel('priority', props, t)).toBe('priority');
    expect(propertyLabel('formula.ppu', props, t)).toBe('ppu');
  });

  it('the editor drops blank rows before saving', () => {
    const cleaned = cleanConfig({ formulas: { a: 'x', '': 'y', b: ' ' }, properties: {}, summaries: {}, views: [{ type: 'table', name: ' T ', order: ['file.name', '', ' status'], sort: [{ property: '', direction: 'ASC' }], limit: undefined }] });
    expect(cleaned.formulas).toEqual({ a: 'x' });
    expect(cleaned.views[0]).toEqual({ type: 'table', name: 'T', order: ['file.name', 'status'] });
  });
});

describe('BaseResults', () => {
  const pageHref = (id: string) => `/s/sp/p/${id}`;

  it('renders a grouped table with links, markers, summaries; read-only outside edit mode', () => {
    render(
      <MemoryRouter>
        <BaseResults response={RESPONSE} space="sp" pageHref={pageHref} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Alpha' }).getAttribute('href')).toBe('/s/sp/p/a');
    expect(screen.getByText('No value')).toBeTruthy();
    expect(screen.getByText('formula not supported')).toBeTruthy();
    expect(screen.getByText('not supported')).toBeTruthy();
    expect(screen.getByText('error')).toBeTruthy();
    expect(screen.getByText('Sum')).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: /doing/ }).filter((b) => b.classList.contains('folio-base-editable'))).toHaveLength(0);
    // Collapsing a group hides its rows.
    fireEvent.click(screen.getAllByRole('button', { expanded: true })[0]);
    expect(screen.queryByRole('link', { name: 'Alpha' })).toBeNull();
  });

  it('in edit mode only editable rows get editors; a commit sends the parsed value', async () => {
    const onCommit = vi.fn(async () => {});
    const { container } = render(
      <MemoryRouter>
        <BaseResults response={RESPONSE} space="sp" pageHref={pageHref} editing onCommit={onCommit} />
      </MemoryRouter>,
    );
    // Row a (canEdit) has editors for status, due; row b none.
    expect(container.querySelectorAll('.folio-base-editable')).toHaveLength(2);
    fireEvent.click(container.querySelector('.folio-base-editable')!);
    const input = screen.getByLabelText('Status') as HTMLInputElement;
    expect(input.value).toBe('doing');
    fireEvent.change(input, { target: { value: 'done' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect((onCommit.mock.calls[0] as unknown[])[2]).toBe('done');
    // A checkbox commits on toggle.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Toggle done' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));
    expect((onCommit.mock.calls[1] as unknown[])[2]).toBe(true);
  });

  it('cards and list layouts', () => {
    const { rerender } = render(
      <MemoryRouter>
        <BaseResults response={{ ...RESPONSE, layout: 'cards', groups: undefined, rows: RESPONSE.rows.map((r) => ({ ...r, group: undefined, cover: r.id === 'a' ? '#ff0000' : undefined })) }} space="sp" pageHref={pageHref} />
      </MemoryRouter>,
    );
    expect(document.querySelectorAll('.folio-base-card')).toHaveLength(2);
    rerender(
      <MemoryRouter>
        <BaseResults response={{ ...RESPONSE, layout: 'list', groups: undefined }} space="sp" pageHref={pageHref} />
      </MemoryRouter>,
    );
    expect(document.querySelectorAll('li')).toHaveLength(2);
  });
});
