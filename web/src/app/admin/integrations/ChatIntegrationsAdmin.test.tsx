// @vitest-environment jsdom
/**
 * /admin/integrations — per platform: configured or not, which variables are present, the URLs
 * to paste, the downloads; the connected people with a disconnect; "no access" on a 403. The HTTP
 * layer is a fetch stub; the server side lives in server/integrations/chat/*.test.ts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { AdminChatLinkInfo, ChatIntegrationsAdminInfo } from '@shared/contracts';
import { ToastProvider } from '../../ui/Toast';
import { ChatIntegrationsAdmin } from './ChatIntegrationsAdmin';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const STATUS: ChatIntegrationsAdminInfo = {
  slack: {
    configured: true,
    env: { FOLIO_SLACK_SIGNING_SECRET: true, FOLIO_SLACK_BOT_TOKEN: true, FOLIO_SLACK_CLIENT_ID: true, FOLIO_SLACK_CLIENT_SECRET: true, FOLIO_SLACK_TEAM_ID: false, FOLIO_SECRET: true },
    endpoints: { eventsRequestUrl: 'https://folio.example.com/api/integrations/slack/events' },
    domains: ['folio.example.com'],
    linkedUsers: 1,
  },
  teams: {
    configured: false,
    env: { FOLIO_TEAMS_APP_ID: false, FOLIO_TEAMS_TENANT_ID: false, FOLIO_TEAMS_APP_PASSWORD: false, FOLIO_SECRET: true },
    endpoints: { messagingEndpoint: 'https://folio.example.com/api/integrations/teams/messages' },
    domains: ['folio.example.com'],
    linkedUsers: 0,
  },
};
const LINK: AdminChatLinkInfo = {
  id: '11111111-1111-4111-8111-111111111111',
  platform: 'slack',
  platformUserName: 'olha.s',
  createdAt: '2026-10-16T08:00:00.000Z',
  lastUsedAt: null,
  userId: 'u1',
  userName: 'Olha',
  userEmail: 'olha@example.com',
};

function stubApi(forbidden = false) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (forbidden) return json({ error: 'requires instance admin' }, 403);
    if (url === '/api/admin/integrations/chat') return json(STATUS);
    if (url === '/api/admin/integrations/chat/links') return json({ links: [LINK] });
    if (url === `/api/admin/integrations/chat/links/${LINK.id}` && init?.method === 'DELETE') return json({ ok: true });
    return json({ error: 'unexpected' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/admin/integrations']}>
          <ChatIntegrationsAdmin />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ChatIntegrationsAdmin', () => {
  it('shows each platform, its variables (names only), the URLs to paste and the downloads', async () => {
    stubApi();
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Slack' })).toBeTruthy();
    expect(screen.getByText('Configured')).toBeTruthy();
    expect(screen.getByText('Not configured')).toBeTruthy();
    expect(screen.getByText('FOLIO_SLACK_SIGNING_SECRET')).toBeTruthy();
    expect(screen.getByText('https://folio.example.com/api/integrations/slack/events')).toBeTruthy();
    expect(screen.getByText('Event Subscriptions: Request URL')).toBeTruthy();
    expect(screen.getByText('1 person connected')).toBeTruthy();
    expect(screen.getByText('Download Slack app manifest').closest('a')?.getAttribute('href')).toBe('/api/admin/integrations/chat/slack-manifest.yaml');
    // no app id: no Teams package to download yet
    expect(screen.queryByText('Download Teams app package')).toBeNull();
    expect(screen.getByText('Set FOLIO_TEAMS_APP_ID to download the Teams app package.')).toBeTruthy();
  });

  it('lists connected people and disconnects one after confirming', async () => {
    const fetchMock = stubApi();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Olha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, init]) => String(u) === `/api/admin/integrations/chat/links/${LINK.id}` && init?.method === 'DELETE')).toBe(true),
    );
  });

  it('says "no access" on a 403', async () => {
    stubApi(true);
    renderPage();
    expect(await screen.findByText("You don't have access to this page.")).toBeTruthy();
  });
});
