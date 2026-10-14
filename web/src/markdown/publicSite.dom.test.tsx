// @vitest-environment jsdom
/**
 * <Markdown> on a public site (the `publicSite` option): an anonymous reader, so nothing may
 * call a session route, but links must still work — relative `.md` links resolve through the
 * anonymous route and land on the site's URL, Folio URLs pointing at this very space become the
 * site's URLs, and images/files come from the public `/files/…` route without any token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { Markdown } from './index';
import type { MarkdownPublicSite } from './publicSite';
import { clearMentionIndex } from './mentionIndex';

function makeSite(overrides: Partial<MarkdownPublicSite> = {}): MarkdownPublicSite {
  return {
    space: 'eng',
    pageUrl: (id) => `/public/eng/p/${id}`,
    homeUrl: '/public/eng',
    resolvePath: () => Promise.reject(new Error('not found')),
    instanceUrl: 'https://folio.example.com',
    ...overrides,
  };
}

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderMarkdown(markdown: string, publicSite: MarkdownPublicSite) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/public/eng']}>
        <Markdown markdown={markdown} space="eng" pagePath="guide/a.md" publicSite={publicSite} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearMentionIndex();
});

describe('<Markdown publicSite>', () => {
  it('resolves a relative .md link through the site and navigates to its public URL', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const resolvePath = vi.fn().mockResolvedValue('abc');
    const { container, getByTestId } = renderMarkdown('[Install](install.md)', makeSite({ resolvePath }));

    fireEvent.click(container.querySelector<HTMLAnchorElement>('a[data-folio-link]')!);

    await waitFor(() => expect(getByTestId('location').textContent).toBe('/public/eng/p/abc'));
    // The path handed over is already resolved against the page (guide/a.md -> guide/install.md).
    expect(resolvePath).toHaveBeenCalledWith('guide/install.md');
    // The session-only resolve route was never touched, and neither was anything else (no mentionable list).
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the not-found hint when the link does not resolve', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { container, getByText } = renderMarkdown('[Gone](gone.md)', makeSite());
    fireEvent.click(container.querySelector<HTMLAnchorElement>('a[data-folio-link]')!);
    await waitFor(() => expect(getByText('Page not found: guide/gone.md')).toBeTruthy());
  });

  it('rewrites a Folio URL of this space to the site URL, and sends another space to the instance when the site is on another host', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const md = ['[same](/s/eng/p/abc)', '[home](/s/eng)', '[other](/s/ops/p/zzz)', '[instance](https://folio.example.com/s/eng/p/def)'].join('\n\n');
    // The page is served from jsdom's own origin while the instance lives elsewhere: a site on its own host.
    const { container, getByTestId } = renderMarkdown(md, makeSite());

    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/public/eng/p/abc', '/public/eng', 'https://folio.example.com/s/ops/p/zzz', '/public/eng/p/def']);

    // A rewritten link navigates inside the SPA instead of reloading.
    fireEvent.click(container.querySelector<HTMLAnchorElement>('a[data-folio-nav="/public/eng/p/abc"]')!);
    await waitFor(() => expect(getByTestId('location').textContent).toBe('/public/eng/p/abc'));
  });

  it('leaves a link to another space untouched when the site is on the instance\'s own origin', () => {
    vi.stubGlobal('fetch', vi.fn());
    const { container } = renderMarkdown('[other](/s/ops/p/zzz)', makeSite({ instanceUrl: window.location.origin }));
    expect(container.querySelector('a')!.getAttribute('href')).toBe('/s/ops/p/zzz');
  });

  it('serves images and files from the public /files route, with no share token', () => {
    vi.stubGlobal('fetch', vi.fn());
    const { container } = renderMarkdown('![shot](img/a.png)\n\n[spec](spec.pdf)', makeSite());
    expect(container.querySelector('img')!.getAttribute('src')).toBe('/files/eng/guide/img/a.png');
    expect(container.querySelector('a[href^="/files/"]')!.getAttribute('href')).toBe('/files/eng/guide/spec.pdf');
  });

  it('shows a neutral note for a form embed instead of fetching the form', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { container } = renderMarkdown('::form{id=f1}', makeSite());
    expect(container.querySelector('.folio-form-embed-segment')!.textContent).toBe('A form can be filled in inside Folio only');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
