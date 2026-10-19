// @vitest-environment jsdom
/**
 * "From template…": the picker lists the space's templates (any kind), creates under the given parent on a click,
 * shows a filter only for a long list, and explains how to make a template when there are none.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { PageKind, PageMeta } from '@shared/contracts';
import { TemplatePickerDialog } from './TemplatePickerDialog';

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Test User' } }),
  useSpaceRole: () => 'editor' as const,
}));

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

function template(id: string, title: string, kind: PageKind = 'doc'): PageMeta {
  return { id, space: 'docs', path: `_templates/${id}.md`, title, kind, order: 0, status: 'draft', updatedAt: '' } as PageMeta;
}

function renderDialog(templates: PageMeta[], options: { failCreate?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/templates')) return jsonResponse({ templates });
    if (url.endsWith('/api/pages/from-template')) {
      return options.failCreate ? jsonResponse({ error: 'boom' }, 500) : jsonResponse(template('new1', 'Created'), 201);
    }
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const handlers = { onClose: vi.fn(), onCreated: vi.fn() };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TemplatePickerDialog space="docs" parentPath="guides" {...handlers} />
    </QueryClientProvider>,
  );
  return { fetchMock, ...handlers };
}

describe('TemplatePickerDialog', () => {
  it('creates a page from the clicked template under the given parent and reports it', async () => {
    const { fetchMock, onCreated, onClose } = renderDialog([template('t1', 'Meeting notes'), template('t2', 'Sprint board', 'board')]);
    expect(await screen.findByText('Sprint board')).toBeTruthy();
    expect(screen.getByText('Board')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Meeting notes/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalled();
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/pages/from-template'))!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ templateId: 't1', space: 'docs', parentPath: 'guides' });
  });

  it('filters a long list and creates the first match on Enter', async () => {
    const many = Array.from({ length: 8 }, (_, i) => template(`t${i}`, i === 5 ? 'Retro' : `Template ${i}`));
    const { onCreated } = renderDialog(many);
    const filter = await screen.findByRole('textbox');
    fireEvent.change(filter, { target: { value: 'ret' } });
    expect(screen.queryByText('Template 0')).toBeNull();
    fireEvent.keyDown(filter, { key: 'Enter' });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it('explains how to make a template when there are none', async () => {
    renderDialog([]);
    expect(await screen.findByText(/Make template/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New template' })).toBeTruthy();
  });

  it('keeps the dialog open and shows the error when creating fails', async () => {
    const { onClose, onCreated } = renderDialog([template('t1', 'Meeting notes')], { failCreate: true });
    fireEvent.click(await screen.findByRole('button', { name: /Meeting notes/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
