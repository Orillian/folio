// @vitest-environment jsdom
/** A base just created from the "New base" dialog opens with its Configure editor; a plain visit (or a reload) does not. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import i18next from 'i18next';
import type { BaseQueryResponse } from '@shared/bases/types';
import { BasePageView } from './BasePageView';
import './i18n/register';

vi.mock('./BaseEditor', () => ({ default: ({ initialTab }: { initialTab: string }) => <div data-testid="editor">{initialTab}</div> }));

const RESPONSE: BaseQueryResponse = {
  views: [{ name: 'Table', type: 'table', supported: true }],
  view: 'Table',
  layout: 'table',
  columns: [{ id: 'file.name', label: 'file.name', source: 'file', editable: false }],
  rows: [],
  total: 0,
  groups: [],
  warnings: [],
} as unknown as BaseQueryResponse;

beforeEach(async () => {
  await i18next.changeLanguage('en');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => (url.includes('/property-types') ? { types: {} } : RESPONSE) })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function State() {
  return <output data-testid="state">{JSON.stringify(useLocation().state)}</output>;
}

function renderView(state: unknown, canEditBase = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: '/s/sp/p/nb', state }]}>
        <BasePageView pageId="nb" space="sp" canEditBase={canEditBase} />
        <State />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('BasePageView after "New base"', () => {
  it('opens the Configure editor and forgets the one-shot state', async () => {
    renderView({ folioConfigureBase: 'nb' });
    expect((await screen.findByTestId('editor')).textContent).toBe('view');
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('null'));
  });

  it('does not open it on a plain visit, for another base, or for a reader', async () => {
    renderView(null);
    await screen.findByText('Configure');
    expect(screen.queryByTestId('editor')).toBeNull();
    cleanup();
    renderView({ folioConfigureBase: 'other' });
    await screen.findByText('Configure');
    expect(screen.queryByTestId('editor')).toBeNull();
    cleanup();
    renderView({ folioConfigureBase: 'nb' }, false);
    await screen.findByText(/result/);
    expect(screen.queryByTestId('editor')).toBeNull();
  });
});
