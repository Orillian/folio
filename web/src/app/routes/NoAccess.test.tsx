// @vitest-environment jsdom
/**
 * The 403 screen and the 404 screen used to be one view ("404" + a rights
 * hint + Request access). They are now two:
 *  - NotFound: the thing is not there. No hint about rights, no button.
 *  - NoAccess: it exists, the caller may not see it. A request-access button
 *    only when the caller has no role in the space; for a restricted page in
 *    a space they belong to it would only be answered with "you already have
 *    access", so the screen says who to ask instead.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import type { SpaceRole } from '@shared/contracts';
import { NoAccess } from './NoAccess';
import { NotFound } from './NotFound';
import '../i18n/register';

// NoAccess only asks "what is my role in this space"; AuthProvider's real
// answer needs the whole auth bootstrap.
const role = vi.hoisted(() => ({ current: undefined as SpaceRole | undefined }));
vi.mock('../auth/AuthProvider', () => ({
  useSpaceRole: () => role.current,
}));

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

beforeEach(() => {
  role.current = undefined;
});

afterEach(() => {
  cleanup();
});

function renderView(view: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{view}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NoAccess', () => {
  it('offers to request access when the space exists and the caller has no role in it', () => {
    renderView(<NoAccess space="secret" />);
    expect(screen.getByRole('heading', { name: 'No access' })).toBeTruthy();
    expect(screen.getByText(/You don't have access to the space “secret”/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go home' })).toBeTruthy();
    expect(screen.queryByText('404')).toBeNull();
  });

  it('for a restricted page inside a space the caller belongs to, names who to ask — no request button', () => {
    role.current = 'viewer';
    renderView(<NoAccess space="docs" page />);
    expect(screen.getByText(/restricted to specific people/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Go home' })).toBeTruthy();
  });

  it('falls back to a plain line, without a button, when there is no space to ask about', () => {
    renderView(<NoAccess page />);
    expect(screen.getByText("You don't have access to this page.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
  });
});

describe('NotFound', () => {
  it('is a plain 404: no rights hint, no request button', () => {
    renderView(<NotFound message="This page wasn't found — it may have been deleted or moved." />);
    expect(screen.getByText('404')).toBeTruthy();
    expect(screen.getByText(/wasn't found/)).toBeTruthy();
    expect(screen.queryByText(/access/i)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('link', { name: 'Go home' })).toBeTruthy();
  });
});
