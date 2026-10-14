// @vitest-environment jsdom
/**
 * A visitor with no session who opens an internal link (`/s/:space`, `/s/:space/p/:id`) to a
 * PUBLISHED space is sent to the public site's page for it instead of meeting the login wall.
 * A private space (404 from the probe) still shows the login screen; `?signin=1` opts out;
 * and a signed-in user never costs the probe request.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { User } from '@shared/contracts';
import { AuthProvider } from './AuthProvider';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const USER: User = { id: 'u1', email: 'ann@folio.local', name: 'Anna Lee', isAdmin: false, createdAt: '2024-01-01T00:00:00.000Z', username: 'ann' };

function stubApi(options: { user?: User | null; publicSpaces?: string[] }) {
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    const reply = (status: number, body: unknown) =>
      Promise.resolve({ ok: status >= 200 && status < 300, status, statusText: '', json: () => Promise.resolve(body) });
    if (url === '/api/auth/state') return reply(200, { needsSetup: false, user: options.user ?? null, memberships: {}, google: false });
    if (url === '/api/me/stars') return reply(200, { spaces: [], pages: [], emojis: [] });
    const site = /^\/api\/public\/spaces\/([^/?]+)$/.exec(url);
    if (site) {
      return options.publicSpaces?.includes(site[1])
        ? reply(200, { space: site[1], name: site[1], allowDownload: false, allowAssistant: false, mode: 'path', homePageId: null, instanceUrl: 'https://folio.example.com' })
        : reply(404, { error: 'not a public site' });
    }
    return reply(500, { error: `unexpected ${url}` });
  });
  vi.stubGlobal('fetch', fetchMock);
  const probes = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/public/')).length;
  return { probes };
}

function Where() {
  const { pathname, search } = useLocation();
  return <div data-testid="where">{pathname + search}</div>;
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <div>the app</div>
        </AuthProvider>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const LOGIN_TITLE = 'Log in to Folio';

describe('AuthProvider: anonymous visitor on an internal link', () => {
  it('goes to the public site\'s page when the space is published, keeping the query', async () => {
    stubApi({ publicSpaces: ['docs'] });
    renderAt('/s/docs/p/abc?row=r1');
    // (In the real app AppRoutes swaps AuthProvider out for the public routes at that URL; here it stays mounted.)
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/public/docs/p/abc?row=r1'));
  });

  it('goes to the public site\'s home from the space URL', async () => {
    stubApi({ publicSpaces: ['docs'] });
    renderAt('/s/docs');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/public/docs'));
  });

  it('shows the login screen as before when the space is not public', async () => {
    const { probes } = stubApi({ publicSpaces: [] });
    renderAt('/s/secret/p/abc');
    expect(await screen.findByText(LOGIN_TITLE)).toBeTruthy();
    expect(probes()).toBe(1);
    expect(screen.getByTestId('where').textContent).toBe('/s/secret/p/abc');
  });

  it('shows the login screen, without probing, when the visitor asked to sign in (?signin=1)', async () => {
    const { probes } = stubApi({ publicSpaces: ['docs'] });
    renderAt('/s/docs/p/abc?signin=1');
    expect(await screen.findByText(LOGIN_TITLE)).toBeTruthy();
    expect(probes()).toBe(0);
    expect(screen.getByTestId('where').textContent).toBe('/s/docs/p/abc?signin=1');
  });

  it('does not probe for a URL that is not a space\'s', async () => {
    const { probes } = stubApi({ publicSpaces: ['docs'] });
    renderAt('/admin/access');
    expect(await screen.findByText(LOGIN_TITLE)).toBeTruthy();
    expect(probes()).toBe(0);
  });

  it('never probes for a signed-in user, and drops ?signin=1 from the address', async () => {
    const { probes } = stubApi({ user: USER, publicSpaces: ['docs'] });
    renderAt('/s/docs/p/abc?signin=1');
    expect(await screen.findByText('the app')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/s/docs/p/abc'));
    expect(probes()).toBe(0);
  });
});
