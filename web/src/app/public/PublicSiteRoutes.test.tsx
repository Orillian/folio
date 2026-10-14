// @vitest-environment jsdom
/**
 * Host mode: a site on its own subdomain / custom domain answers at "/" and "/p/:id", and the URLs
 * people may have copied from the main host or from inside the app are forwarded there.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { PublicSiteInfo } from '@shared/contracts';

vi.mock('../../markdown', () => ({
  Markdown: ({ markdown }: { markdown: string }) => <div data-testid="markdown-body">{markdown}</div>,
}));

const { PublicHostRoutes, PublicPathRoutes } = await import('./PublicSiteRoutes');

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SITE: PublicSiteInfo = {
  space: 'docs',
  name: 'Docs',
  allowDownload: false,
  allowAssistant: false,
  mode: 'host',
  homePageId: 'p1',
  instanceUrl: 'https://folio.example.com',
};

function stubFetch() {
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    const body =
      url === '/api/public/site' || url === '/api/public/spaces/docs'
        ? SITE
        : url === '/api/public/spaces/docs/tree'
          ? { tree: [] }
          : /\/pages\/(p\d)$/.test(url)
            ? { spaceName: 'Docs', page: { id: url.slice(-2), space: 'docs', path: 'x.md', kind: 'doc', title: 'Page', order: 0, status: 'published', updatedAt: '', markdown: `body of ${url.slice(-2)}` } }
            : undefined;
    return Promise.resolve(
      body === undefined
        ? { ok: false, status: 404, statusText: '', json: () => Promise.resolve({ error: 'not found' }) }
        : { ok: true, status: 200, statusText: '', json: () => Promise.resolve(body) },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Where() {
  const { pathname, search } = useLocation();
  return <div data-testid="where">{pathname + search}</div>;
}

/** Exposes the router's navigate() so a test can move between URLs without a full re-render. */
let navigateTo: (to: string) => void = () => {};
function Nav() {
  const navigate = useNavigate();
  navigateTo = (to) => void navigate(to);
  return null;
}

function renderAt(path: string, element: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        {element}
        <Where />
        <Nav />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PublicHostRoutes', () => {
  it('serves the home at "/" and a page at "/p/:id"', async () => {
    const fetchMock = stubFetch();
    const { unmount } = renderAt('/', <PublicHostRoutes slug="docs" />);
    await waitFor(() => expect(screen.getByTestId('markdown-body').textContent).toBe('body of p1'));
    expect(fetchMock).toHaveBeenCalledWith('/api/public/site', expect.anything());
    unmount();

    renderAt('/p/p2', <PublicHostRoutes slug="docs" />);
    await waitFor(() => expect(screen.getByTestId('markdown-body').textContent).toBe('body of p2'));
  });

  it('keeps the site view mounted when moving between the home and a page, so only the page body changes', async () => {
    stubFetch();
    renderAt('/', <PublicHostRoutes slug="docs" />);
    await waitFor(() => expect(screen.getByTestId('markdown-body').textContent).toBe('body of p1'));
    const search = screen.getByRole('searchbox') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'half-typed' } });

    act(() => navigateTo('/p/p2'));
    await waitFor(() => expect(screen.getByTestId('markdown-body').textContent).toBe('body of p2'));
    expect(screen.getByRole('searchbox')).toBe(search);
    expect(search.value).toBe('half-typed');

    act(() => navigateTo('/'));
    await waitFor(() => expect(screen.getByTestId('markdown-body').textContent).toBe('body of p1'));
    expect(screen.getByRole('searchbox')).toBe(search);
  });

  it('forwards /public/<slug>/… and /s/<slug>/… to the host-mode URLs, keeping the query', async () => {
    stubFetch();
    const cases: [string, string][] = [
      ['/public/docs', '/'],
      ['/public/docs/p/p2', '/p/p2'],
      ['/public/docs/p/p2?row=r1', '/p/p2?row=r1'],
      ['/s/docs', '/'],
      ['/s/docs/p/p2', '/p/p2'],
      ['/s/other/p/p2', '/'],
      ['/nowhere/at/all', '/'],
    ];
    for (const [from, to] of cases) {
      const { unmount } = renderAt(from, <PublicHostRoutes slug="docs" />);
      await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(to));
      unmount();
    }
  });
});

describe('PublicPathRoutes', () => {
  it('serves /public/<slug>/p/<id> from the anonymous route of that slug', async () => {
    const fetchMock = stubFetch();
    renderAt('/public/docs/p/p2', <PublicPathRoutes />);
    await waitFor(() => expect(screen.getByTestId('markdown-body').textContent).toBe('body of p2'));
    expect(fetchMock).toHaveBeenCalledWith('/api/public/spaces/docs', expect.anything());
  });

  it('answers a bare /public with the "not public" page, not a blank screen', async () => {
    stubFetch();
    renderAt('/public', <PublicPathRoutes />);
    expect(await screen.findByRole('heading', { name: 'This space is not public' })).toBeTruthy();
  });
});
