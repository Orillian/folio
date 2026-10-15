// @vitest-environment jsdom
/**
 * "Indexing & files" dialog (Obsidian vault compatibility, wave 1a): shows the
 * space's own ignore list next to the always-skipped defaults, refuses entries
 * the server would refuse, and PATCHes only what changed.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { ScanSettingsDialog, parseScanIgnoreText } from './ScanSettingsDialog';

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

function stubApi(space: { scanIgnore: string[]; lightFootprint?: boolean; rootPath?: string }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/spaces') {
      return jsonResponse({
        spaces: [
          {
            slug: 'vault',
            name: 'Vault',
            pageCount: 3,
            scanIgnore: space.scanIgnore,
            ...(space.lightFootprint ? { lightFootprint: true } : {}),
            git: { repoUrl: null, branch: 'main', rootPath: space.rootPath ?? '', status: 'local', ahead: 0, behind: 0, lastSyncAt: null, lastSyncByName: null, lastSyncByEmail: null, lastError: null },
          },
        ],
      });
    }
    if (url === '/api/spaces/vault/scan-settings') return jsonResponse({ slug: 'vault', pageCount: 2, scanIgnore: [], lightFootprint: false });
    return jsonResponse({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDialog(onClose = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ScanSettingsDialog space="vault" onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

describe('parseScanIgnoreText', () => {
  it('normalizes, de-duplicates and reports the first bad line', () => {
    expect(parseScanIgnoreText('./Templates/\n\n  draft-*  \nTemplates/\n')).toEqual({ entries: ['Templates/', 'draft-*'] });
    expect(parseScanIgnoreText('ok\n../up\nlater').invalid).toBe('../up');
    expect(parseScanIgnoreText('a/b').invalid).toBe('a/b');
    expect(parseScanIgnoreText('*').invalid).toBe('*');
  });
});

describe('ScanSettingsDialog', () => {
  it('lists the saved entries and the always-skipped defaults, with Save disabled until something changes', async () => {
    stubApi({ scanIgnore: ['Templates/'] });
    renderDialog();
    const box = (await screen.findByLabelText('Do not index')) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe('Templates/'));
    expect(screen.getByText('.obsidian/')).toBeTruthy();
    expect(screen.getByText('.trash/')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses an entry the server would refuse', async () => {
    stubApi({ scanIgnore: [] });
    renderDialog();
    const box = (await screen.findByLabelText('Do not index')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '../secret' } });
    expect(await screen.findByText(/Not a valid entry: \.\.\/secret/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('PATCHes the changed list only and closes', async () => {
    const fetchMock = stubApi({ scanIgnore: [] });
    const onClose = renderDialog();
    const box = (await screen.findByLabelText('Do not index')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Templates/\ndraft-*' } });
    expect(screen.getByText('The space is re-indexed when you save.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const patch = fetchMock.mock.calls.find(([url]) => String(url) === '/api/spaces/vault/scan-settings');
    expect(patch?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ scanIgnore: ['Templates/', 'draft-*'] });
  });

  it('the light footprint switch is sent alone, and is locked for a sub-folder space', async () => {
    const fetchMock = stubApi({ scanIgnore: [] });
    const onClose = renderDialog();
    const toggle = (await screen.findByRole('switch')) as HTMLInputElement;
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const patch = fetchMock.mock.calls.find(([url]) => String(url) === '/api/spaces/vault/scan-settings');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ lightFootprint: true });
  });

  it('a sub-folder space shows the switch on and locked', async () => {
    stubApi({ scanIgnore: [], lightFootprint: true, rootPath: 'docs' });
    renderDialog();
    const toggle = (await screen.findByRole('switch')) as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(toggle.disabled).toBe(true);
  });
});
