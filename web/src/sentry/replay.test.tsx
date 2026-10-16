// @vitest-environment jsdom
/**
 * Session Replay, the report dialog's "attach a recording" box, the error-screen button and Excalidraw's Help dialog
 * link. @sentry/react is mocked; the replay object records which calls the dialog makes and in which order.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import type { SentryWebConfig } from '@shared/contracts';
import { ToastProvider } from '../app/ui/Toast';
import { ErrorBoundary } from '../app/ui/ErrorBoundary';
import { PageCrashed } from '../app/routes/PageCrashed';
import { ReportProblemDialog } from '../app/feedback/ReportProblemDialog';
import { ReportProblemHost, requestReportProblem } from '../app/feedback/reportProblem';
import { interceptHelpDialogClick } from '../diagrams/helpDialogLinks';
import { __resetSentryForTests, initSentry, replayOptions } from '.';
import '../app/i18n/register';

const calls: string[] = [];
const replay = vi.hoisted(() => ({
  mode: 'buffer' as 'buffer' | 'session' | undefined,
  flush: vi.fn(),
  stop: vi.fn(),
  startBuffering: vi.fn(),
  getRecordingMode: vi.fn(),
}));
const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  addEventProcessor: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(() => 'crash-evt-1'),
  captureFeedback: vi.fn(() => 'feedback-id'),
  lastEventId: vi.fn(() => 'evt-last'),
  flush: vi.fn(() => Promise.resolve(true)),
  breadcrumbsIntegration: vi.fn(() => ({ name: 'Breadcrumbs' })),
  browserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing' })),
  replayIntegration: vi.fn((o: unknown) => ({ name: 'Replay', options: o })),
  getReplay: vi.fn(),
}));
vi.mock('@sentry/react', () => sdk);

const BASE: SentryWebConfig = { dsn: 'https://k@o1.ingest.de.sentry.io/1', environment: 'test', tracesSampleRate: 0.1 };
const WITH_REPLAY: SentryWebConfig = { ...BASE, replay: { enabled: true, sessionSampleRate: 0.1, onErrorSampleRate: 1 } };

beforeEach(async () => {
  __resetSentryForTests();
  vi.clearAllMocks();
  calls.length = 0;
  replay.mode = 'buffer';
  replay.getRecordingMode.mockImplementation(() => replay.mode);
  replay.flush.mockImplementation(async () => {
    calls.push('flush');
    replay.mode = 'session';
  });
  replay.stop.mockImplementation(async () => {
    calls.push('stop');
    replay.mode = undefined;
  });
  replay.startBuffering.mockImplementation(() => {
    calls.push('startBuffering');
    replay.mode = 'buffer';
  });
  sdk.getReplay.mockReturnValue(replay);
  sdk.captureFeedback.mockImplementation(() => {
    calls.push('captureFeedback');
    return 'feedback-id';
  });
  await i18next.changeLanguage('en');
});
afterEach(() => cleanup());

function wrap(ui: React.ReactNode, path = '/s/eng/p/01HPAGE') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function start(config: SentryWebConfig) {
  initSentry(config);
  await waitFor(() => expect(sdk.init).toHaveBeenCalled());
  await waitFor(() => expect(sdk.addEventProcessor).toHaveBeenCalled());
}

async function send(text = 'broken') {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(sdk.captureFeedback).toHaveBeenCalled());
}

describe('replay configuration', () => {
  it('is not set up without the replay config from the server (SENTRY_REPLAY=0 or an older server)', async () => {
    await start(BASE);
    expect(sdk.replayIntegration).not.toHaveBeenCalled();
    const opts = sdk.init.mock.calls[0]![0] as Record<string, any>;
    expect(opts.replaysSessionSampleRate).toBe(0);
    expect(opts.replaysOnErrorSampleRate).toBe(0);
    const names = (opts.integrations([]) as Array<{ name: string }>).map((i) => i.name);
    expect(names).not.toContain('Replay');
  });

  it('is off when the server says enabled: false', async () => {
    await start({ ...BASE, replay: { enabled: false, sessionSampleRate: 0.5, onErrorSampleRate: 1 } });
    expect(sdk.replayIntegration).not.toHaveBeenCalled();
    expect((sdk.init.mock.calls[0]![0] as Record<string, any>).replaysSessionSampleRate).toBe(0);
  });

  it('records into the in-memory buffer by default and a sampled share of whole sessions when asked', async () => {
    await start({ ...BASE, replay: { enabled: true, sessionSampleRate: 0, onErrorSampleRate: 1 } });
    let opts = sdk.init.mock.calls[0]![0] as Record<string, any>;
    expect(opts.replaysSessionSampleRate).toBe(0);
    expect(opts.replaysOnErrorSampleRate).toBe(1);
    __resetSentryForTests();
    sdk.init.mockClear();
    await start(WITH_REPLAY);
    opts = sdk.init.mock.calls[0]![0] as Record<string, any>;
    expect(opts.replaysSessionSampleRate).toBe(0.1);
    expect(opts.replaysOnErrorSampleRate).toBe(1);
    const names = (opts.integrations([]) as Array<{ name: string }>).map((i) => i.name);
    expect(names).toContain('Replay');
  });

  it('masks all text, inputs and media, blocks canvases and iframes and records no network bodies or headers', async () => {
    await start(WITH_REPLAY);
    (sdk.init.mock.calls[0]![0] as Record<string, any>).integrations([]);
    const given = sdk.replayIntegration.mock.calls[0]![0] as ReturnType<typeof replayOptions>;
    expect(given).toEqual(replayOptions());
    expect(given).toMatchObject({ maskAllText: true, maskAllInputs: true, blockAllMedia: true, networkDetailAllowUrls: [], networkCaptureBodies: false });
    expect(given.block).toEqual(expect.arrayContaining(['canvas', 'iframe']));
    expect(given.unmask).toEqual(['.sentry-unmask']);
  });

  it('keeps click breadcrumbs and drops console and input ones', async () => {
    await start(WITH_REPLAY);
    (sdk.init.mock.calls[0]![0] as Record<string, any>).integrations([]);
    expect(sdk.breadcrumbsIntegration).toHaveBeenCalledWith({ dom: true });
    const opts = sdk.init.mock.calls[0]![0] as Record<string, any>;
    expect(opts.beforeBreadcrumb({ category: 'ui.input', message: 'typed' })).toBeNull();
    expect(opts.beforeBreadcrumb({ category: 'console', message: 'log' })).toBeNull();
    expect(opts.beforeBreadcrumb({ category: 'ui.click', message: 'button[aria-label="Q3 plan"]', data: { text: 'Q3 plan' } })).toEqual({
      category: 'ui.click',
      message: 'button[aria-label]',
    });
  });
});

describe('the "attach a recording" box', () => {
  it('is not shown without replay', async () => {
    await start(BASE);
    wrap(<ReportProblemDialog onClose={() => {}} />);
    expect(screen.queryByLabelText('Attach a recording of recent actions (text hidden)')).toBeNull();
  });

  it('is ticked by default, explains what is recorded, and sends the buffered recording before the report', async () => {
    await start(WITH_REPLAY);
    wrap(<ReportProblemDialog onClose={() => {}} />);
    const box = screen.getByLabelText('Attach a recording of recent actions (text hidden)') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'What is recorded?' }));
    expect(screen.getByRole('note').textContent).toMatch(/replaced by placeholders/);
    await send();
    // Sent in full first, then back to an in-memory buffer: a report does not start recording the rest of the visit.
    await waitFor(() => expect(calls).toEqual(['flush', 'captureFeedback', 'stop', 'startBuffering']));
    expect(replay.stop).toHaveBeenCalledWith();
  });

  it('unticked: nothing is flushed, the buffer is paused only while the report goes out, then recording resumes', async () => {
    await start(WITH_REPLAY);
    wrap(<ReportProblemDialog onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('Attach a recording of recent actions (text hidden)'));
    await send();
    await waitFor(() => expect(calls).toEqual(['stop', 'captureFeedback', 'startBuffering']));
    expect(replay.flush).not.toHaveBeenCalled();
    expect(replay.stop).toHaveBeenCalledWith({ flush: false });
    expect(sdk.flush).toHaveBeenCalled();
  });

  it('a session that is being recorded anyway is left alone: the report links to it either way', async () => {
    replay.mode = 'session';
    await start(WITH_REPLAY);
    wrap(<ReportProblemDialog onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('Attach a recording of recent actions (text hidden)'));
    await send();
    expect(calls).toEqual(['captureFeedback']);
  });
});

describe('error screens', () => {
  it('the boundary hands the Sentry event id to its fallback and the button opens the dialog with it', async () => {
    await start(BASE);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Boom = () => {
      throw new Error('render failed');
    };
    wrap(
      <>
        <ReportProblemHost />
        <ErrorBoundary fallback={(_e, reset, eventId) => <PageCrashed onRetry={reset} eventId={eventId} />}>
          <Boom />
        </ErrorBoundary>
      </>,
    );
    expect(await screen.findByText('This page could not be shown.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Report a problem' }));
    expect(await screen.findByRole('dialog', { name: 'Report a problem' })).toBeTruthy();
    expect(screen.getByText('The report is linked to the error you just saw.')).toBeTruthy();
    await send('white screen');
    const [params] = sdk.captureFeedback.mock.calls[0] as unknown as [Record<string, any>];
    expect(params.associatedEventId).toBe('crash-evt-1');
  });

  it('has no report button while error reporting is off', () => {
    wrap(<PageCrashed onRetry={() => {}} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Report a problem' })).toBeNull();
  });
});

describe("Excalidraw's Help dialog", () => {
  function HelpFixture({ onNavigate }: { onNavigate: (href: string) => void }) {
    return (
      <div onClickCapture={(e) => void interceptHelpDialogClick(e, () => calls.push('closeHelp'))}>
        <div className="HelpDialog">
          <div className="HelpDialog__header">
            {['https://docs.excalidraw.com', 'https://plus.excalidraw.com/blog', 'https://github.com/excalidraw/excalidraw/issues', 'https://youtube.com/@excalidraw'].map((href) => (
              <a
                key={href}
                className="HelpDialog__btn"
                href={href}
                onClick={(e) => {
                  if (!e.defaultPrevented) {
                    e.preventDefault(); // jsdom cannot navigate; this records where it would have gone
                    onNavigate(href);
                  }
                }}
              >
                {href}
              </a>
            ))}
          </div>
        </div>
      </div>
    );
  }

  it('the issue link opens our report dialog, closes the help dialog and never navigates', async () => {
    await start(BASE);
    const navigate = vi.fn();
    wrap(
      <>
        <ReportProblemHost />
        <HelpFixture onNavigate={navigate} />
      </>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'https://github.com/excalidraw/excalidraw/issues' }));
    expect(await screen.findByRole('dialog', { name: 'Report a problem' })).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    expect(calls).toContain('closeHelp');
  });

  it('with error reporting off the issue link goes nowhere (and opens nothing)', () => {
    const navigate = vi.fn();
    wrap(
      <>
        <ReportProblemHost />
        <HelpFixture onNavigate={navigate} />
      </>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'https://github.com/excalidraw/excalidraw/issues' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(requestReportProblem()).toBe(false);
  });

  it('other links (the documentation) are left alone', async () => {
    await start(BASE);
    const navigate = vi.fn();
    wrap(<HelpFixture onNavigate={navigate} />);
    fireEvent.click(screen.getByRole('link', { name: 'https://docs.excalidraw.com' }));
    expect(navigate).toHaveBeenCalledWith('https://docs.excalidraw.com');
  });

  it('the stylesheet hides the blog and YouTube links, and the issue link unless reporting is on', async () => {
    const css = readFileSync(resolve(process.cwd(), 'web/src/styles.css'), 'utf8');
    expect(css).toMatch(/\.HelpDialog__btn\[href\*='plus\.excalidraw\.com'\][^{]*\{\s*display: none/s);
    expect(css).toMatch(/youtube\.com\/@excalidraw/);
    expect(css).toMatch(/html:not\(\[data-folio-report='on'\]\) \.HelpDialog__btn\[href\*='github\.com\/excalidraw\/excalidraw\/issues'\]/);
    expect(document.documentElement.dataset.folioReport).toBeUndefined();
    await start(BASE);
    expect(document.documentElement.dataset.folioReport).toBe('on');
  });
});
