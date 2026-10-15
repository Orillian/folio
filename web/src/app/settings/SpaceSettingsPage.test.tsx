// @vitest-environment jsdom
/**
 * The "Site & PDF" settings page (/s/:space/settings): three tabs over the files of `.folio/`, one
 * Save per tab that sends only that tab's changed files with the etags the editor started from, and
 * the "Changed in the repository" panel when git moved first. The real CodeMirror editors run in
 * jsdom (the editor suite does the same); the network is a fetch stub keyed by method and URL.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import i18next from 'i18next';
import { EditorView } from '@codemirror/view';
import type { AppearanceFile, AppearanceFileState, SpaceAppearanceResponse, SpacePublicSettingsResponse } from '@shared/contracts';
import { ToastProvider } from '../ui/Toast';

vi.mock('../auth/AuthProvider', () => ({
  useSpaceRole: () => 'admin' as const,
}));

const { SpaceSettingsPage } = await import('./SpaceSettingsPage');
await import('../i18n/register');

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BLOB_BASE = 'https://github.com/acme/repo/blob/main';

function fileState(file: AppearanceFile, content: string, etag: string | null = content ? `etag-${file}` : null): AppearanceFileState {
  return { file, path: `docs/.folio/${file}`, exists: etag !== null, etag, content, source: etag ? 'folio' : 'none', warnings: [] };
}

const SITE_JSON = '{\n  "v": 1,\n  "title": "Acme",\n  "x-custom": true\n}\n';

function appearance(overrides: Partial<SpaceAppearanceResponse> = {}): SpaceAppearanceResponse {
  return {
    files: [
      fileState('site.json', SITE_JSON),
      fileState('site.css', 'body { color: red }'),
      fileState('export.css', ''),
      fileState('pdf-header.html', ''),
      fileState('pdf-footer.html', ''),
    ],
    assets: [{ name: 'logo.png', size: 2048, url: '/api/public/spaces/docs/site-assets/logo.png' }],
    contentRoot: 'docs',
    repoFileBaseUrl: BLOB_BASE,
    legacyPending: false,
    isPublic: false,
    ...overrides,
  };
}

const PUBLIC_SETTINGS: SpacePublicSettingsResponse = {
  visibility: 'public',
  settings: { subdomain: null, domain: null, allowDownload: false, allowAssistant: false, indexing: true, primaryHost: 'auto' },
  urls: { path: 'https://folio.example.com/public/docs', subdomain: null, domain: null },
  sitesDomain: null,
  mainHost: 'folio.example.com',
};

interface Stub {
  puts: () => Array<{ changes: Array<{ file: string; content: string; etag: string | null }> }>;
}

/** `put` decides the PUT answer; the rest is fixed. */
function stubApi(state: SpaceAppearanceResponse, put?: () => { status: number; body: unknown }): Stub {
  const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const reply = (status: number, body: unknown) =>
      Promise.resolve({ ok: status >= 200 && status < 300, status, statusText: '', json: () => Promise.resolve(body) });
    if (url === '/api/spaces') return reply(200, { spaces: [{ slug: 'docs', name: 'Docs Space', pageCount: 3, visibility: 'public', myRole: 'admin' }] });
    if (url === '/api/spaces/docs/appearance' && method === 'GET') return reply(200, state);
    if (url === '/api/spaces/docs/appearance' && method === 'PUT') return put ? (({ status, body }) => reply(status, body))(put()) : reply(200, state);
    if (url === '/api/spaces/docs/public-settings') return reply(200, PUBLIC_SETTINGS);
    if (url === '/api/spaces/docs/tree') return reply(200, { tree: [] });
    return reply(500, { error: `unexpected ${method} ${url}` });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    puts: () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT').map(([, init]) => JSON.parse(String((init as RequestInit).body))),
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}

function renderPage(initialPath = '/s/docs/settings') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/s/:space/settings" element={<SpaceSettingsPage />} />
          </Routes>
          <LocationProbe />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });

