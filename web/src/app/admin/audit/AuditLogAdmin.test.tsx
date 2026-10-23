// @vitest-environment jsdom
/**
 * /admin/audit — rows with human labels for known actions and the raw action + meta for unknown
 * ones, filters going to the request, "Load more" by cursor, the CSV link carrying the filter, and
 * the 403 state. Also the sessions list (own and admin views). The HTTP layer is a fetch stub.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { AuditLogEvent, AuditLogPage, SessionInfo } from '@shared/contracts';
import { ToastProvider } from '../../ui/Toast';
import { SessionsList } from '../../sessions/SessionsList';
import { AuditLogAdmin } from './AuditLogAdmin';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200): Response => ({ ok: status < 300, status, json: () => Promise.resolve(body) }) as Response;

const OLHA = { id: '11111111-1111-4111-8111-111111111111', name: 'Olha', email: 'olha@t.local' };
function event(id: string, patch: Partial<AuditLogEvent> = {}): AuditLogEvent {
  return { id, at: '2026-10-01T10:00:00.000Z', actorId: OLHA.id, actorName: OLHA.name, actorEmail: OLHA.email, action: 'access.grant', target: 'eng', targetName: null, meta: { targetUserId: 'u2', role: 'editor' }, ...patch };
}

function renderAt(ui: React.ReactElement, url = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function stub(pages: Record<string, AuditLogPage>, status = 200) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('/api/users')) return json({ users: [{ ...OLHA, isAdmin: true, createdAt: '2026-01-01T00:00:00.000Z' }] });
      if (url.startsWith('/api/admin/audit')) {
        if (status !== 200) return json({ error: 'requires instance admin' }, status);
        const cursor = new URL(url, 'http://x').searchParams.get('cursor') ?? '';
        return json(pages[cursor] ?? { events: [], nextCursor: null });
      }
      return json({}, 404);
    }),
  );
  return calls;
}

describe('AuditLogAdmin', () => {
  it('labels known actions, shows unknown ones as they are, and loads the next page by cursor', async () => {
    const calls = stub({
      '': { events: [event('3'), event('2', { action: 'future.thing', target: null, meta: { x: 1 }, actorId: null, actorName: null, actorEmail: null })], nextCursor: '2' },
      '2': { events: [event('1', { action: 'group.member_add', target: 'g1', meta: null })], nextCursor: null },
    });
    renderAt(<AuditLogAdmin />);

    expect(await screen.findByText('Access granted')).toBeTruthy();
    expect(screen.getByText('future.thing')).toBeTruthy(); // no label: the raw action string
    expect(screen.getByText('Guest or system')).toBeTruthy();
    expect(screen.getByText('targetUserId')).toBeTruthy(); // meta shown field by field

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Member added to group')).toBeTruthy();
    expect(calls.some((c) => c.includes('cursor=2'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('labels a restore (and an old unarchive logged as archive with archived:false) as restored, and shows resolved target names', async () => {
    stub({
      '': {
        events: [
          event('3', { action: 'group.restore', target: 'g-1', targetName: 'Sales team', meta: { groupName: 'Sales team', archived: false } }),
          event('2', { action: 'group.archive', target: 'g-1', targetName: 'Sales team', meta: { groupName: 'Sales team', archived: false } }),
          event('1', { action: 'group.archive', target: 'g-1', targetName: 'Sales team', meta: { groupName: 'Sales team', archived: true } }),
        ],
        nextCursor: null,
      },
    });
    renderAt(<AuditLogAdmin />);
    expect((await screen.findAllByText('Group restored')).length).toBe(2);
    expect(screen.getAllByText('Group archived').length).toBe(1);
    expect(screen.getAllByText('Sales team').length).toBeGreaterThanOrEqual(3); // the resolved target name on every row (meta repeats it)
    expect(screen.getAllByText('g-1').length).toBe(3); // the raw id stays visible under it
  });

  it('sends the filters and puts them into the CSV link', async () => {
    const calls = stub({ '': { events: [], nextCursor: null } });
    renderAt(<AuditLogAdmin />, '/admin/audit?action=user.&from=2026-10-01');
    await waitFor(() => expect(calls.some((c) => c.startsWith('/api/admin/audit?') && c.includes('action=user.') && c.includes('from=2026-10-01'))).toBe(true));
    expect(await screen.findByText('No events match these filters.')).toBeTruthy();
    const link = screen.getByRole('link', { name: /Export CSV/ });
    expect(link.getAttribute('href')).toBe('/api/admin/audit/export.csv?action=user.&from=2026-10-01');
  });

  it('shows "no access" for a non-admin', async () => {
    stub({}, 403);
    renderAt(<AuditLogAdmin />);
    expect(await screen.findByText("You don't have access to this page.")).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Export CSV/ })).toBeNull();
  });
});

describe('SessionsList', () => {
  const sessions: SessionInfo[] = [
    { id: 's1', createdAt: '2026-10-01T10:00:00.000Z', lastSeenAt: new Date().toISOString(), expiresAt: '2026-11-01T10:00:00.000Z', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', ip: '203.0.113.7', current: true },
    { id: 's2', createdAt: '2026-10-01T10:00:00.000Z', lastSeenAt: null, expiresAt: '2026-11-01T10:00:00.000Z', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari/604.1', ip: null, current: false },
  ];

  function stubSessions() {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? 'GET' });
        if (url.endsWith('/sessions') && (init?.method ?? 'GET') === 'GET') return json({ sessions });
        if (url.endsWith('/revoke-others') || (url.endsWith('/sessions') && init?.method === 'DELETE')) return json({ revoked: 1 });
        return json({ ok: true });
      }),
    );
    return calls;
  }

  it('own list: marks this device, offers revoke only for others, and signs the others out after confirming', async () => {
    const calls = stubSessions();
    renderAt(<SessionsList />);
    expect(await screen.findByText('Chrome · macOS')).toBeTruthy();
    expect(screen.getByText('This device')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out other devices' }));
    // the confirm dialog's own button carries the same label
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Sign out other devices' })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign out other devices' })[1]);
    await waitFor(() => expect(calls.some((c) => c.url === '/api/me/sessions/revoke-others' && c.method === 'POST')).toBe(true));
  });

  it('admin view uses the per-user endpoints', async () => {
    const calls = stubSessions();
    renderAt(<SessionsList userId="u-9" />);
    await screen.findByText('Safari · iOS');
    expect(calls[0].url).toBe('/api/users/u-9/sessions');
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0]);
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/users/u-9/sessions/s2')).toBe(true));
  });
});
