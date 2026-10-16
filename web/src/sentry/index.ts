/**
 * Optional error reporting (Sentry) and the "Report a problem" dialog. OFF unless the server hands over a DSN:
 * GET /api/auth/state carries `sentry` only when the operator set SENTRY_DSN (server/sentry.ts). Without it nothing in
 * this file loads @sentry/react or contacts anybody; `captureError` is a no-op and the dialog is not offered.
 *
 * What is sent: unhandled errors (with a scrubbed URL and a trimmed trail of requests), a trace sample, the signed-in
 * user's id, and, when a person presses "Report a problem", the message they typed, the optional screenshot they
 * attached, the page path (no query), page id and kind, the release and the browser.
 * Never sent: page content or titles, search words, input values, cookies, Authorization, query strings (share
 * links and tokens ride in them), e-mail or name. No Session Replay. The exact rules: shared/sentryScrub.ts.
 */
import type { SentryWebConfig } from '@shared/contracts';
import { scrubBreadcrumb, scrubEvent, scrubUrl } from '@shared/sentryScrub';

type SentryReact = typeof import('@sentry/react');

let sentry: SentryReact | null = null;
let loading: Promise<SentryReact | null> | null = null;
let started = false;
let release: string | undefined;
const pendingErrors: unknown[] = [];
let currentUserId: string | null = null;

/** Whether error reporting was switched on by the server and has loaded. The dialog is offered only then. */
export function isSentryEnabled(): boolean {
  return started;
}

/** Whether the server asked for error reporting (true as soon as init was called, before the SDK finished loading). */
export function isSentryConfigured(config: SentryWebConfig | undefined): config is SentryWebConfig {
  return Boolean(config?.dsn);
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
    beforeSend: <E extends object>(event: E) => scrubEvent(event),
    beforeSendTransaction: <E extends object>(event: E) => scrubEvent(event),
    beforeBreadcrumb: <B extends { category?: string }>(crumb: B) => scrubBreadcrumb(crumb),
  };
}

/** Starts reporting once the server has said it is on. Safe to call on every render: only the first call acts. */
export function initSentry(config: SentryWebConfig | undefined): void {
  if (started || !isSentryConfigured(config) || typeof window === 'undefined') return;
  started = true;
  release = config.release;
  loading = import('@sentry/react')
    .then((mod) => {
      mod.init({
        ...sentryBrowserOptions(config),
        // No Session Replay and no release-health sessions (one extra request per page load); only errors,
        // a trace sample and the trail of requests and navigation.
        integrations: (defaults) => [
          ...defaults.filter((i) => i.name !== 'BrowserSession' && i.name !== 'Breadcrumbs'),
          // Typed text, clicks and the console can hold content: only requests and navigation are kept as a trail.
          mod.breadcrumbsIntegration({ dom: false }),
          mod.browserTracingIntegration({
            // The path without tokens: /share/<token> becomes /share/[token].
            beforeStartSpan: (ctx) => ({ ...ctx, name: scrubUrl(ctx.name) ?? ctx.name }),
          }),
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
      return null;
    });
}

/** Tags what follows with the signed-in user's id (nothing else); null on sign-out. */
export function setSentryUser(userId: string | null): void {
  currentUserId = userId;
  if (sentry) sentry.setUser(userId ? { id: userId } : null);
}

/** Reports an error the app caught itself (an error boundary). A no-op while reporting is off. */
export function captureError(error: unknown): void {
  if (sentry) sentry.captureException(error);
  else if (started && pendingErrors.length < 10) pendingErrors.push(error);
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
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Sends a report to Sentry as user feedback. Returns the feedback event id. Throws when reporting is off, so the
 * dialog never says "thanks" for a report that went nowhere.
 */
export async function sendFeedback({ message, context, image }: FeedbackInput): Promise<string> {
  const mod = sentry ?? (await loading);
  if (!mod) throw new Error('error reporting is not available');
  const attachments = image
    ? [{ filename: image.name || 'screenshot.png', data: new Uint8Array(await image.arrayBuffer()), contentType: image.type || 'image/png' }]
    : undefined;
  const tags: Record<string, string> = { page_kind: context.kind, ...(release ? { release } : {}) };
  if (context.space) tags.space = context.space;
  if (context.pageId) tags.page_id = context.pageId;
  tags.browser = browserName(typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const associatedEventId = lastSentryEventId();
  const url = typeof window === 'undefined' ? context.path : `${window.location.origin}${context.path}`;
  return mod.captureFeedback(
    { message: message.trim(), url, source: 'folio-report-problem', tags, ...(associatedEventId ? { associatedEventId } : {}) },
    attachments ? { attachments } : undefined,
  );
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
  release = undefined;
  pendingErrors.length = 0;
  currentUserId = null;
}
