// @vitest-environment jsdom
/**
 * Stage 7 (inherited page restrictions): the page access dialog says which
 * parent page restricts this one (a link to it) and who can open the page.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import type { PageAccessInfo } from '@shared/contracts';
import { ToastProvider } from '../ui/Toast';
import { PageAccessButton } from './PageAccessButton';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderButton(info: PageAccessInfo) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => info }) as unknown as Response));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <PageAccessButton pageId="child" space="team" />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const base: PageAccessInfo = { visibility: 'space', canManage: true, members: [], groups: [], inheritedFrom: [] };

describe('PageAccessButton: inherited restrictions', () => {
  it('names the restricting parent with a link and lists who can open the page', async () => {
    renderButton({
      ...base,
      inheritedFrom: [{ pageId: 'parent-id', title: 'Salaries' }],
      audience: [
        { userId: 'u1', name: 'Alice', role: 'viewer' },
        { userId: 'u2', name: 'Carol', role: 'editor' },
      ],
      audienceCount: 2,
    });
    const button = await screen.findByRole('button', { name: 'Page access' });
    await vi.waitFor(() => expect(button.getAttribute('title')).toBe('Restricted by a parent page'));
    fireEvent.click(button);
    const notice = await screen.findByTestId('page-access-inherited');
    expect(notice.textContent).toContain('Restricted by parent page');
    const link = screen.getByRole('link', { name: 'Salaries' });
    expect(link.getAttribute('href')).toBe('/s/team/p/parent-id');
    const audience = screen.getByTestId('page-access-audience');
    expect(audience.textContent).toContain('2 people can open this page');
    expect(audience.textContent).toContain('Alice');
    expect(audience.textContent).toContain('Can edit');
  });

  it('an open page shows no inherited notice and no audience', async () => {
    renderButton(base);
    const button = await screen.findByRole('button', { name: 'Page access' });
    await vi.waitFor(() => expect(button.getAttribute('title')).toBe('Available to all space members'));
    fireEvent.click(button);
    await screen.findByText('All space members');
    expect(screen.queryByTestId('page-access-inherited')).toBeNull();
    expect(screen.queryByTestId('page-access-audience')).toBeNull();
  });
});
