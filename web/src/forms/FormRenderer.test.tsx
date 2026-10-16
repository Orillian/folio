// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import type { FormField } from '@shared/contracts';
import { FormRenderer } from './FormRenderer';
import { answersDraftKey, readDraft } from './draftStorage';
import { toAnswersDraft } from './answersDraft';

const FIELDS: FormField[] = [
  { columnId: 'c1', label: 'Name', required: true, kind: 'text' },
  { columnId: 'c2', label: 'Feedback', required: false, kind: 'longtext' },
  { columnId: 'c3', label: 'Subscribe', required: false, kind: 'checkbox' },
];

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

function renderForm(draftKey: string | undefined, onSubmit = vi.fn(async () => ({ ok: true })), extra: { submitDisabled?: boolean; fields?: FormField[] } = {}) {
  return render(<FormRenderer title="Survey" fields={extra.fields ?? FIELDS} onSubmit={onSubmit} draftKey={draftKey} submitDisabled={extra.submitDisabled} />);
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(new RegExp(label)), { target: { value } });
}

function flushAutosave() {
  act(() => {
    vi.advanceTimersByTime(600);
  });
}

describe('FormRenderer answers draft', () => {
  it('autosaves answers after the debounce, not on every keystroke', () => {
    const key = answersDraftKey('f1', 'u:alice');
    renderForm(key);
    type('Name', 'Ann');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(readDraft(key)).toBeNull();
    flushAutosave();
    expect(readDraft<{ values: Record<string, unknown> }>(key)?.data.values).toEqual({ c1: 'Ann' });
  });

  it('restores answers after a reload, with a note and a Clear button', () => {
    const key = answersDraftKey('f1', 'u:alice');
    const first = renderForm(key);
    type('Name', 'Ann');
    type('Feedback', 'Great');
    flushAutosave();
    first.unmount();

    renderForm(key);
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe('Ann');
    expect((screen.getByLabelText(/Feedback/) as HTMLTextAreaElement).value).toBe('Great');
    expect(screen.getByRole('status').textContent).toMatch(/answers from .* were restored/);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('status')).toBeNull();
    expect(readDraft(key)).toBeNull();
  });

  it('flushes a pending write when the component unmounts before the debounce fires', () => {
    const key = answersDraftKey('f1', 'u:alice');
    const first = renderForm(key);
    type('Name', 'Ann');
    first.unmount();
    expect(readDraft<{ values: Record<string, unknown> }>(key)?.data.values).toEqual({ c1: 'Ann' });
  });

  it('clears the draft after a successful submit and does not bring it back', async () => {
    vi.useRealTimers();
    const key = answersDraftKey('f1', 'u:alice');
    const onSubmit = vi.fn(async () => ({ ok: true }));
    const first = renderForm(key, onSubmit);
    type('Name', 'Ann');
    await new Promise((r) => setTimeout(r, 650));
    expect(readDraft(key)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(screen.getByText(/Thanks/)).toBeTruthy());
    expect(onSubmit).toHaveBeenCalledWith({ c1: 'Ann' });
    expect(readDraft(key)).toBeNull();
    first.unmount();
    renderForm(key);
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe('');
  });

  it('keeps the draft when the submit fails', async () => {
    vi.useRealTimers();
    const key = answersDraftKey('f1', 'u:alice');
    renderForm(key, vi.fn(async () => ({ ok: false, message: 'nope' })));
    type('Name', 'Ann');
    await new Promise((r) => setTimeout(r, 650));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(screen.getByText('nope')).toBeTruthy());
    expect(readDraft<{ values: Record<string, unknown> }>(key)?.data.values).toEqual({ c1: 'Ann' });
  });

  it('keeps two forms and two users apart', () => {
    const aliceF1 = answersDraftKey('f1', 'u:alice');
    const bobF1 = answersDraftKey('f1', 'u:bob');
    const aliceF2 = answersDraftKey('f2', 'u:alice');
    const first = renderForm(aliceF1);
    type('Name', 'Alice answer');
    flushAutosave();
    first.unmount();

    renderForm(bobF1);
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe('');
    cleanup();
    renderForm(aliceF2);
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe('');
    cleanup();
    renderForm(aliceF1);
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe('Alice answer');
  });

  it('registers a beforeunload warning only while there are unsent answers', () => {
    const key = answersDraftKey('f1', 'u:alice');
    renderForm(key);
    const untouched = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(untouched);
    expect(untouched.defaultPrevented).toBe(false);

    type('Name', 'Ann');
    const pending = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(pending);
    expect(pending.defaultPrevented).toBe(true);
  });

  it('removes the warning once the answers are cleared', () => {
    const key = answersDraftKey('f1', 'u:alice');
    const first = renderForm(key);
    type('Name', 'Ann');
    flushAutosave();
    first.unmount();
    renderForm(key);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('stores nothing and warns about nothing without a draft key or when sending is disabled', () => {
    const key = answersDraftKey('f1', 'anon');
    renderForm(undefined);
    type('Name', 'Ann');
    flushAutosave();
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(window.localStorage.length).toBe(0);
    cleanup();

    renderForm(key, undefined, { submitDisabled: true });
    type('Name', 'Ann');
    flushAutosave();
    expect(readDraft(key)).toBeNull();
  });

  it('drops answers of fields that no longer exist when restoring', () => {
    const key = answersDraftKey('f1', 'u:alice');
    const first = renderForm(key);
    type('Name', 'Ann');
    type('Feedback', 'Great');
    flushAutosave();
    first.unmount();
    renderForm(key, undefined, { fields: [FIELDS[0]] });
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe('Ann');
    expect(screen.queryByLabelText(/Feedback/)).toBeNull();
  });
});

describe('toAnswersDraft', () => {
  it('keeps plain answers, drops empty ones and never stores non-primitive or sensitive-kind values', () => {
    const file = new File(['secret'], 'cv.pdf');
    const fields = [
      ...FIELDS,
      { columnId: 'pw', label: 'Password', required: false, kind: 'password' as unknown as FormField['kind'] },
      { columnId: 'cv', label: 'CV', required: false, kind: 'text' as const },
    ];
    const draft = toAnswersDraft({ c1: 'Ann', c2: '', c3: false, pw: 'hunter2', cv: file, ghost: 'x' }, fields);
    expect(draft.values).toEqual({ c1: 'Ann' });
    expect(draft.skipped.sort()).toEqual(['cv', 'pw']);
    expect(JSON.stringify(draft)).not.toContain('hunter2');
  });
});
