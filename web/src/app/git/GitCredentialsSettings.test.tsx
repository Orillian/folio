// @vitest-environment jsdom
/**
 * Round 22b: GitCredentialsSettings grew a "Confluence" tab alongside its
 * original Git list (same dialog, same "Git access" menu entry — see that
 * file's own doc comment for why the dialog wasn't renamed). This is the
 * wiring test — does switching tabs actually swap the content — not a
 * re-test of either list's own list/delete/notLive behavior, which already
 * have their own focused coverage (GitCredentialForm.test.tsx and
 * ConfluenceCredentialsSection.test.tsx respectively).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { GitCredentialsSettings } from './GitCredentialsSettings';
import { GITHUB_CONNECT_START_PATH, githubConnectStartUrl, type GitConnectResult } from './ConnectGitHubButton';
import { parseGitConnectResult } from './gitConnectReturn';

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

function stubApi({ githubOAuth = false, credentials = [] as unknown[] } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/config') return jsonResponse({ defaultRepoUrl: null, githubOAuth });
    if (url === '/api/me/git-credentials') return jsonResponse({ credentials });
    if (url === '/api/me/confluence-credentials') return jsonResponse({ credentials: [] });
    return jsonResponse({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDialog(connectResult: GitConnectResult | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <GitCredentialsSettings onClose={vi.fn()} connectResult={connectResult} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('GitCredentialsSettings — Git/Confluence tabs (round 22b)', () => {
  it('opens on the Git tab, showing the Git-specific empty state and "connect" prompt', async () => {
    stubApi();
    renderDialog();

    expect(screen.getByRole('tab', { name: 'Git' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(screen.getByText('No saved credentials yet.')).toBeTruthy());
    expect(screen.getByText('Connect GitLab/GitHub')).toBeTruthy();
    expect(screen.queryByText('No saved Confluence credentials yet.')).toBeNull();
  });

  it('switching to the Confluence tab swaps in that section and hides the Git list', async () => {
    stubApi();
    renderDialog();
    await waitFor(() => expect(screen.getByText('No saved credentials yet.')).toBeTruthy());

    fireEvent.click(screen.getByRole('tab', { name: 'Confluence' }));

    await waitFor(() => expect(screen.getByText('No saved Confluence credentials yet.')).toBeTruthy());
    expect(screen.queryByText('No saved credentials yet.')).toBeNull();
    expect(screen.queryByText('Connect GitLab/GitHub')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Confluence' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('GitCredentialsSettings — Connect with GitHub (OAuth App)', () => {
  it('hides the GitHub button when the instance has no OAuth App configured', async () => {
    stubApi({ githubOAuth: false });
    renderDialog();
    await waitFor(() => expect(screen.getByText('No saved credentials yet.')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Connect with GitHub' })).toBeNull();
  });

  it('shows the GitHub button above the token flow when config.githubOAuth is true', async () => {
    stubApi({ githubOAuth: true });
    renderDialog();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect with GitHub' })).toBeTruthy());
    expect(screen.getByText('Connect GitLab/GitHub')).toBeTruthy();
  });

  it('marks an OAuth-connected credential with a badge naming the GitHub account', async () => {
    stubApi({
      credentials: [
        { id: 'c1', host: 'github.com', provider: 'github', label: '@octo-user', createdAt: '2026-10-13T00:00:00.000Z', source: 'oauth', accountLogin: 'octo-user' },
        { id: 'c2', host: 'gitlab.example.com', provider: 'gitlab', label: 'Work', createdAt: '2026-10-13T00:00:00.000Z', source: 'pat' },
      ],
    });
    renderDialog();
    await waitFor(() => expect(screen.getByText('@octo-user')).toBeTruthy());
    const badges = screen.getAllByText('OAuth');
    expect(badges).toHaveLength(1);
    expect(badges[0].getAttribute('title')).toBe('Connected with GitHub as @octo-user');
  });

  it('shows the result of the round-trip once, as a toast', async () => {
    stubApi();
    renderDialog('ok');
    await waitFor(() => expect(screen.getByText('GitHub connected')).toBeTruthy());
    cleanup();

    stubApi();
    renderDialog('denied');
    await waitFor(() => expect(screen.getByText('GitHub access was not granted.')).toBeTruthy());
  });

  it('the start URL carries the path to come back to; unknown ?gitConnect values fall back to a generic error', () => {
    expect(githubConnectStartUrl('/s/team/page')).toBe(`${GITHUB_CONNECT_START_PATH}?returnTo=%2Fs%2Fteam%2Fpage`);
    expect(parseGitConnectResult('?gitConnect=ok')).toBe('ok');
    expect(parseGitConnectResult('?gitConnect=scope&x=1')).toBe('scope');
    expect(parseGitConnectResult('?gitConnect=<script>')).toBe('exchange');
    expect(parseGitConnectResult('?other=1')).toBeNull();
  });
});
