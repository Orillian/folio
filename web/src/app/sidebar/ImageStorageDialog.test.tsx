// @vitest-environment jsdom
/**
 * "Store images in the repository" dialog: shows the space's current asset mode,
 * saves only a real change, and PUTs the chosen mode to /asset-mode.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { ImageStorageDialog } from './ImageStorageDialog';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function stubApi(assetMode: 'store' | 'repo') {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/spaces') return jsonResponse({ spaces: [{ slug: 'docs', name: 'Docs', pageCount: 1, assetMode }] });
    if (url === '/api/spaces/docs/asset-mode') return jsonResponse({ slug: 'docs', assetMode: 'repo' });
    return jsonResponse({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDialog(onClose = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ImageStorageDialog space="docs" onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

describe('ImageStorageDialog', () => {
  it('reflects the current mode and keeps Save disabled until it changes', async () => {
    stubApi('repo');
    renderDialog();
    const toggle = screen.getByRole('switch') as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/render on GitHub too/)).toBeTruthy();
  });

  it('PUTs the chosen mode and closes', async () => {
    const fetchMock = stubApi('store');
    const onClose = renderDialog();
    const toggle = screen.getByRole('switch') as HTMLInputElement;
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const put = fetchMock.mock.calls.find(([url]) => String(url) === '/api/spaces/docs/asset-mode');
    expect(put?.[1]?.method).toBe('PUT');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ assetMode: 'repo' });
  });
});
