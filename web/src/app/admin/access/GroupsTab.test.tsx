// @vitest-environment jsdom
/** Groups tab (053): list, slug auto-derivation on create, add a member, manager toggle. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { AccessMatrixResponse, GroupDetail, GroupInfo } from '@shared/contracts';
import { ToastProvider } from '../../ui/Toast';
import { GroupsTab } from './GroupsTab';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GROUP: GroupInfo = {
  id: 'g-1',
  slug: 'platform',
  name: 'Platform',
  description: 'Platform team',
  source: 'local',
  archivedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  memberCount: 1,
  canManage: true,
};

const DETAIL: GroupDetail = {
  ...GROUP,
  members: [{ userId: 'u-1', name: 'Maria', email: 'maria@t.local', disabled: false, isManager: false, source: 'local', addedAt: '' }],
  spaces: [{ space: 'eng', spaceName: 'Engineering', role: 'editor' }],
};

const MATRIX: AccessMatrixResponse = {
  users: [
    { id: 'u-1', name: 'Maria', email: 'maria@t.local', isAdmin: false, disabled: false },
    { id: 'u-2', name: 'Marcus', email: 'marcus@t.local', isAdmin: false, disabled: false },
  ],
  spaces: [{ slug: 'eng', name: 'Engineering', visibility: 'private' }],
  roles: {},
  groups: [{ id: 'g-1', slug: 'platform', name: 'Platform', memberCount: 1, archived: false }],
  groupRoles: { 'g-1': { eng: 'editor' } },
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function stubApi() {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (method !== 'GET') calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === '/api/groups' && method === 'GET') return jsonResponse({ groups: [GROUP] });
    if (url === '/api/groups' && method === 'POST') return jsonResponse({ ...GROUP, id: 'g-2', slug: 'support-team', name: 'Support team' }, 201);
    if (url === '/api/groups/g-1' && method === 'GET') return jsonResponse(DETAIL);
    if (url === '/api/groups/g-2' && method === 'GET') return jsonResponse({ ...DETAIL, id: 'g-2', name: 'Support team', members: [], spaces: [] });
    if (url === '/api/groups/g-1/members' && method === 'POST') return jsonResponse(DETAIL);
    if (url === '/api/groups/g-1/members/u-1' && method === 'PUT') return jsonResponse(DETAIL);
    return jsonResponse({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <GroupsTab matrix={MATRIX} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('GroupsTab', () => {
  it('lists groups and expands a panel with members and the spaces the group has roles in', async () => {
    stubApi();
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Toggle group Platform' }));
    expect(await screen.findByText('Maria')).toBeTruthy();
    expect(screen.getByText('Engineering: Editor')).toBeTruthy();
  });

  it('adds a person found by search and toggles a manager flag', async () => {
    const { calls } = stubApi();
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Toggle group Platform' }));
    await screen.findByText('Maria');

    fireEvent.change(screen.getByLabelText('Find a person to add…'), { target: { value: 'marc' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/groups/g-1/members')?.body).toEqual({ userIds: ['u-2'] }));

    fireEvent.click(screen.getByLabelText('Maria is a manager'));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/groups/g-1/members/u-1')?.body).toEqual({ isManager: true }));
  });

  it('create dialog derives the slug from the name until it is edited by hand', async () => {
    const { calls } = stubApi();
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'New group' }));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Support team' } });
    expect((screen.getByLabelText('Address (slug)') as HTMLInputElement).value).toBe('support-team');

    fireEvent.click(screen.getAllByRole('button', { name: 'New group' }).at(-1)!);
    await waitFor(() => expect(calls.find((c) => c.url === '/api/groups')?.body).toEqual({ name: 'Support team', slug: 'support-team', description: '' }));
  });

  it('marks groups and memberships that come from the identity provider; those cannot be removed by hand', async () => {
    const idpGroup: GroupInfo = { ...GROUP, source: 'oidc' };
    const idpDetail: GroupDetail = {
      ...DETAIL,
      source: 'oidc',
      members: [
        { userId: 'u-1', name: 'Maria', email: 'maria@t.local', disabled: false, isManager: false, source: 'oidc', addedAt: '' },
        { userId: 'u-2', name: 'Marcus', email: 'marcus@t.local', disabled: false, isManager: false, source: 'local', addedAt: '' },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/groups') return jsonResponse({ groups: [idpGroup] });
        if (url === '/api/groups/g-1') return jsonResponse(idpDetail);
        return jsonResponse({ error: 'not found' }, 404);
      }),
    );
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Toggle group Platform' }));
    await screen.findByText('Maria');
    expect(screen.getAllByTestId('group-source-badge')[0]!.textContent).toBe('OIDC');
    expect(screen.getAllByTestId('member-source-badge')).toHaveLength(1);
    expect(screen.getByText(/synced at sign-in/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Remove Maria from the group' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Remove Marcus from the group' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
