/**
 * Optional error reporting (Sentry) and the "Report a problem" dialog. OFF unless the server hands over a DSN:
 * GET /api/auth/state carries `sentry` only when the operator set SENTRY_DSN (server/sentry.ts). Without it nothing in
 * this file loads @sentry/react or contacts anybody; `captureError` is a no-op and the dialog is not offered.
 *
 * What is sent: unhandled errors (with a scrubbed URL and a trimmed trail of requests), a trace sample, the signed-in
 * user's id, and, when a person presses "Report a problem", the message they typed, the optional screenshot they
 * attached, the page path (no query), page id and kind, the release and the browser.
 * Session Replay (unless SENTRY_REPLAY=0): a rolling in-memory recording of the last minute with ALL text, inputs and
 * media masked and canvases (board drawings) and iframes blocked, no request or response bodies or headers. It leaves
 * the browser when an error happens, in a sampled share of whole sessions (SENTRY_REPLAY_SESSION_RATE) and when the
 * person leaves "Attach a recording of recent actions" ticked in "Report a problem". Only elements carrying
 * `sentry-unmask` (fixed interface chrome such as the board-mode switch and error screens) show their text.
 * Never sent: page content or titles, search words, input values, cookies, Authorization, query strings (share
 * links and tokens ride in them), e-mail or name. The exact rules: shared/sentryScrub.ts.
 */
import type { SentryWebConfig } from '@shared/contracts';
import { scrubBreadcrumb, scrubEvent, scrubUrl } from '@shared/sentryScrub';

type SentryReact = typeof import('@sentry/react');

let sentry: SentryReact | null = null;
let loading: Promise<SentryReact | null> | null = null;
let started = false;
let release: string | undefined;
let replayOn = false;
const pendingErrors: unknown[] = [];
let currentUserId: string | null = null;

/** Whether error reporting was switched on by the server and has loaded. The dialog is offered only then. */
export function isSentryEnabled(): boolean {
  return started;
}

/** Whether a recording of recent actions exists to be attached (Session Replay is on and loaded). */
export function isReplayAvailable(): boolean {
  return replayOn;
}

/** Whether the server asked for error reporting (true as soon as init was called, before the SDK finished loading). */
export function isSentryConfigured(config: SentryWebConfig | undefined): config is SentryWebConfig {
  return Boolean(config?.dsn);
}

/** Class that shows an element's text in a recording; everything else is masked. Only fixed interface chrome gets it. */
export const REPLAY_UNMASK_CLASS = 'sentry-unmask';

/** The Session Replay privacy settings. Exported for the tests. Everything is masked unless it carries REPLAY_UNMASK_CLASS. */
export function replayOptions() {
  return {
    maskAllText: true,
    maskAllInputs: true,
    blockAllMedia: true,
    unmask: [`.${REPLAY_UNMASK_CLASS}`],
    // Board drawings are canvas pixels, PDFs and embeds are iframes; the board's text editor holds typed text.
    block: ['canvas', 'iframe', '.excalidraw-textEditorContainer', '.sentry-block'],
    maskAttributes: ['title', 'placeholder', 'alt', 'aria-label'],
    // No request or response bodies or headers, whichever URL: nothing is allow-listed.
    networkDetailAllowUrls: [] as string[],
    networkCaptureBodies: false,
  };
}

/** Whether the server switched Session Replay on (SENTRY_REPLAY). */
export function replayWanted(config: SentryWebConfig): boolean {
  return Boolean(config.replay?.enabled);
}

