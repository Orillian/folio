// @vitest-environment jsdom
/**
 * /admin/auth — a provider's "SCIM provisioning" section: base URL, token generated once and shown once, rotate
 * behind a confirmation, counts, the audit link. The HTTP layer is a fetch stub; the server side lives in
 * server/scim/scim.test.ts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { AuthProviderInfo, ScimStatusInfo } from '@shared/contracts';
import { ToastProvider } from '../../ui/Toast';
import '../../i18n/register';
import { ScimPanel, SCIM_AUDIT_LINK } from './ScimPanel';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PROVIDER = { id: 'p1', slug: 'okta', displayName: 'Okta', scimEnabled: false } as AuthProviderInfo;
const OFF: ScimStatusInfo = { enabled: false, baseUrl: 'https://folio.example.com/scim/v2', token: null, lastSyncAt: null, users: 0, groups: 0, jitIgnored: false };
const ON: ScimStatusInfo = { ...OFF, enabled: true, token: { prefix: 'folio_scim_AbCd', createdAt: '2026-10-23T08:00:00.000Z', lastUsedAt: null }, users: 3, groups: 1 };

function stub() {
  let current = OFF;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === '/api/admin/auth/providers/p1/scim') return json(current);
    if (url === '/api/admin/auth/providers/p1/scim/token' && init?.method === 'POST') {
      current = ON;
      return json({ token: 'folio_scim_AbCdSECRET', jitDisabled: true, status: ON });
    }
    return json({ error: 'unexpected' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPanel(provider: AuthProviderInfo = PROVIDER) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <ScimPanel provider={provider} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ScimPanel', () => {
  it('shows the base URL, generates a token shown once, and offers rotate behind a confirmation', async () => {
    const fetchMock = stub();
    renderPanel();
    expect(fetchMock).not.toHaveBeenCalled(); // collapsed: nothing loaded yet
    fireEvent.click(screen.getByRole('button', { name: /SCIM provisioning/ }));
    expect(await screen.findByText('https://folio.example.com/scim/v2')).toBeTruthy();
    expect(screen.getByText('none: SCIM is off')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'SCIM events in the audit log' }).getAttribute('href')).toBe(SCIM_AUDIT_LINK);

    fireEvent.click(screen.getByRole('button', { name: 'Generate token' }));
    expect(await screen.findByText('folio_scim_AbCdSECRET')).toBeTruthy();
    expect(screen.getByText('Copy the token now: it is shown only once.')).toBeTruthy();
    expect(screen.getByText('3 people · 1 group')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Rotate token' }));
    expect(await screen.findByText('Rotate the SCIM token?')).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1));
  });
});
