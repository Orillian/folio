// @vitest-environment jsdom
/**
 * "Rename" of a canvas / base (owner, 16.10.2026): named by its file as in
 * Obsidian, so the dialog takes any valid file name — Cyrillic, spaces — and
 * POSTs it as the file's new name; every other page kind still takes a slug.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { PageKind, PageMeta } from '@shared/contracts';
import { ChangeSlugDialog } from './ChangeSlugDialog';
import { isValidFileName, normalizeFileName } from './slugUtils';

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

function page(kind: PageKind, path: string, title: string): PageMeta {
  return { id: 'p1', space: 'docs', path, title, kind } as PageMeta;
}

function renderDialog(meta: PageMeta, status = 200) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(status === 200 ? { ...meta, path: 'moved' } : { error: 'exists' }, status));
  vi.stubGlobal('fetch', fetchMock);
  const handlers = { onClose: vi.fn(), onChanged: vi.fn(), onError: vi.fn() };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ChangeSlugDialog page={meta} {...handlers} />
    </QueryClientProvider>,
  );
  return { fetchMock, ...handlers };
}

const input = () => screen.getByRole('textbox') as HTMLInputElement;
const action = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('file-name helpers', () => {
  it('normalizes and validates what Obsidian would take as a file name', () => {
    expect(normalizeFileName('  Мої задачі.canvas ', 'canvas')).toBe('Мої задачі');
    expect(normalizeFileName('Мої задачі', 'base')).toBe('Мої задачі');
    expect(isValidFileName('Мої задачі', 'canvas')).toBe(true);
    expect(isValidFileName('Plan 2026 (draft)', 'base')).toBe(true);
    for (const bad of ['', '  ', '.hidden', 'ends.', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'x'.repeat(250), '.canvas']) {
      expect(isValidFileName(bad, 'canvas'), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('ChangeSlugDialog for a canvas / base', () => {
  it('accepts a Cyrillic name with a space and sends it as the new name', async () => {
    const { fetchMock, onChanged, onClose } = renderDialog(page('canvas', 'Boards/roadmap.canvas', 'roadmap'));
    expect(screen.getByText('Current name: roadmap')).toBeTruthy();
    fireEvent.change(input(), { target: { value: 'Мої задачі' } });
    expect(input().getAttribute('aria-invalid')).toBe('false');
    expect(screen.getByText(/New path: Boards\/Мої задачі\.canvas/)).toBeTruthy();
    fireEvent.click(action('Rename'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onChanged).toHaveBeenCalled();
    const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/pages/p1/slug');
    expect(call?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ slug: 'Мої задачі' });
  });

  it('refuses a forbidden character, an empty name and an unchanged name', () => {
    renderDialog(page('base', 'tasks.base', 'tasks'));
    for (const bad of ['a/b', 'a:b', '.hidden', '   ']) {
      fireEvent.change(input(), { target: { value: bad } });
      expect(input().getAttribute('aria-invalid'), bad).toBe('true');
      expect(action('Rename').disabled, bad).toBe(true);
    }
    expect(screen.getByText(/must not be empty/)).toBeTruthy();
    fireEvent.change(input(), { target: { value: 'tasks' } });
    expect(action('Rename').disabled).toBe(true);
  });

  it('shows a clear message when the name is taken (409)', async () => {
    const { onError, onClose } = renderDialog(page('canvas', 'a.canvas', 'a'), 409);
    fireEvent.change(input(), { target: { value: 'Taken' } });
    fireEvent.click(action('Rename'));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('A file with this name already exists in this folder'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ChangeSlugDialog for an ordinary page', () => {
  it('still takes only a slug', () => {
    renderDialog(page('doc', 'notes/plan.md', 'Plan'));
    fireEvent.change(input(), { target: { value: 'Мої задачі' } });
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(action('Change').disabled).toBe(true);
    fireEvent.change(input(), { target: { value: 'my-plan' } });
    expect(action('Change').disabled).toBe(false);
  });
});