/** The Sentry options for a server-provided config. Exported for the tests. */
export function sentryBrowserOptions(config: SentryWebConfig) {
  return {
    dsn: config.dsn,
    environment: config.environment,
    ...(config.release ? { release: config.release } : {}),
    tracesSampleRate: config.tracesSampleRate,
    // Collect only what the scrubber (shared/sentryScrub.ts) would let through anyway.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [] as never[],
      urlQueryParams: false,
    },
    maxBreadcrumbs: 30,
    ignoreErrors: [/ResizeObserver loop/i, /AbortError/i],
    // Whole transactions (not streamed spans), so that beforeSendTransaction applies.
    traceLifecycle: 'static' as const,
    // Buffer mode by default: the recording stays in memory until an error, a sampled session or a report sends it.
    replaysSessionSampleRate: replayWanted(config) ? config.replay!.sessionSampleRate : 0,
    replaysOnErrorSampleRate: replayWanted(config) ? config.replay!.onErrorSampleRate : 0,
    beforeSend: <E extends object>(event: E) => scrubEvent(event),
    beforeSendTransaction: <E extends object>(event: E) => scrubEvent(event),
    beforeBreadcrumb: <B extends { category?: string }>(crumb: B) => scrubBreadcrumb(crumb),
  };
}

/** Starts reporting once the server has said it is on. Safe to call on every render: only the first call acts. */
export function initSentry(config: SentryWebConfig | undefined): void {
  if (started || !isSentryConfigured(config) || typeof window === 'undefined') return;
  started = true;
  replayOn = replayWanted(config);
  // Lets stylesheets show what only makes sense with reporting on (the board Help dialog's "Found an issue?" link).
  document.documentElement.dataset.folioReport = 'on';
  release = config.release;
  loading = import('@sentry/react')
    .then((mod) => {
      mod.init({
        ...sentryBrowserOptions(config),
        // No release-health sessions (one extra request per page load); errors, a trace sample, the trail of
        // requests, navigation and clicks, and (when switched on) the masked replay.
        integrations: (defaults) => [
          ...defaults.filter((i) => i.name !== 'BrowserSession' && i.name !== 'Breadcrumbs'),
          // Clicks keep only their selector (shared/sentryScrub.ts drops the rest); typed text and the console stay out.
          mod.breadcrumbsIntegration({ dom: true }),
          mod.browserTracingIntegration({
            // The path without tokens: /share/<token> becomes /share/[token].
            beforeStartSpan: (ctx) => ({ ...ctx, name: scrubUrl(ctx.name) ?? ctx.name }),
          }),
          ...(replayWanted(config) ? [mod.replayIntegration(replayOptions())] : []),
        ],
      });
      mod.addEventProcessor((event) => scrubEvent(event));
      sentry = mod;
      if (currentUserId) mod.setUser({ id: currentUserId });
      for (const err of pendingErrors.splice(0)) mod.captureException(err);
      return mod;
    })
    .catch(() => {
      // A blocked or failed load (ad blocker, offline) must never affect the app.
      started = false;
      replayOn = false;
      delete document.documentElement.dataset.folioReport;
      return null;
    });
}

/** Tags what follows with the signed-in user's id (nothing else); null on sign-out. */
export function setSentryUser(userId: string | null): void {
  currentUserId = userId;
  if (sentry) sentry.setUser(userId ? { id: userId } : null);
}

/** Reports an error the app caught itself (an error boundary). A no-op while reporting is off. Returns the event id once known. */
export function captureError(error: unknown): string | undefined {
  if (sentry) return sentry.captureException(error);
  if (started && pendingErrors.length < 10) pendingErrors.push(error);
  return undefined;
}

/** The id of the last error event, for tying a report to the crash the person just saw. */
export function lastSentryEventId(): string | undefined {
  return sentry?.lastEventId() || undefined;
}

export interface PageContext {
  /** The address without query string or fragment; tokens in the path are hidden. */
  path: string;
  space?: string;
  pageId?: string;
  /** doc, board, table, ... for a page; "folder", "graph", "settings", "admin", "share", "public" or "other" elsewhere. */
  kind: string;
}

