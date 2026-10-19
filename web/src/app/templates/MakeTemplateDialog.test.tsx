// @vitest-environment jsdom
/**
 * "Make template" / "New template" dialog: sends the name, description and the subpages choice; while the server works
 * the inputs and buttons are disabled and the dialog does not close on Escape.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { MakeTemplateDialog } from './MakeTemplateDialog';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) } as Response;
}

const created = { id: 'tpl1', space: 'docs', path: '_templates/runbook.md', title: 'Runbook template', kind: 'doc', order: 0, status: 'draft', updatedAt: '' };

function renderDialog(props: { mode?: 'make' | 'new'; hasChildren?: boolean } = {}) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchMock = vi.fn(async () => {
    await gate;
    return jsonResponse(created, 201);
  });
  vi.stubGlobal('fetch', fetchMock);
  const handlers = { onClose: vi.fn(), onCreated: vi.fn() };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MakeTemplateDialog space="docs" mode={props.mode ?? 'make'} page={{ id: 'p1', title: 'Runbook' }} hasChildren={props.hasChildren} {...handlers} />
    </QueryClientProvider>,
  );
  return { fetchMock, release, ...handlers };
}

describe('MakeTemplateDialog', () => {
  it('prefills and selects the page title, submits title/description/includeChildren, closes and reports the template', async () => {
    const { fetchMock, release, onCreated, onClose } = renderDialog({ hasChildren: true });
    const name = screen.getByLabelText('Template name') as HTMLInputElement;
    expect(name.value).toBe('Runbook');
    expect(document.activeElement).toBe(name);

    fireEvent.change(name, { target: { value: '  Runbook template ' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: ' For on-call. ' } });
    fireEvent.click(screen.getByLabelText('Include subpages'));
    fireEvent.click(screen.getByRole('button', { name: 'Create template' }));

    // Pending: locked, relabelled, Escape does not close it.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Creating…' })).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Creating…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Template name') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    release();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(onClose).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/pages/p1/make-template');
    expect(JSON.parse(String(init.body))).toEqual({ includeChildren: false, title: 'Runbook template', description: 'For on-call.' });
  });

  it('hides the subpages box for a page without children and submits on Enter; an empty name cannot be submitted', async () => {
    const { fetchMock, release } = renderDialog({ hasChildren: false });
    expect(screen.queryByLabelText('Include subpages')).toBeNull();
    const name = screen.getByLabelText('Template name');
    fireEvent.change(name, { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: 'Create template' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: 'Plain' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ includeChildren: false, title: 'Plain' });
    release();
  });

  it('new mode posts a blank template to the space and starts with an empty name', async () => {
    const { fetchMock, release, onCreated } = renderDialog({ mode: 'new' });
    expect((screen.getByLabelText('Template name') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Weekly review' } });
    const description = screen.getByLabelText('Description');
    fireEvent.change(description, { target: { value: 'Look back' } });
    fireEvent.keyDown(description, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/spaces/docs/templates');
    expect(JSON.parse(String(init.body))).toEqual({ title: 'Weekly review', description: 'Look back' });
    release();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });
});
