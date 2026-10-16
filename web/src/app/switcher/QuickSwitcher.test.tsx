// @vitest-environment jsdom
/**
 * Search v2 in the quick switcher (Obsidian wave 3): the operators help line, kind icons and tag
 * chips on hits, a query handed in by the sidebar (`tag:<tag>`), and saved searches — listed
 * first while nothing is typed, run on click, saved by name, deleted after a confirm.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import { SettingsProvider } from '../settings';
import { ToastProvider } from '../ui/Toast';
import { QuickSwitcher } from './QuickSwitcher';
import '../i18n/register';

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Test', email: 't@t.local', isAdmin: false, createdAt: '' }, memberships: {}, logout: () => {}, loggingOut: false }),
  useSpaceRole: () => 'editor' as const,
}));

const SAVED = [
  { id: 's1', name: 'Open drafts', query: 'status:draft kind:doc', space: 'demo', createdAt: '2026-10-01T00:00:00.000Z' },
  { id: 's2', name: 'Everything tagged plan', query: 'tag:plan', space: null, createdAt: '2026-10-02T00:00:00.000Z' },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

const TABLE_HIT = { id: 'h1', space: 'demo', path: 'plan/q4.md', title: 'Q4 plan', snippet: 'Roadmap for the quarter', kind: 'table', tags: ['plan', 'plan/q4'] };

function stubNetwork(hits: unknown[] = [TABLE_HIT]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/me/saved-searches' && method === 'GET') return json({ searches: SAVED });
      if (url === '/api/me/saved-searches' && method === 'POST') return json({ id: 's3', ...JSON.parse(String(init?.body)), createdAt: '2026-10-14T00:00:00.000Z' });
      if (url.startsWith('/api/me/saved-searches/') && method === 'DELETE') return new Response(null, { status: 204 });
      if (url.startsWith('/api/search?')) {
        return json({ hits });
      }
      return json({ error: 'not found' }, 404);
    }),
  );
  return calls;
}

function renderSwitcher(initialQuery?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsProvider>
        <ToastProvider>
          <MemoryRouter>
            <QuickSwitcher space="demo" initialQuery={initialQuery} onClose={() => undefined} />
          </MemoryRouter>
        </ToastProvider>
      </SettingsProvider>
    </QueryClientProvider>,
  );
}

const searchUrls = (calls: Call[]) => calls.filter((c) => c.url.startsWith('/api/search?')).map((c) => decodeURIComponent(c.url));

beforeAll(async () => {
  await i18next.changeLanguage('en');
  // jsdom has no layout: the switcher scrolls the active row into view.
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('QuickSwitcher — search v2', () => {
  it('lists the operators while nothing is typed and while the query holds one, and a click types the operator in', async () => {
    stubNetwork();
    renderSwitcher();

    const help = screen.getByLabelText('Search operators');
    for (const label of ['tag:', 'kind:', 'status:', 'in:', 'prop:', '"phrase"', '-word']) {
      expect(within(help).getByText(label)).toBeTruthy();
    }

    const input = screen.getByRole('combobox') as HTMLInputElement;
    await userEvent.type(input, 'roadmap');
    expect(screen.queryByLabelText('Search operators')).toBeNull(); // plain words: no help in the way

    await userEvent.type(input, ' x:');
    expect(screen.getByLabelText('Search operators')).toBeTruthy(); // a ":" brings it back

    await userEvent.clear(input);
    await userEvent.click(within(screen.getByLabelText('Search operators')).getByText('tag:'));
    expect(input.value).toBe('tag:');
  });

  it('opens with the query it is given, searches it, and shows each hit with its kind icon and tag chips', async () => {
    const calls = stubNetwork();
    renderSwitcher('tag:plan');

    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('tag:plan');
    const hit = await screen.findByText('Q4 plan');
    expect(searchUrls(calls)).toContain('/api/search?q=tag:plan&space=demo');
    const row = hit.closest('[role="option"]') as HTMLElement;
    expect(within(row).getByText('#plan')).toBeTruthy();
    expect(within(row).getByText('#plan/q4')).toBeTruthy();
    // A table hit gets the table icon (lucide's Table2), not the plain page icon.
    expect(row.querySelector('svg.lucide-table-2, svg.lucide-table')).toBeTruthy();
  });

  it('lists a hit of every page kind, none dropped (a board / PDF / Office page found by its property tag)', async () => {
    const kinds = ['doc', 'table', 'form', 'board', 'pdf', 'office'];
    stubNetwork(kinds.map((kind) => ({ id: `k-${kind}`, space: 'demo', path: `x/${kind}`, title: `Hit ${kind}`, snippet: '', kind, tags: ['q3', 'roadmap'] })));
    renderSwitcher('tag:q3');
    for (const kind of kinds) {
      const row = (await screen.findByText(`Hit ${kind}`)).closest('[role="option"]') as HTMLElement;
      expect(within(row).getByText('#q3')).toBeTruthy();
    }
    expect(screen.queryByText('Nothing found')).toBeNull();
  });

  it('puts saved searches first on an empty query, runs one on click, and deletes one after a confirm', async () => {
    const calls = stubNetwork();
    renderSwitcher();

    const group = await screen.findByText('Saved searches');
    const options = screen.getAllByRole('option');
    expect(options[0].textContent).toContain('Open drafts'); // the group leads the list
    expect(group).toBeTruthy();

    // Run: the saved query lands in the input and is searched in the space it was saved for.
    await userEvent.click(screen.getByRole('option', { name: /Open drafts/ }));
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('status:draft kind:doc');
    await waitFor(() => expect(searchUrls(calls)).toContain('/api/search?q=status:draft kind:doc&space=demo'));
    expect(await screen.findByText('Q4 plan')).toBeTruthy();

    // A saved search of "all spaces" searches every space (an empty `space`), and says so.
    await userEvent.clear(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: /Everything tagged plan/ }));
    await waitFor(() => expect(searchUrls(calls)).toContain('/api/search?q=tag:plan&space='));
    expect(screen.getByRole('button', { name: 'Search in this space only' })).toBeTruthy();

    // Delete asks first.
    await userEvent.clear(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete saved search Open drafts' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const dialog = await screen.findByRole('dialog', { name: 'Delete saved search?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/me/saved-searches/s1')).toBe(true));
  });

  it('saves the current search by name, pinned to the space', async () => {
    const calls = stubNetwork();
    renderSwitcher('kind:table');

    await userEvent.click(await screen.findByRole('option', { name: /Save this search/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this search' });
    const name = within(dialog).getByRole('textbox');
    await userEvent.clear(name);
    await userEvent.type(name, 'All tables');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'All tables', query: 'kind:table', space: 'demo' });
  });
});
