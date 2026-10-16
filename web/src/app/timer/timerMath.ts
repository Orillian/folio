import { PAGE_TIMER_FINISHED_LINGER_MS, PAGE_TIMER_MAX_MS, PAGE_TIMER_MIN_MS, type PageTimerState } from '@shared/contracts';

/**
 * The arithmetic of the shared page timer, kept free of React and of the clock
 * (every function takes `localNow`) so it is testable to the millisecond.
 *
 * The server stores the END MOMENT in ITS epoch (`endsAt`); this device's
 * clock may be seconds off. `offsetMs` is "server time minus local time",
 * measured whenever a response or a frame arrives (serverNow - the local
 * moment it was received), so `serverTime = localNow + offsetMs`, and a
 * countdown computed from `endsAt` reaches zero at the same real moment on
 * every device, whatever its clock says.
 */

/** The preset buttons, in minutes. */
export const TIMER_PRESET_MINUTES = [1, 3, 5, 10] as const;

/** A timer that rang longer ago than this is "history" (a reload, a latecomer): it is shown as finished but nothing sounds. */
export const FINISH_LATE_MS = 5000;

/** The last stretch of the countdown that is drawn as urgent. */
export const URGENT_MS = 10_000;

/** `serverNow` (from a response/frame) against the local clock at the moment it was received. */
export function clockOffset(serverNow: number, receivedAtLocal: number): number {
  return serverNow - receivedAtLocal;
}

/** Milliseconds left: the frozen value while paused, the distance to `endsAt` while running (negative once it has rung). */
export function msLeft(timer: PageTimerState, localNow: number, offsetMs: number): number {
  return timer.endsAt === null ? (timer.pausedRemainingMs ?? 0) : timer.endsAt - (localNow + offsetMs);
}

export type TimerPhase = 'running' | 'paused' | 'finished';

export function phaseOf(timer: PageTimerState, localNow: number, offsetMs: number): TimerPhase {
  if (timer.endsAt === null) return 'paused';
  return msLeft(timer, localNow, offsetMs) > 0 ? 'running' : 'finished';
}

/** The server clears a finished timer after the linger window; a client that has not heard about it yet stops showing it by itself. */
export function isGone(timer: PageTimerState, localNow: number, offsetMs: number): boolean {
  return timer.endsAt !== null && msLeft(timer, localNow, offsetMs) <= -PAGE_TIMER_FINISHED_LINGER_MS;
}

/** The whole seconds shown on the clock: rounded UP, so the display reads 00:00 exactly when the time is up and never earlier. */
export function secondsShown(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000));
}

/** `m:ss` (or `h:mm:ss` from an hour up), zero-padded minutes below ten like a kitchen timer: `05:00`, `00:09`, `1:30:00`. */
export function formatClock(ms: number): string {
  const total = secondsShown(ms);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${String(minutes).padStart(2, '0')}:${ss}`;
}

/**
 * How long until the displayed second changes — so the clock re-renders
 * exactly on the beat instead of polling. At least a few ms, never more than a second.
 */
export function nextBeatDelay(ms: number): number {
  const rest = ms % 1000;
  return (rest <= 0 ? rest + 1000 : rest) + 5;
}

export type CustomTimeResult = { ok: true; durationMs: number } | { ok: false };

/** The "custom" form: two text inputs. Digits only, at least one second, at most the cap; blank means 0. */
export function parseCustomTime(minutesText: string, secondsText: string): CustomTimeResult {
  const part = (text: string): number | null => {
    const trimmed = text.trim();
    if (trimmed === '') return 0;
    return /^\d{1,4}$/.test(trimmed) ? Number(trimmed) : null;
  };
  const minutes = part(minutesText);
  const seconds = part(secondsText);
  if (minutes === null || seconds === null) return { ok: false };
  const durationMs = (minutes * 60 + seconds) * 1000;
  if (durationMs < PAGE_TIMER_MIN_MS || durationMs > PAGE_TIMER_MAX_MS) return { ok: false };
  return { ok: true, durationMs };
}
