// @vitest-environment jsdom
/**
 * The "Publish as website" dialog: the subdomain field exists only where the operator configured
 * a sites domain, the custom-domain hint names the host a CNAME should point to, the options are
 * only editable once the space is public, publishing is confirmed with the plain-language
 * warning, and the server's 409s come back as sentences.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { SpacePublicSettingsResponse, SpaceVisibility } from '@shared/contracts';
import { ToastProvider } from '../ui/Toast';
import { PublishSpaceDialog } from './PublishSpaceDialog';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function settings(overrides: Partial<SpacePublicSettingsResponse> = {}, visibility: SpaceVisibility = 'public'): SpacePublicSettingsResponse {
  return {
    visibility,
    settings: { subdomain: null, domain: null, allowDownload: false, allowAssistant: false },
    urls: { path: 'https://folio.example.com/public/docs', subdomain: null, domain: null },
    sitesDomain: 'sites.example.com',
    mainHost: 'folio.example.com',
    ...overrides,
  };
}

interface Stub {
  fetchMock: ReturnType<typeof vi.fn>;
  puts: () => unknown[];
  patches: () => unknown[];
}

/** `put` decides the PUT answer; everything else is fixed. The access matrix 403s, as it does for a space admin who is not an instance admin. */
function stubApi(response: SpacePublicSettingsResponse, put?: () => { status: number; body: unknown }): Stub {
  const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const reply = (status: number, body: unknown) =>
      Promise.resolve({ ok: status >= 200 && status < 300, status, statusText: '', json: () => Promise.resolve(body) });
    if (url === '/api/spaces') return reply(200, { spaces: [{ slug: 'docs', name: 'Docs', pageCount: 3, visibility: response.visibility }] });
    if (url === '/api/spaces/docs/public-settings' && method === 'GET') return reply(200, response);
    if (url === '/api/spaces/docs/public-settings' && method === 'PUT') {
      const outcome = put?.() ?? { status: 200, body: response };
      return reply(outcome.status, outcome.body);
    }
    if (url === '/api/spaces/docs' && method === 'PATCH') return reply(200, { slug: 'docs', visibility: 'public' });
    if (url === '/api/access/matrix') return reply(403, { error: 'requires instance admin' });
    return reply(500, { error: `unexpected ${method} ${url}` });
  });
  vi.stubGlobal('fetch', fetchMock);
  const bodiesOf = (method: string) =>
    fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method).map(([, init]) => JSON.parse(String((init as RequestInit).body)));
  return { fetchMock, puts: () => bodiesOf('PUT'), patches: () => bodiesOf('PATCH') };
}

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <PublishSpaceDialog space="docs" onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('PublishSpaceDialog', () => {
  it('shows the subdomain field only when the instance has a sites domain', async () => {
    stubApi(settings({ sitesDomain: 'sites.example.com' }));
    const { unmount } = renderDialog();
    expect(await screen.findByLabelText('Subdomain')).toBeTruthy();
    expect(screen.getByText('.sites.example.com')).toBeTruthy();
    unmount();

    stubApi(settings({ sitesDomain: null }));
    renderDialog();
    await screen.findByLabelText('Custom domain');
    expect(screen.queryByLabelText('Subdomain')).toBeNull();
  });

  it('tells the admin what to do for a custom domain, naming the main host', async () => {
    stubApi(settings());
    renderDialog();
    expect(
      await screen.findByText('Point a CNAME to folio.example.com and route the host to Folio in your reverse proxy'),
    ).toBeTruthy();
  });

  it('shows the site address with a Copy button', async () => {
    stubApi(settings());
    renderDialog();
    const field = (await screen.findByLabelText('Address on this Folio')) as HTMLInputElement;
    expect(field.value).toBe('https://folio.example.com/public/docs');
    expect(screen.getByRole('button', { name: /Copy: https:\/\/folio\.example\.com\/public\/docs/ })).toBeTruthy();
  });

  it('keeps the site options switched off until the space is public', async () => {
    stubApi(settings({}, 'instance'));
    renderDialog();
    await screen.findByText('Make the space public to turn the website on.');
    expect((screen.getByLabelText('Custom domain') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Allow visitors to download pages/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks for confirmation before publishing, in plain words, then PATCHes the visibility', async () => {
    const { patches } = stubApi(settings({}, 'private'));
    renderDialog();
    fireEvent.click(await screen.findByRole('radio', { name: /Public/ }));

    expect(await screen.findByText('Anyone on the internet will be able to read this space without signing in. Restricted pages and .agent rules stay hidden.')).toBeTruthy();
    expect(patches()).toHaveLength(0); // nothing is sent before the confirmation

    fireEvent.click(screen.getByRole('button', { name: 'Make public' }));
    await waitFor(() => expect(patches()).toEqual([{ visibility: 'public' }]));
  });

  it('saves the options with one PUT, normalizing a pasted URL to its host', async () => {
    const { puts } = stubApi(settings());
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Subdomain'), { target: { value: 'My-Docs' } });
    fireEvent.change(screen.getByLabelText('Custom domain'), { target: { value: 'https://Docs.Example.com/start' } });
    fireEvent.click(screen.getByLabelText(/Allow visitors to download pages/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual({ subdomain: 'my-docs', domain: 'docs.example.com', allowDownload: true, allowAssistant: false });
  });

  it('refuses an invalid subdomain before sending anything', async () => {
    const { puts } = stubApi(settings());
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Subdomain'), { target: { value: '-bad-' } });
    expect(screen.getByText('Lowercase letters, digits and hyphens (not at the start or the end).')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(puts()).toHaveLength(0);
  });

  it('turns the server\'s 409 into a sentence', async () => {
    stubApi(settings(), () => ({ status: 409, body: { error: 'subdomain is already taken' } }));
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Subdomain'), { target: { value: 'taken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect((await screen.findByRole('alert')).textContent).toBe('This subdomain is already taken — pick another one.');
  });
});
