/**
 * Optional error reporting (Sentry). OFF by default: an ordinary instance never contacts anybody, and the public
 * documentation promises exactly that. It is switched on by the operator with
 *
 *   SENTRY_DSN                  the project DSN (a public key, but it is the on-switch). Without it nothing below does anything.
 *   SENTRY_ENVIRONMENT          the environment tag; default "production" when NODE_ENV=production, else "development".
 *   SENTRY_TRACES_SAMPLE_RATE   0..1, the share of requests traced for performance (default 0.1; 0 turns tracing off).
 *   SENTRY_PROFILES             1/true to add CPU profiles to the traced requests (default off; needs @sentry/profiling-node).
 *   SENTRY_RELEASE              the release name; default FOLIO_RELEASE, which the image build sets to the short git sha.
 *   SENTRY_REPLAY               Session Replay in the browser, all text/inputs/media masked: default on when SENTRY_DSN is set; 0/false/off disables.
 *   SENTRY_REPLAY_ON_ERROR      0..1, the share of sessions with an error whose last minute is sent (default 1).
 *   SENTRY_REPLAY_SESSION_RATE  0..1, the share of whole sessions recorded and sent (default 0: only the error buffer and "Report a problem").
 *
 * The same DSN, environment, release and sample rate are handed to the web app by GET /api/auth/state, which then
 * loads @sentry/react and offers the "Report a problem" dialog (web/src/sentry).
 *
 * Captured: unhandled exceptions and rejections, and requests that end in 5xx. Not captured: the 4xx answers the app
 * gives on purpose (not found, forbidden, validation, rate limits).
 * Never sent: request bodies, cookies, Authorization and other headers, query strings (they carry share and OAuth
 * tokens), page content, titles, search text, e-mail addresses, names. The user is the internal id and nothing else.
 * See shared/sentryScrub.ts for the exact rules. Instrumentation is loaded before the app (server/instrument.ts).
 */
import { createRequire } from 'node:module';
import * as Sentry from '@sentry/node';
import type { SentryWebConfig } from '../shared/contracts.js';
import { scrubEvent } from '../shared/sentryScrub.js';

const DEFAULT_TRACES_SAMPLE_RATE = 0.1;
const OFF_RE = /^(0|false|no|off)$/i;

export interface SentryServerConfig extends SentryWebConfig {
  profiles: boolean;
}

type Env = Record<string, string | undefined>;
type Integration = Extract<NonNullable<Sentry.NodeOptions['integrations']>, unknown[]>[number];

function clampRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** The configuration, or undefined when error reporting is not switched on. */
export function sentryConfig(env: Env = process.env): SentryServerConfig | undefined {
  const dsn = (env.SENTRY_DSN ?? '').trim();
  if (!dsn) return undefined;
  try {
    const url = new URL(dsn);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  } catch {
    return undefined;
  }
  const environment = (env.SENTRY_ENVIRONMENT ?? '').trim() || (env.NODE_ENV === 'production' ? 'production' : 'development');
  const release = (env.SENTRY_RELEASE ?? '').trim() || (env.FOLIO_RELEASE ?? '').trim() || undefined;
  const profiles = /^(1|true|yes|on)$/i.test((env.SENTRY_PROFILES ?? '').trim());
  return {
    dsn,
    environment,
    ...(release ? { release } : {}),
    tracesSampleRate: clampRate(env.SENTRY_TRACES_SAMPLE_RATE, DEFAULT_TRACES_SAMPLE_RATE),
    replay: {
      enabled: !OFF_RE.test((env.SENTRY_REPLAY ?? '').trim()),
      sessionSampleRate: clampRate(env.SENTRY_REPLAY_SESSION_RATE, 0),
      onErrorSampleRate: clampRate(env.SENTRY_REPLAY_ON_ERROR, 1),
    },
    profiles,
  };
}

/** What the browser needs (no server-only switches), or undefined when off. For GET /api/auth/state. */
export function sentryWebConfig(env: Env = process.env): SentryWebConfig | undefined {
  const cfg = sentryConfig(env);
  if (!cfg) return undefined;
  const { profiles: _profiles, ...web } = cfg;
  return web;
}

/** Whether a failed request is worth a report: server faults only. The 4xx answers are the app working as intended. */
export function shouldCaptureStatus(status: number): boolean {
  return status >= 500;
}

