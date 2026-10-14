import type { AssistantRunEvent } from '@shared/contracts';
import { ApiError, UNAUTHORIZED_EVENT } from '../api';

/** Every `AssistantRunEvent` except `ping` — pings only reset the silence timer below, callers never see them. */
type AssistantRunDataEvent = Exclude<AssistantRunEvent, { type: 'ping' }>;

/**
 * Where a run's events come from. The default is the signed-in route; the public site's Ask panel
 * (app/public) passes its own anonymous one — same NDJSON stream, different URL and different rules for
 * a refused request.
 */
export interface AssistantEventsSource {
  /** URL of the NDJSON stream of `runId`, replaying the events with `seq` greater than `since`. */
  url: (runId: string, since: number) => string;
  /**
   * An anonymous reader has no session to lose: a 401 must not fire UNAUTHORIZED_EVENT (which would send an
   * AuthProvider surface to the login screen), and any 4xx answer is final (a run or token the server does
   * not know will not appear by asking again) instead of being retried for ten minutes.
   */
  anonymous?: boolean;
}

/** The signed-in user's own run: `GET /api/assistant/runs/:runId/events`. */
const SIGNED_IN_SOURCE: AssistantEventsSource = {
  url: (runId, since) => `/api/assistant/runs/${encodeURIComponent(runId)}/events?since=${since}`,
};

/** Whether a refused stream request ends the subscription (rejects) rather than backing off and reconnecting. */
function isFinalStreamError(error: unknown, source: AssistantEventsSource): boolean {
  if (!(error instanceof ApiError)) return false;
  return source.anonymous ? error.status >= 400 && error.status < 500 : error.status === 401;
}
/** The three event types the NDJSON stream ends on (see shared/contracts.ts's `AssistantRunEvent` doc comment). */
type TerminalRunEvent = Extract<AssistantRunDataEvent, { type: 'complete' | 'stopped' | 'error' }>;

function isTerminal(event: AssistantRunDataEvent): event is TerminalRunEvent {
  return event.type === 'complete' || event.type === 'stopped' || event.type === 'error';
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Reads one NDJSON connection to `GET /api/assistant/runs/:runId/events` to
 * completion: replay (seq > since) then live, until either a terminal event
 * arrives (resolve) or the body/connection ends without one (resolve null —
 * the caller reconnects) or the request itself fails (reject).
 *
 * A "silence" watchdog guards the case where the connection looks open but
 * has gone quiet past the server's ~15s ping cadence (dead proxy, sleeping
 * tab's underlying socket, etc.): with no line — event OR ping — for
 * SILENCE_TIMEOUT_MS, it aborts the read internally so the outer loop
 * reconnects, same as any other network failure.
 */
function streamOnce(
  source: AssistantEventsSource,
  runId: string,
  since: number,
  onEvent: (event: AssistantRunDataEvent) => void,
  outerSignal: AbortSignal,
): Promise<TerminalRunEvent | null> {
  const SILENCE_TIMEOUT_MS = 45_000; // 3x the server's ~15s ping cadence

  return new Promise((resolve, reject) => {
    const internalController = new AbortController();
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    function resetSilenceTimer() {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => internalController.abort(), SILENCE_TIMEOUT_MS);
    }
    function onOuterAbort() {
      internalController.abort();
    }
    function cleanup() {
      if (silenceTimer) clearTimeout(silenceTimer);
      outerSignal.removeEventListener('abort', onOuterAbort);
    }
    function finish(fn: () => void) {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    }

    outerSignal.addEventListener('abort', onOuterAbort);
    if (outerSignal.aborted) internalController.abort();

    (async () => {
      const response = await fetch(source.url(runId, since), {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/x-ndjson' },
        signal: internalController.signal,
      });

      if (!response.ok) {
        let message = response.statusText || `HTTP ${response.status}`;
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload?.error) message = payload.error;
        } catch {
          // Response wasn't JSON (or was empty) — keep the statusText fallback.
        }
        if (response.status === 401 && !source.anonymous) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
        throw new ApiError(response.status, message);
      }
      if (!response.body) throw new Error('Streaming response body is unavailable');

      resetSilenceTimer();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      function handleLine(line: string): TerminalRunEvent | null {
        if (!line.trim()) return null;
        const event = JSON.parse(line) as AssistantRunEvent;
        if (event.type === 'ping') return null; // silence timer already reset by the caller; nothing else to do
        onEvent(event);
        return isTerminal(event) ? event : null;
      }

      while (true) {
        const { done, value } = await reader.read();
        if (settled) return; // silence watchdog (or outer abort) fired while this read was in flight
        resetSilenceTimer();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const terminal = handleLine(line);
          if (terminal) {
            void reader.cancel().catch(() => undefined);
            finish(() => resolve(terminal));
            return;
          }
        }
        if (done) break;
      }
      if (buffer.trim()) {
        const terminal = handleLine(buffer);
        if (terminal) {
          finish(() => resolve(terminal));
          return;
        }
      }
      finish(() => resolve(null)); // stream closed cleanly with no terminal event — caller reconnects
    })().catch((error: unknown) => finish(() => reject(error)));
  });
}

