// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import type { FormField, FormFieldChoices } from '@shared/contracts';
import { FormRenderer } from './FormRenderer';
import { answersDraftKey, readDraft } from './draftStorage';

const opts = (...values: string[]) => values.map((value) => ({ value, color: 'gray' as const }));

const FIELDS: FormField[] = [
  { columnId: 'size', label: 'Size', required: false, kind: 'select' }, // 3 options -> radio
  { columnId: 'country', label: 'Country', required: false, kind: 'select' }, // 8 options -> dropdown
  { columnId: 'tags', label: 'Tags', required: false, kind: 'select' }, // multiple, 3 -> checkboxes
  { columnId: 'langs', label: 'Languages', required: false, kind: 'select' }, // multiple, 8 -> searchable list
  { columnId: 'state', label: 'State', required: false, kind: 'status' },
  { columnId: 'owner', label: 'Owner', required: false, kind: 'user' },
  { columnId: 'site', label: 'Website', required: false, kind: 'link' },
];

const CHOICES: Record<string, FormFieldChoices> = {
  size: { options: opts('Small', 'Medium', 'Large') },
  country: { options: opts('Ukraine', 'Poland', 'Germany', 'France', 'Spain', 'Italy', 'Norway', 'Sweden') },
  tags: { options: opts('red', 'green', 'blue'), multiple: true },
  langs: { options: opts('en', 'uk', 'pl', 'de', 'fr', 'es', 'it', 'no'), multiple: true },
  state: { options: [{ value: 'TODO', color: 'blue' }, { value: 'DONE', color: 'green' }] },
  owner: { users: [{ username: 'ann', name: 'Ann Member' }, { username: 'bob', name: 'Bob Member' }] },
};

beforeAll(async () => {
  await i18next.changeLanguage('en');
});
beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

function renderForm(fields: FormField[], choices: Record<string, FormFieldChoices> | undefined, extra: { draftKey?: string } = {}) {
  const onSubmit = vi.fn(async (_values: Record<string, unknown>) => ({ ok: true }));
  render(<FormRenderer title="Poll" fields={fields} choices={choices} onSubmit={onSubmit} draftKey={extra.draftKey} />);
  return onSubmit;
}

const group = (name: string) => screen.getByRole('group', { name: new RegExp(name) });
const field = (id: string) => FIELDS.filter((f) => f.columnId === id);

