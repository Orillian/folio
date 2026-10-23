// @vitest-environment jsdom
/**
 * Error reporting in the browser: inert without a DSN from the server; with one it starts @sentry/react, offers
 * "Report a problem" and sends feedback with the page context and the id of the last error event. @sentry/react is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import type { SentryWebConfig, User } from '@shared/contracts';
import { SettingsProvider } from '../app/settings';
import { ToastProvider } from '../app/ui/Toast';
import { AuthProvider } from '../app/auth/AuthProvider';
import { UserMenu } from '../app/auth/UserMenu';
import { ReportProblemDialog } from '../app/feedback/ReportProblemDialog';
import { ErrorBoundary } from '../app/ui/ErrorBoundary';
import { SentryHost } from './SentryHost';
import { __resetSentryForTests, browserName, captureError, describePath, initSentry, isSentryEnabled, lastSentryEventId, sendFeedback } from '.';
import '../app/i18n/register';

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  addEventProcessor: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(),
  captureFeedback: vi.fn(() => 'feedback-id'),
  lastEventId: vi.fn(() => 'evt-123'),
  breadcrumbsIntegration: vi.fn(() => ({ name: 'Breadcrumbs' })),
  browserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing' })),
}));
vi.mock('@sentry/react', () => sdk);
// The capture itself needs a real browser; the dialog is tested with a stand-in canvas and a stand-in encoder.
const shot = vi.hoisted(() => ({ capture: vi.fn(), encode: vi.fn() }));
vi.mock('../app/feedback/pageShot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../app/feedback/pageShot')>()),
  captureViewport: shot.capture,
  canvasToImageFile: shot.encode,
}));

const CONFIG: SentryWebConfig = { dsn: 'https://k@o1.ingest.de.sentry.io/1', environment: 'test', release: 'abc1234', tracesSampleRate: 0.1 };
const USER: User = { id: 'u1', email: 'ann@folio.local', name: 'Anna Lee', isAdmin: false, createdAt: '2024-01-01T00:00:00.000Z', username: 'ann' };

beforeEach(async () => {
  __resetSentryForTests();
  vi.clearAllMocks();
  sdk.lastEventId.mockReturnValue('evt-123');
  await i18next.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

function stubFetch(sentry?: SentryWebConfig) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url === '/api/auth/state') return Promise.resolve(jsonResponse({ needsSetup: false, user: USER, memberships: {}, google: false, ...(sentry ? { sentry } : {}) }));
      if (url === '/api/me/stars') return Promise.resolve(jsonResponse({ spaces: [], pages: [], emojis: [] }));
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'x' }) });
    }),
  );
}

function wrap(ui: React.ReactNode, path = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <SettingsProvider>
          <ToastProvider>{ui}</ToastProvider>
        </SettingsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('initSentry', () => {
  it('does not load or start anything without a DSN', async () => {
    initSentry(undefined);
    initSentry({ ...CONFIG, dsn: '' });
    await Promise.resolve();
    expect(isSentryEnabled()).toBe(false);
    expect(sdk.init).not.toHaveBeenCalled();
    captureError(new Error('x'));
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it('starts once with the server config, no replay, and scrubs events and breadcrumbs', async () => {
    initSentry(CONFIG);
    initSentry(CONFIG);
    await waitFor(() => expect(sdk.init).toHaveBeenCalledTimes(1));
    const opts = sdk.init.mock.calls[0]![0] as Record<string, any>;
    expect(opts).toMatchObject({ dsn: CONFIG.dsn, environment: 'test', release: 'abc1234', tracesSampleRate: 0.1 });
    const names = (opts.integrations([{ name: 'BrowserSession' }, { name: 'Breadcrumbs' }, { name: 'Dedupe' }]) as Array<{ name: string }>).map((i) => i.name);
    expect(names).toEqual(['Dedupe', 'Breadcrumbs', 'BrowserTracing']); // no replay, no feedback widget, no session pings
    expect(opts.dataCollection).toMatchObject({ cookies: false, userInfo: false, urlQueryParams: false });
    const cleaned = opts.beforeSend({ request: { url: 'https://h/share/TOKEN?share=TOKEN', cookies: { a: 'b' }, headers: { authorization: 'x' } }, user: { id: 'u1', email: 'a@b.c' } });
    expect(JSON.stringify(cleaned)).not.toMatch(/TOKEN|a@b\.c|authorization/);
    expect(opts.beforeBreadcrumb({ category: 'console' })).toBeNull();
    expect(opts.beforeBreadcrumb({ category: 'fetch', data: { url: '/api/x?share=T' } }).data.url).toBe('/api/x');
  });

  it('reports errors an error boundary caught', async () => {
    initSentry(CONFIG);
    await waitFor(() => expect(sdk.init).toHaveBeenCalled());
    await waitFor(() => expect(sdk.addEventProcessor).toHaveBeenCalled());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Boom = () => {
      throw new Error('render failed');
    };
    render(
      <ErrorBoundary fallback={() => <p>crashed</p>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('crashed')).toBeTruthy();
    expect(sdk.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'render failed' }));
  });
});

describe('SentryHost', () => {
  it('stays off when the server sends no sentry config', async () => {
    stubFetch(undefined);
    wrap(<SentryHost />);
    await waitFor(() => expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0));
    await Promise.resolve();
    expect(sdk.init).not.toHaveBeenCalled();
    expect(isSentryEnabled()).toBe(false);
  });

  it('starts from the auth state and tags the user by id only', async () => {
    stubFetch(CONFIG);
    wrap(<SentryHost />);
    await waitFor(() => expect(sdk.init).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sdk.setUser).toHaveBeenCalledWith({ id: 'u1' }));
  });
});

describe('the user menu', () => {
  async function openMenu() {
    fireEvent.click(await screen.findByRole('button', { name: 'User menu' }));
    await screen.findByRole('menuitem', { name: 'Settings' });
  }
  const menu = () =>
    wrap(
      <AuthProvider>
        <UserMenu />
      </AuthProvider>,
    );

  it('has no "Report a problem" without a DSN', async () => {
    stubFetch(undefined);
    menu();
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Report a problem' })).toBeNull();
  });

  it('offers it when error reporting is on, and opens the dialog', async () => {
    stubFetch(CONFIG);
    initSentry(CONFIG);
    menu();
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Report a problem' }));
    expect(await screen.findByRole('dialog', { name: 'Report a problem' })).toBeTruthy();
  });
});

describe('the report dialog', () => {
  it('sends the message with the page path (no query), page id and kind, release and the last error event id; then thanks', async () => {
    initSentry(CONFIG);
    await waitFor(() => expect(sdk.init).toHaveBeenCalled());
    const onClose = vi.fn();
    wrap(<ReportProblemDialog onClose={onClose} />, '/s/eng/p/01HPAGE?share=SECRET&q=words');
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true); // a message is required
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  The table does not save  ' } });
    fireEvent.click(send);
    await waitFor(() => expect(sdk.captureFeedback).toHaveBeenCalledTimes(1));
    const [params, hint] = sdk.captureFeedback.mock.calls[0] as unknown as [Record<string, any>, unknown];
    expect(params).toMatchObject({
      message: 'The table does not save',
      associatedEventId: 'evt-123',
      source: 'folio-report-problem',
      tags: { page_kind: 'page', page_id: '01HPAGE', space: 'eng', release: 'abc1234' },
    });
    expect(params.url).toMatch(/\/s\/eng\/p\/01HPAGE$/);
    expect(JSON.stringify(params)).not.toMatch(/SECRET|words/);
    expect(params).not.toHaveProperty('email');
    expect(params).not.toHaveProperty('name');
    expect(hint).toBeUndefined();
    expect(await screen.findByText('Thank you, the report was sent.')).toBeTruthy();
    expect(onClose).toHaveBeenCalled();
  });

  it('attaches a picked image as an attachment', async () => {
    initSentry(CONFIG);
    await waitFor(() => expect(sdk.init).toHaveBeenCalled());
    wrap(<ReportProblemDialog onClose={() => {}} />, '/s/eng');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'broken' } });
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('feedback-file'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sdk.captureFeedback).toHaveBeenCalled());
    const hint = (sdk.captureFeedback.mock.calls[0] as unknown as [unknown, { attachments: Array<{ filename: string; contentType: string; data: Uint8Array }> }])[1];
    expect(hint.attachments).toHaveLength(1);
    expect(hint.attachments[0]).toMatchObject({ filename: 'shot.png', contentType: 'image/png' });
    expect(Array.from(hint.attachments[0]!.data)).toEqual([1, 2, 3]);
  });

  it('captures the page, keeps the whole of it, and sends it like a picked screenshot', async () => {
    initSentry(CONFIG);
    await waitFor(() => expect(sdk.init).toHaveBeenCalled());
    const canvas = document.createElement('canvas');
    shot.capture.mockResolvedValueOnce(canvas);
    shot.encode.mockResolvedValueOnce(new File([new Uint8Array([9, 8, 7])], 'page-screenshot.png', { type: 'image/png' }));
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:shot', revokeObjectURL: () => {} }));
    wrap(<ReportProblemDialog onClose={() => {}} />, '/s/eng');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'looks wrong' } });
    expect(screen.getByText(/^Sent to the Folio team with the page address .* Page text is not included/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Capture page' }));
    expect(screen.queryByRole('dialog', { name: 'Report a problem' })).toBeNull(); // out of the way of the capture
    fireEvent.click(await screen.findByRole('button', { name: 'Whole page' }));

    expect(await screen.findByRole('dialog', { name: 'Report a problem' })).toBeTruthy();
    expect(shot.encode).toHaveBeenCalledWith(canvas, 5 * 1024 * 1024);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('looks wrong'); // the message survived
    expect(screen.getByText(/^The screenshot shows the page content/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Remove the screenshot' })).toBeTruthy(); // the same preview as a picked file

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sdk.captureFeedback).toHaveBeenCalled());
    const hint = (sdk.captureFeedback.mock.calls[0] as unknown as [unknown, { attachments: Array<{ filename: string; contentType: string; data: Uint8Array }> }])[1];
    expect(hint.attachments[0]).toMatchObject({ filename: 'page-screenshot.png', contentType: 'image/png' });
    expect(Array.from(hint.attachments[0]!.data)).toEqual([9, 8, 7]);
  });

  it('brings the dialog back with nothing attached when the capture is cancelled or fails', async () => {
    initSentry(CONFIG);
    await waitFor(() => expect(sdk.init).toHaveBeenCalled());
    wrap(<ReportProblemDialog onClose={() => {}} />, '/s/eng');
    shot.capture.mockResolvedValueOnce(document.createElement('canvas'));
    fireEvent.click(screen.getByRole('button', { name: 'Capture page' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('dialog', { name: 'Report a problem' })).toBeTruthy();
    expect(shot.encode).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Remove the screenshot' })).toBeNull();

    shot.capture.mockRejectedValueOnce(new Error('blocked'));
    fireEvent.click(screen.getByRole('button', { name: 'Capture page' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not capture the page/);
  });

  it('keeps the dialog open and says so when sending fails', async () => {
    initSentry(CONFIG);
    await waitFor(() => expect(sdk.init).toHaveBeenCalled());
    sdk.captureFeedback.mockImplementationOnce(() => {
      throw new Error('offline');
    });
    const onClose = vi.fn();
    wrap(<ReportProblemDialog onClose={onClose} />, '/');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'broken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('describePath keeps the path only, hides share tokens and names the kind', () => {
    expect(describePath('/s/eng/p/abc', 'board')).toEqual({ path: '/s/eng/p/abc', space: 'eng', pageId: 'abc', kind: 'board' });
    expect(describePath('/s/eng/d/a/b')).toMatchObject({ space: 'eng', kind: 'folder' });
    expect(describePath('/s/eng')).toMatchObject({ kind: 'space' });
    expect(describePath('/share/SECRET/p/1')).toEqual({ path: '/share/[token]/p/1', kind: 'share' });
    expect(describePath('/admin/access')).toMatchObject({ kind: 'admin' });
  });

  it('browserName reads a short label', () => {
    expect(browserName('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36')).toBe('Chrome 130');
    expect(browserName('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15')).toBe('Safari 17');
    expect(browserName('')).toBe('unknown');
  });

  it('sendFeedback refuses while reporting is off, so nobody is thanked for nothing', async () => {
    await expect(sendFeedback({ message: 'x', context: describePath('/') })).rejects.toThrow();
    expect(lastSentryEventId()).toBeUndefined();
  });
});