describe('SpaceSettingsPage', () => {
  it('has the three tabs and shows every file with its path in the repository and a link to it', async () => {
    stubApi(appearance());
    renderPage();

    expect(screen.getByRole('heading', { name: 'Site & PDF settings' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Site', 'Site appearance', 'PDF']);

    // Site: the publication block (stored in Folio) and the site.json badge with its "Open in repository" link.
    expect(await screen.findByText('Stored in Folio, not in git')).toBeTruthy();
    const siteBadge = within(await screen.findByTestId('repo-badge-site.json'));
    expect(siteBadge.getByText('docs/.folio/site.json')).toBeTruthy();
    expect(siteBadge.getByRole('link', { name: /Open in repository/ }).getAttribute('href')).toBe(`${BLOB_BASE}/docs/.folio/site.json`);
    expect((screen.getByLabelText('Site title') as HTMLInputElement).value).toBe('Acme');

    // Site appearance: the CSS in an editor, its badge, and no preview while the space is not public.
    fireEvent.click(tab('Site appearance'));
    expect(screen.getByTestId('search').textContent).toBe('?tab=appearance');
    const cssBadge = within(await screen.findByTestId('repo-badge-site.css'));
    expect(cssBadge.getByRole('link', { name: /Open in repository/ }).getAttribute('href')).toBe(`${BLOB_BASE}/docs/.folio/site.css`);
    expect(screen.getByRole('textbox', { name: 'Site stylesheet (CSS)' }).textContent).toContain('body { color: red }');
    expect(screen.getByText('Publish the space to preview the site.')).toBeTruthy();

    // PDF: three files; a file that is not in the repository yet has no link.
    fireEvent.click(tab('PDF'));
    expect(within(await screen.findByTestId('repo-badge-pdf-header.html')).getByText('docs/.folio/pdf-header.html')).toBeTruthy();
    expect(within(screen.getByTestId('repo-badge-export.css')).queryByRole('link')).toBeNull();
    expect(within(screen.getByTestId('repo-badge-export.css')).getByText(/Not in the repository yet/)).toBeTruthy();
  });

  it('saves only the Site tab\'s file, with the etag it started from, and keeps the keys it does not edit', async () => {
    const saved = appearance({ files: appearance().files.map((f) => (f.file === 'site.json' ? { ...f, etag: 'etag-new' } : f)) });
    const { puts } = stubApi(appearance(), () => ({ status: 200, body: saved }));
    renderPage();

    const title = (await screen.findByLabelText('Site title')) as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Acme Docs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(puts()).toHaveLength(1));
    const [body] = puts();
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({ file: 'site.json', etag: 'etag-site.json' });
    expect(JSON.parse(body.changes[0].content)).toEqual({ v: 1, title: 'Acme Docs', 'x-custom': true });

    expect(await screen.findByText(/Saved to docs\/\.folio\/site\.json · commit “settings: update \.folio\/site\.json”/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true));
  });

  it('shows "Changed in the repository" on a 409, keeps the draft, and reloads or diffs on request', async () => {
    const theirs = fileState('site.json', '{\n  "v": 1,\n  "title": "Acme (edited in git)"\n}\n', 'etag-theirs');
    stubApi(appearance(), () => ({ status: 409, body: { error: 'appearance file changed in the repository', ...appearance({ files: [theirs] }) } }));
    renderPage();

    const title = (await screen.findByLabelText('Site title')) as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Acme Docs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Changed in the repository')).toBeTruthy();
    expect(title.value).toBe('Acme Docs'); // the draft survives

    fireEvent.click(within(alert).getByRole('button', { name: 'Show diff' }));
    const diff = within(alert).getByLabelText('Differences');
    expect(diff.textContent).toContain('"title": "Acme (edited in git)"');
    expect(diff.textContent).toContain('"title": "Acme Docs"');

    fireEvent.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect((screen.getByLabelText('Site title') as HTMLInputElement).value).toBe('Acme (edited in git)');
  });

  it('inserts a placeholder at the cursor of the PDF header and saves it with the header file only', async () => {
    const { puts } = stubApi(appearance());
    renderPage('/s/docs/settings?tab=pdf');

    const header = await screen.findByRole('textbox', { name: 'Header' });
    const chips = within(screen.getByRole('group', { name: 'Header: placeholders' }));
    fireEvent.click(chips.getByRole('button', { name: '{{page}}' }));
    await waitFor(() => expect(header.textContent).toContain('{{page}}'));
    // The footer editor is untouched (its placeholder text is in the DOM, so ask the editor for its document).
    const footer = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Footer' }).closest('.cm-editor') as HTMLElement);
    expect(footer?.state.doc.toString()).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].changes).toEqual([{ file: 'pdf-header.html', content: '{{page}}', etag: null }]);
  });
});
