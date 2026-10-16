// @vitest-environment jsdom
/** The base editor names file fields in plain words (the raw key stays as a muted hint), and the base's displayName wins. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import BaseEditor from './BaseEditor';
import './i18n/register';

const SOURCE = {
  source: '',
  etag: 'e1',
  canEdit: true,
  config: {
    formulas: {},
    summaries: {},
    properties: { 'file.name': { displayName: 'Page' } },
    views: [{ type: 'table', name: 'Table', order: ['file.name', 'file.folder', 'file.tags', 'file.mtime', 'status'], summaries: { 'file.folder': 'Unique' } }],
  },
};

beforeEach(async () => {
  await i18next.changeLanguage('en');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({ ok: true, status: 200, headers: new Headers(), json: async () => (url.includes('/base/source') ? SOURCE : { known: [] }), text: async () => '' })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BaseEditor property labels', () => {
  it('columns show friendly names, with the raw key as a hint; focusing shows the key', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <BaseEditor pageId="b1" space="sp" initialTab="view" onClose={() => {}} onSaved={() => {}} />
      </QueryClientProvider>,
    );
    const columns = await screen.findAllByLabelText('Column');
    expect(columns.map((c) => (c as HTMLInputElement).value)).toEqual(['Page', 'Folder', 'Tags', 'Modified', 'status']);
    expect(screen.getAllByText('file.folder').length).toBeGreaterThan(0); // the muted hint (columns and summaries)
    fireEvent.focus(columns[1]);
    expect((columns[1] as HTMLInputElement).value).toBe('file.folder');
  });
});
