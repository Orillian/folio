// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { FormDoc } from '@shared/contracts';
import { builderDraftKey, readDraft } from '../../forms/draftStorage';
import { FormDefinitionEditor } from './FormDefinitionEditor';

const updatePage = vi.fn(async () => ({}));
let currentUser = 'alice';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { ...actual.api, updatePage: (...args: unknown[]) => (updatePage as (...a: unknown[]) => unknown)(...args), addTableColumn: vi.fn() } };
});

vi.mock('../auth/AuthProvider', () => ({
  useAuthOptional: () => ({ user: { id: currentUser } }),
}));

const FORM: FormDoc = {
  meta: { id: 'form1', version: 1 },
  table: 'survey.table.md',
  title: 'Survey',
  description: 'About us',
  public: false,
  fields: [
    { columnId: 'c1', label: 'Name', required: true, kind: 'text' },
    { columnId: 'c2', label: 'Age', required: false, kind: 'number' },
  ],
  body: '',
};

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

beforeEach(() => {
  window.localStorage.clear();
  updatePage.mockClear();
  currentUser = 'alice';
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

function mount(opts: { pageId?: string; onClose?: () => void; onSaved?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = opts.onClose ?? vi.fn();
  const onSaved = opts.onSaved ?? vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <FormDefinitionEditor pageId={opts.pageId ?? 'page1'} form={FORM} tableId="t1" onClose={onClose} onSaved={onSaved} />
    </QueryClientProvider>,
  );
  return { ...view, onClose, onSaved };
}

const titleInput = () => screen.getByDisplayValue('Survey') as HTMLInputElement;
const keyOf = (pageId = 'page1', user = 'alice') => builderDraftKey(pageId, user);

function editTitle(value: string) {
  fireEvent.change(titleInput(), { target: { value } });
}
function flush() {
  act(() => {
    vi.advanceTimersByTime(600);
  });
}

describe('FormDefinitionEditor local draft', () => {
  it('writes nothing for an untouched form', () => {
    mount();
    flush();
    expect(readDraft(keyOf())).toBeNull();
  });

  it('autosaves every edit (debounced) including fields', () => {
    mount();
    editTitle('Survey v2');
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(readDraft(keyOf())).toBeNull();
    fireEvent.change(screen.getByDisplayValue('Age'), { target: { value: 'Years' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete field' })[0]);
    flush();
    const draft = readDraft<{ snapshot: { title: string; fields: { label: string }[] } }>(keyOf());
    expect(draft?.data.snapshot.title).toBe('Survey v2');
    expect(draft?.data.snapshot.fields.map((f) => f.label)).toEqual(['Years']);
  });

  it('offers the draft on reopen, restores it on request and keeps editing from there', () => {
    const first = mount();
    editTitle('Half an hour of work');
    flush();
    first.unmount();

    mount();
    expect(screen.getByRole('alert').textContent).toMatch(/unsaved draft of this form from/);
    // The saved form is still what is on screen until the owner decides, and Save is held back.
    expect(titleInput().value).toBe('Survey');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByDisplayValue('Half an hour of work') as HTMLInputElement).value).toBe('Half an hour of work');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    // The offered draft stays stored until saved or discarded.
    expect(readDraft(keyOf())).not.toBeNull();
  });

  it('does not overwrite the offered draft while the banner is up', () => {
    const first = mount();
    editTitle('Draft title');
    flush();
    first.unmount();
    mount();
    flush();
    expect(readDraft<{ snapshot: { title: string } }>(keyOf())?.data.snapshot.title).toBe('Draft title');
  });

  it('discarding the offered draft removes it', () => {
    const first = mount();
    editTitle('Draft title');
    flush();
    first.unmount();
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(readDraft(keyOf())).toBeNull();
    expect(titleInput().value).toBe('Survey');
  });

  it('warns when the saved form changed after the draft was started', () => {
    const first = mount();
    editTitle('Draft title');
    flush();
    first.unmount();
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <FormDefinitionEditor pageId="page1" form={{ ...FORM, description: 'Changed by someone else' }} tableId="t1" onClose={vi.fn()} onSaved={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/changed after this draft was started/);
  });

  it('removes the draft after a successful Save', async () => {
    vi.useRealTimers();
    const { onSaved } = mount();
    editTitle('Final title');
    await new Promise((r) => setTimeout(r, 650));
    expect(readDraft(keyOf())).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updatePage).toHaveBeenCalledTimes(1);
    expect(readDraft(keyOf())).toBeNull();
  });

  it('keeps the draft when Save fails', async () => {
    vi.useRealTimers();
    updatePage.mockRejectedValueOnce(new Error('boom'));
    const { onSaved } = mount();
    editTitle('Final title');
    await new Promise((r) => setTimeout(r, 650));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy());
    expect(onSaved).not.toHaveBeenCalled();
    expect(readDraft(keyOf())).not.toBeNull();
  });

  it('keeps drafts apart per form page and per user', () => {
    const first = mount({ pageId: 'page1' });
    editTitle('Alice page1');
    flush();
    first.unmount();

    mount({ pageId: 'page2' });
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();

    currentUser = 'bob';
    mount({ pageId: 'page1' });
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();

    currentUser = 'alice';
    mount({ pageId: 'page1' });
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

describe('FormDefinitionEditor leaving with unsaved changes', () => {
  it('registers a beforeunload warning only while the form has unsaved changes', () => {
    mount();
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    editTitle('Changed');
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it('closes straight away when nothing changed', () => {
    const { onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Discard changes?')).toBeNull();
  });

  it.each([
    ['Cancel', () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
    ['X', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
  ])('asks before closing with changes (%s) and offers keep-editing / keep-draft / discard', (_name, close) => {
    const { onClose } = mount();
    editTitle('Changed');
    close();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Discard changes?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByText('Discard changes?')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('"Close, keep draft" closes and leaves the draft in storage', () => {
    const { onClose } = mount();
    editTitle('Changed');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close, keep draft' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    flush();
    expect(readDraft<{ snapshot: { title: string } }>(keyOf())?.data.snapshot.title).toBe('Changed');
  });

  it('"Discard changes" closes and removes the draft for good', () => {
    const { onClose, unmount } = mount();
    editTitle('Changed');
    flush();
    expect(readDraft(keyOf())).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Discard changes' }).pop()!);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    flush();
    expect(readDraft(keyOf())).toBeNull();
  });
});
