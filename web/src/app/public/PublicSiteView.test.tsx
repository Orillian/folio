// @vitest-environment jsdom
/**
 * The public site shell: what an anonymous visitor gets for a published space. The page is
 * fetched from the anonymous /api/public/** routes only (never a session route), the tree and
 * every link use the site's own URLs (path mode `/public/<slug>/p/<id>`, host mode `/p/<id>`),
 * and nothing asks the visitor to sign in. The heavy leaf renderers (markdown pipeline, table
 * grid) have their own suites; <Markdown> is replaced by a stub that exposes what it was given.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { PublicPagePayload, PublicSiteInfo, SearchHit, TreeNode } from '@shared/contracts';

vi.mock('../../markdown', () => ({
  Markdown: ({ markdown, publicSite }: { markdown: string; publicSite?: { space: string; pageUrl: (id: string) => string } }) => (
    <div data-testid="markdown-body" data-public-site={publicSite ? `${publicSite.space}|${publicSite.pageUrl('x1')}` : ''}>
      {markdown}
    </div>
  ),
}));

const { PublicSiteView } = await import('./PublicSiteView');
const { PublicSiteLoader } = await import('./PublicSiteRoutes');

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.title = '';
});

const SITE: PublicSiteInfo = {
  space: 'docs',
  name: 'Docs',
  allowDownload: false,
  allowAssistant: false,
  mode: 'path',
  homePageId: 'p1',
  instanceUrl: 'https://folio.example.com',
};

function node(id: string, title: string, children: TreeNode[] = [], path = `${id}.md`): TreeNode {
  return { id, space: 'docs', path, kind: 'doc', title, order: 0, status: 'published', updatedAt: '2026-10-13T00:00:00Z', children };
}

const TREE: TreeNode[] = [node('p1', 'Guide', [node('p2', 'Install', [], 'guide/install.md')], 'guide.md'), node('p3', 'Reference')];

function pagePayload(id: string, title: string, markdown: string): PublicPagePayload {
  return {
    spaceName: 'Docs Space',
    page: { id, space: 'docs', path: `${id}.md`, kind: 'doc', title, order: 0, status: 'published', updatedAt: '2026-10-13T00:00:00Z', markdown },
  };
}

const PAGES: Record<string, PublicPagePayload> = {
  p1: pagePayload('p1', 'Guide', '# Guide\n\nWelcome to the guide.'),
  p2: pagePayload('p2', 'Install', '# Install\n\nRun the installer.'),
  p3: pagePayload('p3', 'Reference', '# Reference\n\nAll the options.'),
};

/** Routes fetch by exact URL; anything not listed is a 404, like the real server for a page it will not show. */
function stubFetch(extra: Record<string, unknown> = {}) {
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    let body: unknown;
    if (url === '/api/public/spaces/docs/tree') body = { tree: TREE };
    else if (url in extra) body = extra[url];
    else {
      const match = /^\/api\/public\/spaces\/docs\/pages\/([^/?]+)$/.exec(url);
      body = match ? PAGES[match[1]] : undefined;
    }
    if (body === undefined) {
      return Promise.resolve({ ok: false, status: 404, statusText: '', json: () => Promise.resolve({ error: 'not found' }) });
    }
    return Promise.resolve({ ok: true, status: 200, statusText: '', headers: new Headers(), json: () => Promise.resolve(body) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderSite(site: PublicSiteInfo, initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const basePath = site.mode === 'host' ? '' : '/public/docs';
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path={basePath || '/'} element={<PublicSiteView site={site} />} />
          <Route path={`${basePath}/p/:id`} element={<RoutedView site={site} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The page route: the id comes from the URL, as in PublicSiteRoutes. */
function RoutedView({ site }: { site: PublicSiteInfo }) {
  const { id } = useParams();
  return <PublicSiteView site={site} pageId={id} />;
}

function treeLinks() {
  const nav = screen.getByRole('navigation', { name: 'Pages' });
  return Array.from(nav.querySelectorAll('a'));
}

describe('PublicSiteView', () => {
  it('shows the home page, the tree with the site\'s own URLs and the footer links, without asking anyone to sign in', async () => {
    const fetchMock = stubFetch();
    renderSite(SITE, '/public/docs');

    await waitFor(() => expect(screen.getByTestId('markdown-body').textContent).toContain('Welcome to the guide.'));
    // The page opens at the home URL: `homePageId` is fetched, no redirect to /p/<id>.
    expect(fetchMock).toHaveBeenCalledWith('/api/public/spaces/docs/pages/p1', expect.anything());
    // Markdown gets the public-site adapter, whose page URLs are the path-mode ones.
    expect(screen.getByTestId('markdown-body').getAttribute('data-public-site')).toBe('docs|/public/docs/p/x1');

    await waitFor(() => expect(treeLinks().length).toBeGreaterThan(0));
    const hrefs = treeLinks().map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/public/docs/p/p1');
    expect(hrefs).toContain('/public/docs/p/p3');
    const current = treeLinks().find((a) => a.getAttribute('aria-current') === 'page');
    expect(current?.getAttribute('href')).toBe('/public/docs/p/p1');

    // A page with children has an expander; the child appears under it with its own public URL.
    expect(screen.queryByRole('link', { name: 'Install' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand “Guide”' }));
    expect(screen.getByRole('link', { name: 'Install' }).getAttribute('href')).toBe('/public/docs/p/p2');

    // Footer: the way into the app for people who have an account; `signin=1` so the app does not bounce them back here.
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('https://folio.example.com/s/docs/p/p1?signin=1');
    expect(screen.getByRole('link', { name: 'Powered by Folio' }).getAttribute('href')).toBe('https://folio.example.com');

    // Nothing here is a login wall, and no request went to a session route.
    expect(screen.queryByText('Log in to Folio')).toBeNull();
    expect(screen.queryByLabelText('Email')).toBeNull();
    for (const [url] of fetchMock.mock.calls) expect(String(url).startsWith('/api/public/')).toBe(true);
  });

  it('titles the tab "<page> · <space name>" and builds breadcrumbs from the tree path', async () => {
    stubFetch();
    renderSite(SITE, '/public/docs/p/p2');

    await waitFor(() => expect(screen.getByTestId('markdown-body').textContent).toContain('Run the installer.'));
    expect(document.title).toBe('Install · Docs Space');

    await waitFor(() => {
      const crumbs = screen.getByRole('navigation', { name: 'Breadcrumbs' });
      expect(within(crumbs).getByRole('link', { name: 'Guide' }).getAttribute('href')).toBe('/public/docs/p/p1');
    });
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumbs' });
    expect(within(crumbs).getByRole('link', { name: 'Docs' }).getAttribute('href')).toBe('/public/docs');
    expect(crumbs.querySelector('[aria-current="page"]')?.textContent).toBe('Install');
    // The parent of the open page starts expanded, so the open page's row is visible and highlighted.
    expect(treeLinks().find((a) => a.getAttribute('aria-current') === 'page')?.getAttribute('href')).toBe('/public/docs/p/p2');
  });

  it('in host mode every URL is rooted at "/"', async () => {
    stubFetch();
    renderSite({ ...SITE, mode: 'host' }, '/');

    await waitFor(() => expect(screen.getByTestId('markdown-body').getAttribute('data-public-site')).toBe('docs|/p/x1'));
    await waitFor(() => expect(treeLinks().length).toBeGreaterThan(0));
    expect(treeLinks().map((a) => a.getAttribute('href'))).toEqual(expect.arrayContaining(['/p/p1', '/p/p3']));
  });

  it('lists the pages when the space has no home page', async () => {
    stubFetch();
    renderSite({ ...SITE, homePageId: null }, '/public/docs');

    const index = await screen.findByRole('navigation', { name: 'All pages' });
    // The list is fully expanded, children included.
    expect(within(index).getByRole('link', { name: 'Install' }).getAttribute('href')).toBe('/public/docs/p/p2');
    expect(screen.queryByTestId('markdown-body')).toBeNull();
  });

  it('says so, with a way back, when the page does not exist', async () => {
    stubFetch();
    renderSite(SITE, '/public/docs/p/gone');

    expect(await screen.findByText("This page doesn't exist on this site.")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the home page' }).getAttribute('href')).toBe('/public/docs');
  });

  it('offers downloads only when the space allows them', async () => {
    stubFetch();
    const { unmount } = renderSite(SITE, '/public/docs');
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    unmount();

    renderSite({ ...SITE, allowDownload: true }, '/public/docs');
    expect(await screen.findByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('searches this space only, debounced, and links hits to the site', async () => {
    const hit: SearchHit = { id: 'p2', space: 'docs', path: 'guide/install.md', title: 'Install', snippet: 'Run the installer' };
    const fetchMock = stubFetch({ '/api/public/spaces/docs/search?q=inst': { hits: [hit] } });
    renderSite(SITE, '/public/docs');
    await waitFor(() => expect(treeLinks().length).toBeGreaterThan(0));

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'inst' } });
    const result = await screen.findByRole('link', { name: /Install\s*Run the installer/ });
    expect(result.getAttribute('href')).toBe('/public/docs/p/p2');
    expect(fetchMock).toHaveBeenCalledWith('/api/public/spaces/docs/search?q=inst', expect.anything());
    // While a query is active the results replace the tree.
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();

    // Following a hit clears the box and brings the tree back.
    fireEvent.click(result);
    expect(await screen.findByRole('navigation', { name: 'Pages' })).toBeTruthy();
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
  });
});

describe('PublicSiteLoader', () => {
  function renderLoader(mode: 'path' | 'host') {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <PublicSiteLoader mode={mode} slug="docs" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('shows "this space is not public" with a sign-in link when the server says 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 404, statusText: '', json: () => Promise.resolve({ error: 'not a public site' }) })),
    );
    renderLoader('path');

    expect(await screen.findByRole('heading', { name: 'This space is not public' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/s/docs?signin=1');
  });

  it('asks the Host-resolved route in host mode and the slug route in path mode', async () => {
    const fetchMock = stubFetch({ '/api/public/site': SITE, '/api/public/spaces/docs': SITE });
    renderLoader('host');
    await waitFor(() => expect(screen.getByTestId('markdown-body')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/public/site', expect.anything());
    // The route knows it is on the site's own host, whatever the payload says.
    await waitFor(() => expect(treeLinks().length).toBeGreaterThan(0));
    expect(treeLinks().map((a) => a.getAttribute('href'))).toContain('/p/p1');
  });
});