/** What the report says about where the person was. Only the path, never the query. */
export function describePath(pathname: string, pageKind?: string): PageContext {
  const path = scrubUrl(pathname) ?? '/';
  const page = /^\/s\/([^/]+)\/p\/([^/]+)/.exec(pathname);
  if (page) return { path, space: decodeURIComponent(page[1]!), pageId: decodeURIComponent(page[2]!), kind: pageKind || 'page' };
  const space = /^\/s\/([^/]+)(?:\/(d|graph|settings))?/.exec(pathname);
  if (space) {
    const section = space[2];
    return { path, space: decodeURIComponent(space[1]!), kind: section === 'd' ? 'folder' : (section ?? 'space') };
  }
  if (pathname.startsWith('/admin/')) return { path, kind: 'admin' };
  if (pathname.startsWith('/share/')) return { path, kind: 'share' };
  if (pathname.startsWith('/public')) return { path, kind: 'public' };
  return { path, kind: 'other' };
}

export interface FeedbackInput {
  message: string;
  context: PageContext;
  /** An optional screenshot: attached or pasted by the person. */
  image?: File | null;
  /** The error event this report is about (an error screen's event id); default: the last error event of this tab. */
  associatedEventId?: string;
  /**
   * Whether the masked recording of recent actions goes with the report. A buffered recording is sent only when true
   * (and is dropped, not sent, when false); a session that is being recorded anyway links to the report either way.
   */
  attachReplay?: boolean;
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Sends a report to Sentry as user feedback. Returns the feedback event id. Throws when reporting is off, so the
 * dialog never says "thanks" for a report that went nowhere.
 */
export async function sendFeedback({ message, context, image, associatedEventId: givenEventId, attachReplay = false }: FeedbackInput): Promise<string> {
  const mod = sentry ?? (await loading);
  if (!mod) throw new Error('error reporting is not available');
  const attachments = image
    ? [{ filename: image.name || 'screenshot.png', data: new Uint8Array(await image.arrayBuffer()), contentType: image.type || 'image/png' }]
    : undefined;
  const tags: Record<string, string> = { page_kind: context.kind, ...(release ? { release } : {}) };
  if (context.space) tags.space = context.space;
  if (context.pageId) tags.page_id = context.pageId;
  tags.browser = browserName(typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const associatedEventId = givenEventId || lastSentryEventId();
  const url = typeof window === 'undefined' ? context.path : `${window.location.origin}${context.path}`;
  // The replay integration flushes a buffered recording by itself whenever a feedback event passes, so declining is
  // done by stopping the buffer for the moment of sending. Either way, a recording that was only a buffer goes back
  // to being a buffer afterwards: a report must not turn on continuous recording of the rest of the visit.
  const replay = replayOn ? mod.getReplay() : undefined;
  const buffered = replay?.getRecordingMode() === 'buffer';
  try {
    if (replay && buffered) {
      if (attachReplay) await replay.flush();
      else await replay.stop({ flush: false });
    }
    const id = mod.captureFeedback(
      { message: message.trim(), url, source: 'folio-report-problem', tags, ...(associatedEventId ? { associatedEventId } : {}) },
      attachments ? { attachments } : undefined,
    );
    // The replay processor links the report to the recording asynchronously: wait until the event has left.
    if (replay && buffered) await mod.flush(5000);
    return id;
  } finally {
    if (replay && buffered) {
      try {
        if (attachReplay) await replay.stop(); // sends the last segment, then the session is over
        replay.startBuffering();
      } catch {
        // Recording is a convenience; it must never break the report.
      }
    }
  }
}

/** A short "Chrome 130" style label; the full user agent travels with the event anyway. */
export function browserName(ua: string): string {
  const m = /(Edg|OPR|Firefox|Chrome|CriOS|FxiOS|Version)\/(\d+)/.exec(ua);
  if (!m) return 'unknown';
  const name = { Edg: 'Edge', OPR: 'Opera', CriOS: 'Chrome', FxiOS: 'Firefox', Version: /Safari/.test(ua) ? 'Safari' : 'Browser' }[m[1]!] ?? m[1]!;
  return `${name} ${m[2]}`;
}

export function __resetSentryForTests(): void {
  sentry = null;
  loading = null;
  started = false;
  replayOn = false;
  if (typeof document !== 'undefined') delete document.documentElement.dataset.folioReport;
  release = undefined;
  pendingErrors.length = 0;
  currentUserId = null;
}