export interface SubscribeAssistantRunOptions {
  runId: string;
  /** Resume point: only events with `seq` greater than this are delivered (replay + live). */
  since: number;
  onEvent: (event: AssistantRunDataEvent) => void;
  /** Where the events are read from; defaults to the signed-in user's own run. */
  source?: AssistantEventsSource;
  /** Fires `true` while a reconnect attempt is backing off, `false` once a connection is (re)established. */
  onReconnecting?: (reconnecting: boolean) => void;
  signal: AbortSignal;
}

const RECONNECT_DELAYS_MS = [1500, 3000, 5000, 10_000];
const MAX_RECONNECT_BUDGET_MS = 10 * 60 * 1000;

/**
 * Subscribes to a run's NDJSON event stream and keeps it alive across drops:
 * a connection that closes or fails WITHOUT a terminal event triggers a
 * reconnect (1.5s, 3s, 5s, then 10s, capped at ~10 minutes total budget)
 * resuming from the last `seq` this call has actually delivered — so a
 * replay overlap from the new connection is deduped rather than re-applied.
 * Resolves with the terminal event (`complete`/`stopped`/`error`) once the
 * run actually finishes. A 401 mid-stream dispatches UNAUTHORIZED_EVENT and
 * rejects immediately (no point reconnecting an unauthenticated session); an
 * `anonymous` source rejects on any 4xx instead and never dispatches it. An
 * outer `signal` abort rejects with AbortError, same as a plain fetch.
 */
export async function subscribeAssistantRun({
  runId,
  since,
  onEvent,
  source = SIGNED_IN_SOURCE,
  onReconnecting,
  signal,
}: SubscribeAssistantRunOptions): Promise<TerminalRunEvent> {
  let lastSeq = since;
  let reconnectBudgetMs = 0;
  let attempt = 0;

  for (;;) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const terminal = await streamOnce(
        source,
        runId,
        lastSeq,
        (event) => {
          if (event.seq <= lastSeq) return; // dedup: already delivered by a previous connection's replay
          lastSeq = event.seq;
          onEvent(event);
        },
        signal,
      );
      onReconnecting?.(false);
      attempt = 0;
      reconnectBudgetMs = 0;
      if (terminal) return terminal;
      // Connection closed cleanly but with no terminal event — reconnect below.
    } catch (error) {
      if (signal.aborted) throw error instanceof DOMException ? error : new DOMException('Aborted', 'AbortError');
      if (isFinalStreamError(error, source)) throw error;
      // Any other failure (network drop, silence-timeout abort, transient 5xx) — reconnect.
    }

    onReconnecting?.(true);
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    attempt += 1;
    reconnectBudgetMs += delay;
    if (reconnectBudgetMs > MAX_RECONNECT_BUDGET_MS) {
      onReconnecting?.(false);
      throw new Error('Assistant run subscription gave up reconnecting');
    }
    await sleep(delay, signal);
  }
}
