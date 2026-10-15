// @vitest-environment jsdom
/**
 * <Markdown> with Obsidian-flavoured markdown (wave 2): the pieces that need a
 * component - one metadata request per page, the click on a wikilink, the
 * create offer, embedded notes with depth and cycles, tag chips, formulas.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { EmbedPayload, PageLinkRef } from '@shared/contracts';
import { Markdown, type MarkdownProps } from '../index';
import { clearPageLinksCache } from '../wikilinks';
import { clearEmbedCache } from '../EmbedView';
import { clearMentionIndex } from '../mentionIndex';
import { SEARCH_REQUEST_EVENT } from '../searchEvent';
import { link } from './render';

type Handler = (url: string) => { status?: number; body: unknown } | undefined;

/** A fetch that answers by URL; everything else is an empty 404. Returns the mock so calls can be counted. */
function stubFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const answer = handler(url) ?? { status: 404, body: { error: 'not found' } };
    const status = answer.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => answer.body } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function Probe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.hash}`}</div>;
}

function renderPage(props: Partial<MarkdownProps> & { markdown: string }, entry = '/s/eng/p/HOST') {
  // The backlinks section of a page that has an id runs a react-query hook.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <Markdown space="eng" pagePath="notes/host.md" pageId="HOST" {...props} />
                <Probe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const hostLinks: PageLinkRef[] = [
  link({ linkPath: 'Note', syntax: 'wikilink', kind: 'page', targetPageId: 'P1' }),
  link({ linkPath: 'Note', syntax: 'wikilink', kind: 'page', targetPageId: 'P1', fragment: 'Part two', fragmentKind: 'heading', fragmentResolved: true }),
  link({ linkPath: 'Ghost', syntax: 'wikilink', kind: 'unresolved', targetPath: 'Ghost.md' }),
];

beforeEach(async () => {
  await i18next.changeLanguage('en');
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearPageLinksCache();
  clearEmbedCache();
  clearMentionIndex();
});

describe('<Markdown> wikilinks', () => {
  it('asks for the page metadata once, however many links the page has, and not at all without any', async () => {
    const fetchMock = stubFetch((url) => (url === '/api/pages/HOST/meta' ? { body: { links: hostLinks } } : undefined));
    renderPage({ markdown: '[[Note]] [[Note]] [[Ghost]] [[Note#Part two]]' });
    await waitFor(() => expect(document.querySelector('a[data-wikilink-state="page"]')).not.toBeNull());
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/meta'))).toHaveLength(1);

    cleanup();
    fetchMock.mockClear();
    renderPage({ markdown: 'No links here, only #tags.' });
    await act(async () => {});
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/meta'))).toHaveLength(0);
  });

  it('navigates to the page, with the heading after #, on click', async () => {
    stubFetch((url) => (url === '/api/pages/HOST/meta' ? { body: { links: hostLinks } } : undefined));
    renderPage({ markdown: 'Go to [[Note#Part two|part two]].' });
    const anchor = await waitFor(() => {
      const el = document.querySelector<HTMLAnchorElement>('a[data-wikilink-state="page"]');
      if (!el) throw new Error('not resolved yet');
      return el;
    });
    fireEvent.click(anchor);
    expect(screen.getByTestId('location').textContent).toBe('/s/eng/p/P1#part-two');
  });

  it('offers to create a page that does not exist, and opens it once created', async () => {
    stubFetch((url) => (url === '/api/pages/HOST/meta' ? { body: { links: hostLinks } } : undefined));
    const onCreatePage = vi.fn(async () => ({ id: 'NEW1', space: 'eng' }));
    renderPage({ markdown: 'A [[Ghost]] link', canCreate: true, onCreatePage });
    const ghost = await waitFor(() => {
      const el = document.querySelector<HTMLAnchorElement>('a[data-wikilink-state="unresolved"]');
      if (!el) throw new Error('not resolved yet');
      return el;
    });
    fireEvent.click(ghost);
    const create = await screen.findByRole('button', { name: 'Create page “Ghost”' });
    fireEvent.click(create);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/s/eng/p/NEW1'));
    expect(onCreatePage).toHaveBeenCalledWith({ parentPath: 'notes', title: 'Ghost', fileStem: 'Ghost' });
  });

  it('only says the page does not exist when the reader may not create pages', async () => {
    stubFetch((url) => (url === '/api/pages/HOST/meta' ? { body: { links: hostLinks } } : undefined));
    renderPage({ markdown: 'A [[Ghost]] link', canCreate: false });
    const ghost = await waitFor(() => {
      const el = document.querySelector<HTMLAnchorElement>('a[data-wikilink-state="unresolved"]');
      if (!el) throw new Error('not resolved yet');
      return el;
    });
    fireEvent.click(ghost);
    expect(await screen.findByText('Page “Ghost” does not exist')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Create page/ })).toBeNull();
  });

  it('draws the words and asks nothing where there is no session (a share link)', async () => {
    const fetchMock = stubFetch(() => undefined);
    renderPage({ markdown: 'A [[Note]] link', shareToken: 'tok' });
    await act(async () => {});
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/meta'))).toHaveLength(0);
    expect(document.querySelector('.folio-wikilink--static')?.textContent).toBe('Note');
  });

  it('uses the anonymous links route on a public site', async () => {
    const fetchMock = stubFetch((url) =>
      url === '/api/public/spaces/eng/pages/HOST/links' ? { body: { links: [link({ linkPath: 'Note', syntax: 'wikilink', kind: 'page', targetPageId: 'P1' })] } } : undefined,
    );
    const publicSite = { space: 'eng', pageUrl: (id: string) => `/public/eng/p/${id}`, homeUrl: '/public/eng', resolvePath: async () => 'x' };
    renderPage({ markdown: '[[Note]]', publicSite });
    await waitFor(() => expect(document.querySelector('a[data-folio-nav="/public/eng/p/P1"]')).not.toBeNull());
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/public/spaces/eng/pages/HOST/links')).toBe(true);
  });

  it('scrolls to the heading named by the URL hash once it is drawn', async () => {
    stubFetch(() => undefined);
    renderPage({ markdown: '# Top\n\n## Part two\n\ntext' }, '/s/eng/p/HOST#part-two');
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    const scrolled = (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.contexts[0] as HTMLElement;
    expect(scrolled.id).toBe('user-content-part-two');
  });

  it('scrolls to a ^block anchor, whatever the case of the id', async () => {
    stubFetch(() => undefined);
    renderPage({ markdown: 'Target paragraph ^Blk-1\n\nother' }, '/s/eng/p/HOST#^blk-1');
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    const scrolled = (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.contexts[0] as HTMLElement;
    expect(scrolled.id).toBe('user-content-^Blk-1');
  });
});

describe('<Markdown> embeds', () => {
  const embedOf = (id: string, markdown: string, title = id): EmbedPayload => ({ id, space: 'eng', path: `notes/${id}.md`, title, markdown });

  it('draws the embedded note under a link to its source, asking with depth 1 and the fragment', async () => {
    const fetchMock = stubFetch((url) => {
      if (url === '/api/pages/HOST/meta') {
        return { body: { links: [link({ linkPath: 'Other', syntax: 'embed', kind: 'page', targetPageId: 'P2', fragment: 'Part', fragmentKind: 'heading', fragmentResolved: true })] } };
      }
      if (url.startsWith('/api/pages/P2/embed')) return { body: embedOf('P2', '## Part\n\nEmbedded **words**', 'Other note') };
      return undefined;
    });
    renderPage({ markdown: 'Intro\n\n![[Other#Part]]\n\nOutro' });
    expect(await screen.findByText('words')).toBeTruthy();
    const embedCall = fetchMock.mock.calls.map(([url]) => String(url)).find((url) => url.includes('/embed'))!;
    expect(embedCall).toBe('/api/pages/P2/embed?depth=1&fragment=Part');
    const title = document.querySelector<HTMLAnchorElement>('.folio-embed__title')!;
    expect(title.textContent).toContain('Other note');
    expect(title.getAttribute('data-folio-nav')).toBe('/s/eng/p/P2#part');
    fireEvent.click(title);
    expect(screen.getByTestId('location').textContent).toBe('/s/eng/p/P2#part');
  });

  it('cuts a cycle: a note that embeds the page it is shown in is not drawn again', async () => {
    stubFetch((url) => {
      if (url === '/api/pages/HOST/meta') return { body: { links: [link({ linkPath: 'Other', syntax: 'embed', kind: 'page', targetPageId: 'P2' })] } };
      if (url.startsWith('/api/pages/P2/embed')) return { body: embedOf('P2', 'Other says hi\n\n![[Host]]', 'Other') };
      if (url === '/api/pages/P2/meta') return { body: { links: [link({ linkPath: 'Host', syntax: 'embed', kind: 'page', targetPageId: 'HOST' })] } };
      return undefined;
    });
    renderPage({ markdown: '![[Other]]' });
    expect(await screen.findByText('Other says hi')).toBeTruthy();
    expect(await screen.findByText(/is already shown above/)).toBeTruthy();
  });

  it('stops at the depth limit without asking the server for a fourth level', async () => {
    const pages: Record<string, string> = { P2: 'two\n\n![[Three]]', P3: 'three\n\n![[Four]]', P4: 'four\n\n![[Five]]', P5: 'five' };
    const next: Record<string, [string, string]> = { P2: ['Three', 'P3'], P3: ['Four', 'P4'], P4: ['Five', 'P5'] };
    const fetchMock = stubFetch((url) => {
      if (url === '/api/pages/HOST/meta') return { body: { links: [link({ linkPath: 'Two', syntax: 'embed', kind: 'page', targetPageId: 'P2' })] } };
      const meta = /^\/api\/pages\/(P\d)\/meta$/.exec(url);
      if (meta && next[meta[1]]) return { body: { links: [link({ linkPath: next[meta[1]][0], syntax: 'embed', kind: 'page', targetPageId: next[meta[1]][1] })] } };
      const embed = /^\/api\/pages\/(P\d)\/embed/.exec(url);
      if (embed) return { body: embedOf(embed[1], pages[embed[1]]) };
      return undefined;
    });
    renderPage({ markdown: '![[Two]]' });
    expect(await screen.findByText('three')).toBeTruthy();
    expect(await screen.findByText('Embedded notes are shown up to 3 levels deep')).toBeTruthy();
    const embedCalls = fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/embed'));
    expect(embedCalls.map((u) => /depth=(\d)/.exec(u)![1]).sort()).toEqual(['1', '2', '3']);
  });

  it('says why a note cannot be drawn: gone, no access, section missing', async () => {
    stubFetch((url) => {
      if (url === '/api/pages/HOST/meta') {
        return {
          body: {
            links: [
              link({ linkPath: 'Gone', syntax: 'embed', kind: 'page', targetPageId: 'G1' }),
              link({ linkPath: 'Closed', syntax: 'embed', kind: 'page', targetPageId: 'C1' }),
              link({ linkPath: 'Cut', syntax: 'embed', kind: 'page', targetPageId: 'S1', fragment: 'Nope', fragmentKind: 'heading', fragmentResolved: false }),
            ],
          },
        };
      }
      if (url.startsWith('/api/pages/G1/embed')) return { status: 404, body: { error: 'page not found' } };
      if (url.startsWith('/api/pages/C1/embed')) return { status: 403, body: { error: 'requires viewer+ role on this page' } };
      if (url.startsWith('/api/pages/S1/embed')) return { status: 404, body: { error: 'fragment not found' } };
      return undefined;
    });
    renderPage({ markdown: '![[Gone]]\n\n![[Closed]]\n\n![[Cut#Nope]]' });
    expect(await screen.findByText('“Gone” was not found')).toBeTruthy();
    expect(await screen.findByText('You do not have access to “Closed”')).toBeTruthy();
    expect(await screen.findByText('The embedded section of “Cut” was not found')).toBeTruthy();
  });
});

describe('<Markdown> tags and formulas', () => {
  it('asks the app to search for a clicked #tag', () => {
    stubFetch(() => undefined);
    const listener = vi.fn();
    window.addEventListener(SEARCH_REQUEST_EVENT, listener);
    renderPage({ markdown: 'Planning #q4/launch now', pageId: undefined });
    fireEvent.click(document.querySelector('a[data-folio-tag]')!);
    window.removeEventListener(SEARCH_REQUEST_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ query: 'tag:q4/launch' });
  });

  it('draws a formula with KaTeX, and keeps the TeX when it is invalid', async () => {
    stubFetch(() => undefined);
    renderPage({ markdown: 'Euler $e^{i\\pi}=-1$ and $$\\frac{a}{b}$$ and $\\badmacro{$', pageId: undefined });
    await waitFor(() => expect(document.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2));
    expect(document.querySelector('.folio-math-display .katex-display')).not.toBeNull();
  });
});