describe('FormRenderer choice fields', () => {
  it('renders each kind as the right control', () => {
    renderForm(FIELDS, CHOICES);
    // single, <= 6 options: radio group
    expect(within(group('Size')).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['Small', 'Medium', 'Large']);
    // single, > 6 options: dropdown
    const dropdown = screen.getByLabelText(/Country/) as HTMLSelectElement;
    expect(dropdown.tagName).toBe('SELECT');
    expect(Array.from(dropdown.options).map((o) => o.value)).toEqual(['', 'Ukraine', 'Poland', 'Germany', 'France', 'Spain', 'Italy', 'Norway', 'Sweden']);
    // multiple, <= 6: checkboxes
    expect(within(group('Tags')).getAllByRole('checkbox')).toHaveLength(3);
    // multiple, > 6: checkboxes in a searchable list
    expect(within(group('Languages')).getAllByRole('checkbox')).toHaveLength(8);
    expect(within(group('Languages')).getByRole('searchbox')).toBeTruthy();
    // status: radio group too
    expect(within(group('State')).getAllByRole('radio')).toHaveLength(2);
    // user: a member picker, by name with @username
    expect(within(group('Owner')).getByText('Ann Member')).toBeTruthy();
    expect(within(group('Owner')).getByText('@bob')).toBeTruthy();
    // link: URL and an optional label
    expect(screen.getByLabelText('Link URL')).toBeTruthy();
    expect(screen.getByLabelText('Label (optional)')).toBeTruthy();
  });

  it('submits option values, arrays for multiple, a member handle and a link', async () => {
    const onSubmit = renderForm(FIELDS, CHOICES);
    fireEvent.click(within(group('Size')).getByLabelText('Medium'));
    fireEvent.change(screen.getByLabelText(/Country/), { target: { value: 'Poland' } });
    fireEvent.click(within(group('Tags')).getByLabelText('red'));
    fireEvent.click(within(group('Tags')).getByLabelText('blue'));
    fireEvent.click(within(group('Languages')).getByLabelText('uk'));
    fireEvent.click(within(group('State')).getByLabelText('DONE'));
    fireEvent.click(within(group('Owner')).getByLabelText(/Bob Member/));
    fireEvent.change(screen.getByLabelText('Link URL'), { target: { value: 'https://example.com' } });
    fireEvent.change(screen.getByLabelText('Label (optional)'), { target: { value: 'Docs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({
      size: 'Medium',
      country: 'Poland',
      tags: ['red', 'blue'],
      langs: ['uk'],
      state: 'DONE',
      owner: 'bob',
      site: '[Docs](https://example.com)',
    });
  });

  it('a radio answer can be changed and cleared; unchecking a checkbox removes it from the list', async () => {
    const onSubmit = renderForm([...field('size'), ...field('tags')], CHOICES);
    fireEvent.click(within(group('Size')).getByLabelText('Small'));
    fireEvent.click(within(group('Size')).getByLabelText('Large'));
    fireEvent.click(within(group('Tags')).getByLabelText('red'));
    fireEvent.click(within(group('Tags')).getByLabelText('green'));
    fireEvent.click(within(group('Tags')).getByLabelText('red'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ size: 'Large', tags: ['green'] }));
    cleanup();

    const second = renderForm(field('size'), CHOICES);
    fireEvent.click(within(group('Size')).getByLabelText('Small'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear choice' }));
    expect((within(group('Size')).getByLabelText('Small') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(second).toHaveBeenCalledWith({ size: '' }));
  });

  it('a multi-select list filters by the search box and a member by @username', () => {
    renderForm([...field('langs'), ...field('owner')], { ...CHOICES, owner: { users: Array.from({ length: 9 }, (_, i) => ({ username: `user${i}`, name: `Person ${i}` })) } });
    fireEvent.change(within(group('Languages')).getByRole('searchbox'), { target: { value: 'p' } });
    expect(within(group('Languages')).getAllByRole('checkbox').map((c) => (c as HTMLInputElement).value)).toEqual(['pl']);
    fireEvent.change(within(group('Owner')).getByRole('searchbox'), { target: { value: 'user7' } });
    expect(within(group('Owner')).getAllByRole('radio')).toHaveLength(1);
  });

  it('blocks submit for an empty required choice (radio, checkboxes, list, dropdown) and says so', async () => {
    const required = FIELDS.map((f) => ({ ...f, required: true }));
    const onSubmit = renderForm(required, CHOICES);
    fireEvent.change(screen.getByLabelText('Link URL'), { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBe(6));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(within(group('Size')).getByRole('alert').textContent).toBe('This field is required');
    expect(screen.getAllByText('This field is required')).toHaveLength(6);
    // answering one clears its error
    fireEvent.click(within(group('Size')).getByLabelText('Small'));
    expect(screen.getAllByRole('alert').length).toBe(5);
  });

  it('shows a required choice with a star and marks the group required', () => {
    renderForm([{ ...FIELDS[0], required: true }], CHOICES);
    expect(group('Size').getAttribute('aria-required')).toBe('true');
    expect(group('Size').textContent).toContain('*');
  });

  it('the status colours show as chips', () => {
    renderForm(field('state'), CHOICES);
    const chip = within(group('State')).getByText('DONE');
    expect(chip.parentElement?.className).toContain('bg-green-100');
  });

  it('arrow keys are the browser radio behaviour: the options of one group share one name', () => {
    renderForm(field('size'), CHOICES);
    const names = new Set(within(group('Size')).getAllByRole('radio').map((r) => (r as HTMLInputElement).name));
    expect(names.size).toBe(1);
    expect([...names][0]).not.toBe('');
  });

  it('a user field of an anonymous respondent (hidden) is not on the form at all', () => {
    renderForm(FIELDS, { ...CHOICES, owner: { hidden: true } });
    expect(screen.queryByText('Owner')).toBeNull();
    expect(screen.queryByText('Ann Member')).toBeNull();
  });

  it('a hidden required field does not block the submit and is not sent', async () => {
    const onSubmit = renderForm([{ ...FIELDS[5], required: true }, ...field('size')], { ...CHOICES, owner: { hidden: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({}));
  });

  it('without choices every choice field falls back to a text input, as before', () => {
    renderForm(field('size'), undefined);
    expect((screen.getByLabelText(/Size/) as HTMLInputElement).type).toBe('text');
  });

  it('a select without options says so instead of an empty control', () => {
    renderForm(field('size'), { size: { options: [] } });
    expect(screen.getByText('No options to choose from yet')).toBeTruthy();
  });

  it('a link needs a URL; the label alone is not an answer', async () => {
    const onSubmit = renderForm(field('site'), CHOICES);
    fireEvent.change(screen.getByLabelText('Label (optional)'), { target: { value: 'Docs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ site: '' }));
  });
});

describe('FormRenderer choice answers and the draft', () => {
  const key = answersDraftKey('f1', 'u:alice');

  function fillAndLeave() {
    vi.useFakeTimers();
    renderForm(FIELDS, CHOICES, { draftKey: key });
    fireEvent.click(within(group('Size')).getByLabelText('Large'));
    fireEvent.click(within(group('Tags')).getByLabelText('red'));
    fireEvent.click(within(group('Tags')).getByLabelText('blue'));
    fireEvent.click(within(group('Owner')).getByLabelText(/Ann Member/));
    fireEvent.change(screen.getByLabelText('Link URL'), { target: { value: 'https://example.com' } });
    fireEvent.change(screen.getByLabelText('Label (optional)'), { target: { value: 'Docs' } });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    cleanup();
    vi.useRealTimers();
  }

  it('keeps a multiple answer as an array in the draft and restores every control', () => {
    fillAndLeave();
    expect(readDraft<{ values: Record<string, unknown> }>(key)?.data.values).toEqual({
      size: 'Large',
      tags: ['red', 'blue'],
      owner: 'ann',
      site: '[Docs](https://example.com)',
    });

    renderForm(FIELDS, CHOICES, { draftKey: key });
    expect((within(group('Size')).getByLabelText('Large') as HTMLInputElement).checked).toBe(true);
    expect((within(group('Tags')).getByLabelText('red') as HTMLInputElement).checked).toBe(true);
    expect((within(group('Tags')).getByLabelText('blue') as HTMLInputElement).checked).toBe(true);
    expect((within(group('Tags')).getByLabelText('green') as HTMLInputElement).checked).toBe(false);
    expect((within(group('Owner')).getByRole('radio', { name: /Ann Member/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Link URL') as HTMLInputElement).value).toBe('https://example.com');
    expect((screen.getByLabelText('Label (optional)') as HTMLInputElement).value).toBe('Docs');
  });

  it('drops a restored answer whose option was removed since, and says which', () => {
    fillAndLeave();
    renderForm(FIELDS, { ...CHOICES, size: { options: opts('Small', 'Medium') }, tags: { options: opts('red', 'green'), multiple: true } }, { draftKey: key });
    expect((within(group('Size')).getByLabelText('Small') as HTMLInputElement).checked).toBe(false);
    expect((within(group('Tags')).getByLabelText('red') as HTMLInputElement).checked).toBe(true);
    expect(within(group('Tags')).queryByLabelText('blue')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/no longer among the choices.*Size/);
  });

  it('Clear empties the choice controls and the link boxes too', () => {
    fillAndLeave();
    renderForm(FIELDS, CHOICES, { draftKey: key });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect((within(group('Size')).getByLabelText('Large') as HTMLInputElement).checked).toBe(false);
    expect((within(group('Tags')).getByLabelText('red') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Link URL') as HTMLInputElement).value).toBe('');
    expect(readDraft(key)).toBeNull();
  });
});
