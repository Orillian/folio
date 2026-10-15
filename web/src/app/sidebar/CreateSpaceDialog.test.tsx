// @vitest-environment jsdom
/**
 * Round 19 (#6-ux): pins the git tab's new field order and its core new
 * behavior — picking a repository from the combobox auto-suggests "Name"
 * (humanized from the repo's own name), and a manual edit of Name always
 * wins over any later reselect (same touched-flag contract as the
 * pre-existing repoUrl/rootPath fields — see CreateSpaceDialog.tsx's own
 * nameTouched comment). Not attempting full coverage of every field here —
 * gitRepos.test.ts and gitBranches.test.ts already cover the pure
 * filter/humanize logic in isolation; this is specifically the wiring.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { CreateSpaceDialog } from './CreateSpaceDialog';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function stubApi(opts: { vault?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/me/git-credentials')) {
      return jsonResponse({
        credentials: [{ id: 'cred1', host: 'github.com', provider: 'github', label: 'Work', createdAt: '2026-01-01T00:00:00Z' }],
      });
    }
    if (url.startsWith('/api/config')) return jsonResponse({ defaultRepoUrl: null });
    if (url.startsWith('/api/git/repos')) {
      return jsonResponse({
        provider: 'github',
        host: 'github.com',
        repos: [
          { name: 'architecture-docs', url: 'https://github.com/acme/architecture-docs.git', defaultBranch: 'main' },
          { name: 'onboarding-guide', url: 'https://github.com/acme/onboarding-guide.git', defaultBranch: 'main' },
        ],
      });
    }
    if (url.startsWith('/api/git/branches')) return jsonResponse({ branches: ['main'], defaultBranch: 'main', empty: false });
    if (url.startsWith('/api/git/tree')) {
      // Not under test unless a vault is asked for — otherwise it degrades silently, as when the endpoint is unavailable.
      return opts.vault ? jsonResponse({ dirs: ['.obsidian', 'Notes'], vault: true }) : jsonResponse({}, 404);
    }
    if (url === '/api/spaces' && _init?.method === 'POST') return jsonResponse({ slug: 'new-space', name: 'New', pageCount: 0 }, 201);
    return jsonResponse({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <CreateSpaceDialog onClose={vi.fn()} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function openGitTab() {
  fireEvent.click(screen.getByRole('tab', { name: 'From a git repository' }));
  // Repository combobox is the first field once the credential exists —
  // wait for its (auto-fetched) suggestions before interacting.
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Repository' })).toBeTruthy());
}

describe('CreateSpaceDialog — git tab reorder + name auto-fill (Round 19 #6-ux)', () => {
  it('auto-fills Name (humanized) from the repository picked in the combobox', async () => {
    stubApi();
    renderDialog();
    await openGitTab();

    const repoInput = screen.getByRole('combobox', { name: 'Repository' });
    fireEvent.focus(repoInput);
    const option = await screen.findByRole('option', { name: 'architecture-docs' });
    fireEvent.click(option);

    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    await waitFor(() => expect(nameInput.value).toBe('Architecture Docs'));
    expect(repoInput).toHaveProperty('value', 'https://github.com/acme/architecture-docs.git');
  });

  it('never overwrites a manually-edited Name on a later repository reselect', async () => {
    stubApi();
    renderDialog();
    await openGitTab();

    const repoInput = screen.getByRole('combobox', { name: 'Repository' });
    fireEvent.focus(repoInput);
    fireEvent.click(await screen.findByRole('option', { name: 'architecture-docs' }));

    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    await waitFor(() => expect(nameInput.value).toBe('Architecture Docs'));

    // The user takes over — this must stick no matter what gets picked next.
    fireEvent.change(nameInput, { target: { value: 'Custom Space Name' } });
    expect(nameInput.value).toBe('Custom Space Name');

    fireEvent.focus(repoInput);
    fireEvent.click(await screen.findByRole('option', { name: 'onboarding-guide' }));

    // Give the reselect's effects a tick, then assert the manual value held.
    await waitFor(() => expect(repoInput).toHaveProperty('value', 'https://github.com/acme/onboarding-guide.git'));
    expect(nameInput.value).toBe('Custom Space Name');
  });

  it('repository is the first field in the git tab, ahead of Name', () => {
    stubApi();
    renderDialog();
    fireEvent.click(screen.getByRole('tab', { name: 'From a git repository' }));

    const labels = screen.getAllByText(/^(Repository|Name)$/).map((el) => el.textContent);
    const repoIndex = labels.indexOf('Repository');
    const nameIndex = labels.indexOf('Name');
    expect(repoIndex).toBeGreaterThanOrEqual(0);
    expect(nameIndex).toBeGreaterThan(repoIndex);
  });
});

/**
 * QA-3 P2 #4 (risk to someone else's repository): "Root path inside the
 * repository" used to auto-fill with the slug of the space name, so
 * connecting a ready-made docs repo defaulted the content root to a folder
 * that repo does not have. server/storage.ts's createSpaceFromRepo then
 * creates that folder, writes a starter index.md, commits and PUSHES it into
 * the user's repository — and the new space shows none of the repo's actual
 * content, because none of it lives under the invented root.
 */