function errorStatus(error: unknown, replyStatus: number): number {
  if (replyStatus !== 200) return replyStatus;
  const e = error as { statusCode?: unknown; status?: unknown } | null;
  const raw = Number(e?.statusCode ?? e?.status);
  return raw >= 400 ? raw : 500;
}

/** Errors that mean "the client went away", not "the server broke". */
const IGNORED_ERRORS = [/aborted/i, /ECONNRESET/, /EPIPE/, /socket hang up/i];

const IGNORED_TRANSACTIONS = [/\/api\/health\b/, /^(GET|HEAD) \/(assets|a|files)\//, /^GET \/(favicon|robots|og\/)/];

let enabled = false;

/** True once initSentry has switched reporting on in this process. */
export function sentryEnabled(): boolean {
  return enabled;
}

/** Loads the optional profiler. A missing or broken native module only turns profiling off. */
function profilingIntegration(): Integration | undefined {
  try {
    const require = createRequire(import.meta.url);
    const mod = require('@sentry/profiling-node') as { nodeProfilingIntegration: () => Integration };
    return mod.nodeProfilingIntegration();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[sentry] profiling requested but @sentry/profiling-node is unavailable:', err instanceof Error ? err.message : err);
    return undefined;
  }
}

export interface InitOverrides {
  /** Tests inject a transport that records envelopes instead of sending them. */
  transport?: Sentry.NodeOptions['transport'];
}

/** Starts Sentry when SENTRY_DSN is set; otherwise does nothing at all. Idempotent. Returns whether reporting is on. */
export function initSentry(env: Env = process.env, overrides: InitOverrides = {}): boolean {
  if (enabled) return true;
  const cfg = sentryConfig(env);
  if (!cfg) return false;
  const profiler = cfg.profiles ? profilingIntegration() : undefined;
  Sentry.init({
    dsn: cfg.dsn,
    environment: cfg.environment,
    ...(cfg.release ? { release: cfg.release } : {}),
    tracesSampleRate: cfg.tracesSampleRate,
    // Whole transactions (not streamed spans), so that beforeSendTransaction and ignoreTransactions below apply.
    traceLifecycle: 'static',
    ...(profiler ? { profilesSampleRate: 1 } : {}),
    // Collect only what the scrubber below would let through anyway; the user id is set by hand (setSentryUser).
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    maxBreadcrumbs: 30,
    // Our own outgoing calls (git hosts, S3, AI providers) must stay untouched: no trace headers to third parties.
    tracePropagationTargets: [],
    ignoreErrors: IGNORED_ERRORS,
    ignoreTransactions: IGNORED_TRANSACTIONS,
    integrations: [
      Sentry.fastifyIntegration({
        shouldHandleError: (error, _request, reply) => shouldCaptureStatus(errorStatus(error, reply.statusCode)),
      }),
      Sentry.httpIntegration({ maxRequestBodySize: 'none', breadcrumbs: false, sessions: false, tracePropagation: false }),
      Sentry.nativeNodeFetchIntegration({ breadcrumbs: false }),
      ...(profiler ? [profiler] : []),
    ],
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => (crumb.category === 'console' ? null : crumb),
    ...(overrides.transport ? { transport: overrides.transport } : {}),
  });
  // Feedback events skip beforeSend; the processor covers every event type.
  Sentry.addEventProcessor((event) => scrubEvent(event));
  enabled = true;
  return true;
}

/** Tags the current request's events with the signed-in user's id. No e-mail, no name. A no-op while reporting is off. */
export function setSentryUser(userId: string | undefined): void {
  if (!enabled) return;
  Sentry.setUser(userId ? { id: userId } : null);
}

/** Sends an error the code handled itself but wants to know about. A no-op while reporting is off. */
export function captureServerException(err: unknown): void {
  if (enabled) Sentry.captureException(err);
}

/** Waits (at most `timeoutMs`) for queued events to leave, so a restart does not eat the last error. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  await Sentry.flush(timeoutMs).catch(() => false);
}

/** For tests: leaves the "on" state and closes the client. */
export async function __resetSentryForTests(): Promise<void> {
  if (enabled) await Sentry.close(0).catch(() => false);
  enabled = false;
}
