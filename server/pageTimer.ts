/**
 * The shared page timer (16.10.2026) — "a countdown in the header that
 * everybody on this page sees, and hears at the end".
 *
 * WHERE THE STATE LIVES. In this process's memory, keyed by the timer key (a
 * page id, or `space:<slug>` for a folder listing of a space), and nowhere else: not in the
 * page file, not in git, not in the Yjs document, not in the audit log. A
 * timer is a few minutes of a meeting, not content; losing it on a restart is
 * fine (the clients simply show nothing). The collab rooms are in-memory too,
 * so the instance is already a single-process deployment — see
 * docs/LIMITATIONS.md. (Redis is best-effort in this app and has no pub/sub
 * use; the sidebar signal rides on Postgres LISTEN/NOTIFY. A timer is not worth
 * a new bus: with several processes each would hold its own copy.)
 *
 * WHAT IS STORED is the END MOMENT, not a counter: `endsAt` (server epoch ms)
 * while running, `pausedRemainingMs` while paused. Nothing ticks on the server.
 * Every client renders the countdown itself from `endsAt` corrected by its own
 * clock offset (`serverNow` rides on every response and frame), so all of them
 * reach 00:00 within a network hop of each other, and a client that joins late
 * (or reconnects) only has to read the state once.
 *
 * HOW IT TRAVELS: the REST route (server/pageTimerRoutes.ts) applies an action
 * here and then fans the new state out over the existing `/events` socket, to
 * the open sessions that may read the page (a frame `{ type: 'timer', key,
 * timer, rev, serverNow }`). A client that is not on that page ignores it.
 *
 * LIFETIME. A finished timer stays for PAGE_TIMER_FINISHED_LINGER_MS (so a
 * latecomer sees "time is up" instead of nothing, and anybody can still reset
 * it), then clears itself; a paused one is dropped after PAUSED_TTL_MS of
 * silence. A sweep every minute keeps the map from growing; reading prunes too.
 *
 * Every function takes `now` so the tests drive the clock directly.
 */
import { PAGE_TIMER_FINISHED_LINGER_MS, PAGE_TIMER_MAX_MS, type PageTimerActionBody, type PageTimerState } from '../shared/contracts.js';
import { conflict } from './errors.js';

/** A paused timer nobody touched for this long is forgotten. */
export const PAUSED_TTL_MS = 2 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

const timers = new Map<string, PageTimerState>();

/**
 * Per-process change counter. Starts at the boot time so that, after a restart,
 * every number is larger than any a still-open tab remembers from before.
 */
let revCounter = Date.now();

/** The newest change number issued so far: a response read now reflects everything up to it. */
export function currentRev(): number {
  return revCounter;
}

function nextRev(now: number): number {
  revCounter = Math.max(revCounter + 1, now);
  return revCounter;
}

function isExpired(timer: PageTimerState, now: number): boolean {
  if (timer.endsAt !== null) return now >= timer.endsAt + PAGE_TIMER_FINISHED_LINGER_MS;
  return now >= timer.updatedAt + PAUSED_TTL_MS;
}

/** The timer of `key`, or null when there is none (or it cleared itself). */
export function readTimer(key: string, now = Date.now()): PageTimerState | null {
  const timer = timers.get(key);
  if (!timer) return null;
  if (isExpired(timer, now)) {
    timers.delete(key);
    return null;
  }
  return { ...timer };
}

/** Time left on a timer: the frozen value while paused, `endsAt - now` while running (never negative). */
export function remainingMs(timer: PageTimerState, now: number): number {
  return timer.endsAt === null ? (timer.pausedRemainingMs ?? 0) : Math.max(0, timer.endsAt - now);
}

export interface TimerChange {
  /** The state after the action (null: cleared). */
  timer: PageTimerState | null;
  /** False for an action that did nothing (pause of a paused timer, a second reset): no frame goes out. */
  changed: boolean;
  /** The change number of this change; the current one when nothing changed. */
  rev: number;
}

/**
 * Applies an action. Idempotent where two people can click at once:
 * pause/resume/reset of a timer already in that state are quiet no-ops, not
 * errors. `add` with no timer is the one 409 («+1 min» only exists next to a
 * timer). `add` on a timer that has run out starts a fresh one of that length.
 */
export function applyTimerAction(key: string, action: PageTimerActionBody, actorName: string, now = Date.now()): TimerChange {
  const current = readTimer(key, now);
  const unchanged = (): TimerChange => ({ timer: current, changed: false, rev: currentRev() });

  const commit = (next: PageTimerState | null): TimerChange => {
    if (next) timers.set(key, next);
    else timers.delete(key);
    ensureSweep();
    return { timer: next ? { ...next } : null, changed: true, rev: nextRev(now) };
  };
  // `updatedAt` only ever grows per key, so a client can order two states of one timer by it too.
  const stamp = (): number => Math.max(now, (current?.updatedAt ?? 0) + 1);

  switch (action.action) {
    case 'start':
      return commit({ durationMs: action.durationMs, endsAt: now + action.durationMs, pausedRemainingMs: null, startedByName: actorName, updatedAt: stamp() });

    case 'pause': {
      if (!current || current.endsAt === null || current.endsAt <= now) return unchanged();
      return commit({ ...current, endsAt: null, pausedRemainingMs: current.endsAt - now, updatedAt: stamp() });
    }

    case 'resume': {
      if (!current || current.endsAt !== null) return unchanged();
      return commit({ ...current, endsAt: now + (current.pausedRemainingMs ?? 0), pausedRemainingMs: null, updatedAt: stamp() });
    }

    case 'add': {
      if (!current) throw conflict('there is no timer to add time to');
      if (current.endsAt === null) {
        const pausedRemainingMs = Math.min(PAGE_TIMER_MAX_MS, (current.pausedRemainingMs ?? 0) + action.ms);
        return commit({ ...current, pausedRemainingMs, durationMs: current.durationMs + action.ms, updatedAt: stamp() });
      }
      if (current.endsAt <= now) {
        // Already rang: «+1 min» means "one more minute from now".
        const durationMs = Math.min(PAGE_TIMER_MAX_MS, action.ms);
        return commit({ durationMs, endsAt: now + durationMs, pausedRemainingMs: null, startedByName: actorName, updatedAt: stamp() });
      }
      const endsAt = Math.min(now + PAGE_TIMER_MAX_MS, current.endsAt + action.ms);
      return commit({ ...current, endsAt, durationMs: current.durationMs + action.ms, updatedAt: stamp() });
    }

    case 'reset':
      return current ? commit(null) : unchanged();
  }
}

/** Drops every timer that has cleared itself. Returns how many went. */
export function sweepTimers(now = Date.now()): number {
  let removed = 0;
  for (const [key, timer] of timers) {
    if (isExpired(timer, now)) {
      timers.delete(key);
      removed += 1;
    }
  }
  return removed;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepTimers();
    if (timers.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, SWEEP_INTERVAL_MS);
  // The sweep must not keep the process alive by itself.
  sweepTimer.unref?.();
}

/** How many timers the process holds — diagnostics and tests. */
export function timerCount(): number {
  return timers.size;
}

export function __resetTimersForTests(): void {
  timers.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