describe('CreateSpaceDialog — rootPath defaults to the repository root', () => {
  it('leaves rootPath empty no matter what the space is named', async () => {
    stubApi();
    renderDialog();
    await openGitTab();

    const rootPathInput = screen.getByLabelText('Root path inside the repository') as HTMLInputElement;
    expect(rootPathInput.value).toBe('');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Product documentation' } });
    // The old behaviour filled this with "product-documentation" right here.
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Product documentation'));
    expect(rootPathInput.value).toBe('');
  });

  it('picking a repository does not fill rootPath either', async () => {
    stubApi();
    renderDialog();
    await openGitTab();

    const repoInput = screen.getByRole('combobox', { name: 'Repository' });
    fireEvent.focus(repoInput);
    fireEvent.click(await screen.findByRole('option', { name: 'architecture-docs' }));
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Architecture Docs'));

    expect((screen.getByLabelText('Root path inside the repository') as HTMLInputElement).value).toBe('');
  });

  it('sends an empty rootPath to POST /api/spaces', async () => {
    const fetchMock = stubApi();
    renderDialog();
    await openGitTab();

    fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), {
      target: { value: 'https://github.com/acme/architecture-docs.git' },
    });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Architecture' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/spaces')).toBe(true));
    const call = fetchMock.mock.calls.find(([input]) => String(input) === '/api/spaces')!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.rootPath).toBe('');
  });

  it('still lets the user set a subfolder by hand', async () => {
    stubApi();
    renderDialog();
    await openGitTab();

    const rootPathInput = screen.getByLabelText('Root path inside the repository') as HTMLInputElement;
    fireEvent.change(rootPathInput, { target: { value: 'docs' } });
    expect(rootPathInput.value).toBe('docs');

    // And a later name edit must not clobber that choice.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Something else' } });
    expect(rootPathInput.value).toBe('docs');
  });
});

/**
 * Obsidian vault compatibility (wave 1a): a repository whose chosen folder holds
 * `.obsidian/` is announced, light footprint is on by default for it, and the
 * checkbox is a manual choice that always wins once touched.
 */
describe('CreateSpaceDialog — Obsidian vault note and light footprint', () => {
  const NOTE = /Obsidian vault detected: Folio keeps ids out of your files and ignores \.obsidian\/ and \.trash\//;

  async function typeRepo() {
    fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), { target: { value: 'https://github.com/acme/vault.git' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My vault' } });
  }
  function postedBody(fetchMock: ReturnType<typeof stubApi>) {
    const call = fetchMock.mock.calls.find(([input, init]) => String(input) === '/api/spaces' && (init as RequestInit | undefined)?.method === 'POST')!;
    return JSON.parse((call[1] as RequestInit).body as string);
  }

  it('shows the note, ticks light footprint by default, and leaves the choice to the server while untouched', async () => {
    const fetchMock = stubApi({ vault: true });
    renderDialog();
    await openGitTab();
    await typeRepo();

    expect(await screen.findByText(NOTE, undefined, { timeout: 4000 })).toBeTruthy();
    const light = screen.getByRole('checkbox', { name: /Light footprint/ }) as HTMLInputElement;
    expect(light.checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === '/api/spaces' && (init as RequestInit)?.method === 'POST')).toBe(true));
    expect(postedBody(fetchMock).lightFootprint).toBeUndefined();
  });

  it('a manual untick is sent as an explicit false', async () => {
    const fetchMock = stubApi({ vault: true });
    renderDialog();
    await openGitTab();
    await typeRepo();
    await screen.findByText(NOTE, undefined, { timeout: 4000 });

    fireEvent.click(screen.getByRole('checkbox', { name: /Light footprint/ }));
    expect((screen.getByRole('checkbox', { name: /Light footprint/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === '/api/spaces' && (init as RequestInit)?.method === 'POST')).toBe(true));
    expect(postedBody(fetchMock).lightFootprint).toBe(false);
  });

  it('no vault: no note, the box is still on (the server keeps ids out of a repository\'s own files), untouched is left to the server, unticking sends false', async () => {
    const fetchMock = stubApi();
    renderDialog();
    await openGitTab();
    await typeRepo();

    const light = screen.getByRole('checkbox', { name: /Light footprint/ }) as HTMLInputElement;
    expect(light.checked).toBe(true);
    expect(screen.queryByText(NOTE)).toBeNull();
    fireEvent.click(light);
    expect(light.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === '/api/spaces' && (init as RequestInit)?.method === 'POST')).toBe(true));
    expect(postedBody(fetchMock).lightFootprint).toBe(false);
  });

  it('a sub-folder space is always light: the box is ticked and locked', async () => {
    stubApi();
    renderDialog();
    await openGitTab();
    fireEvent.change(screen.getByLabelText('Root path inside the repository'), { target: { value: 'docs' } });
    const light = screen.getByRole('checkbox', { name: /Light footprint/ }) as HTMLInputElement;
    expect(light.checked).toBe(true);
    expect(light.disabled).toBe(true);
  });
});
