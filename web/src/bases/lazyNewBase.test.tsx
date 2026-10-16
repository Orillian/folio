// @vitest-environment jsdom
/** "New base" opens at once: the shell (title + spinner) is on screen before the dialog's chunk arrives, and the chunk is requested once. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from '../app/ui/Toast';
import { NewBaseDialog, preloadNewBaseDialog } from './lazyNewBase';

beforeEach(async () => {
  await i18next.changeLanguage('en');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ tree: [] }) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('lazy "New base" dialog', () => {
  it('shows the shell immediately, then the dialog', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter>
            <NewBaseDialog space="sp" initialParentPath="" onClose={() => undefined} />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    // Synchronously after the first render: no blank wait.
    expect(screen.getByText('New base')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(await screen.findByLabelText('Name')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('the preload requests the chunk once and hands the same promise to every caller', async () => {
    const a = preloadNewBaseDialog();
    expect(preloadNewBaseDialog()).toBe(a);
    expect(typeof (await a).default).toBe('function');
  });
});
