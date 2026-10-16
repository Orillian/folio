/**
 * The state machine of the shared page timer (server/pageTimer.ts), driven by
 * an explicit clock — no real waiting, no database.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PAGE_TIMER_FINISHED_LINGER_MS, PAGE_TIMER_MAX_MS } from '../shared/contracts.js';
import { HttpError } from './errors.js';
import { __resetTimersForTests, applyTimerAction, currentRev, PAUSED_TTL_MS, readTimer, remainingMs, sweepTimers, timerCount } from './pageTimer.js';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const KEY = 'page-1';

describe('page timer state machine', () => {
  beforeEach(() => __resetTimersForTests());
  afterEach(() => __resetTimersForTests());

  it('start stores the END MOMENT in server time, not a counter', () => {
    const change = applyTimerAction(KEY, { action: 'start', durationMs: 5 * MIN }, 'Alice', T0);
    expect(change.changed).toBe(true);
    expect(change.timer).toEqual({ durationMs: 5 * MIN, endsAt: T0 + 5 * MIN, pausedRemainingMs: null, startedByName: 'Alice', updatedAt: T0 });
    // Reading later does not move it.
    expect(readTimer(KEY, T0 + 2 * MIN)?.endsAt).toBe(T0 + 5 * MIN);
    expect(remainingMs(readTimer(KEY, T0 + 2 * MIN)!, T0 + 2 * MIN)).toBe(3 * MIN);
  });

  it('starting again replaces the running timer and its owner', () => {
    applyTimerAction(KEY, { action: 'start', durationMs: 5 * MIN }, 'Alice', T0);
    const change = applyTimerAction(KEY, { action: 'start', durationMs: MIN }, 'Bob', T0 + 1000);
    expect(change.timer).toMatchObject({ durationMs: MIN, endsAt: T0 + 1000 + MIN, startedByName: 'Bob' });
  });

  it('pause freezes the remaining time and resume continues from it', () => {
    applyTimerAction(KEY, { action: 'start', durationMs: 5 * MIN }, 'Alice', T0);
    const paused = applyTimerAction(KEY, { action: 'pause' }, 'Bob', T0 + 2 * MIN);
    expect(paused.timer).toMatchObject({ endsAt: null, pausedRemainingMs: 3 * MIN, startedByName: 'Alice' });
    // However long it stays paused, the remaining time does not move.
    expect(remainingMs(readTimer(KEY, T0 + 30 * MIN)!, T0 + 30 * MIN)).toBe(3 * MIN);
    const resumed = applyTimerAction(KEY, { action: 'resume' }, 'Bob', T0 + 10 * MIN);
    expect(resumed.timer).toMatchObject({ endsAt: T0 + 13 * MIN, pausedRemainingMs: null });
  });

  it('pause/resume/reset are quiet no-ops when the timer is already in that state (two people click at once)', () => {
    expect(applyTimerAction(KEY, { action: 'pause' }, 'A', T0)).toMatchObject({ timer: null, changed: false });
    expect(applyTimerAction(KEY, { action: 'resume' }, 'A', T0)).toMatchObject({ timer: null, changed: false });
    expect(applyTimerAction(KEY, { action: 'reset' }, 'A', T0)).toMatchObject({ timer: null, changed: false });
    applyTimerAction(KEY, { action: 'start', durationMs: MIN }, 'A', T0);
    expect(applyTimerAction(KEY, { action: 'resume' }, 'B', T0 + 1)).toMatchObject({ changed: false });
    applyTimerAction(KEY, { action: 'pause' }, 'A', T0 + 1000);
    const again = applyTimerAction(KEY, { action: 'pause' }, 'B', T0 + 2000);
    expect(again.changed).toBe(false);
    expect(again.timer?.pausedRemainingMs).toBe(MIN - 1000);
  });

  it('pause of a timer that has already run out changes nothing', () => {
    applyTimerAction(KEY, { action: 'start', durationMs: MIN }, 'A', T0);
    expect(applyTimerAction(KEY, { action: 'pause' }, 'B', T0 + MIN + 1).changed).toBe(false);
  });

  it('«+1 min» pushes the end of a running timer, tops up a paused one, and restarts a finished one from now', () => {
    applyTimerAction(KEY, { action: 'start', durationMs: 2 * MIN }, 'A', T0);
    expect(applyTimerAction(KEY, { action: 'add', ms: MIN }, 'B', T0 + 30_000).timer).toMatchObject({ endsAt: T0 + 3 * MIN, durationMs: 3 * MIN });

    applyTimerAction(KEY, { action: 'pause' }, 'A', T0 + MIN);
    expect(applyTimerAction(KEY, { action: 'add', ms: MIN }, 'B', T0 + MIN).timer).toMatchObject({ endsAt: null, pausedRemainingMs: 3 * MIN });

    applyTimerAction(KEY, { action: 'start', durationMs: MIN }, 'A', T0);
    const late = applyTimerAction(KEY, { action: 'add', ms: MIN }, 'B', T0 + 90_000);
    expect(late.timer).toMatchObject({ endsAt: T0 + 90_000 + MIN, durationMs: MIN, startedByName: 'B' });
  });

  it('«+1 min» with no timer at all is a 409', () => {
    try {
      applyTimerAction(KEY, { action: 'add', ms: MIN }, 'A', T0);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(409);
    }
  });

  it('never lets a timer run past the cap, however it is topped up', () => {
    applyTimerAction(KEY, { action: 'start', durationMs: PAGE_TIMER_MAX_MS }, 'A', T0);
    const topped = applyTimerAction(KEY, { action: 'add', ms: PAGE_TIMER_MAX_MS }, 'A', T0);
    expect(topped.timer!.endsAt! - T0).toBe(PAGE_TIMER_MAX_MS);
    applyTimerAction(KEY, { action: 'pause' }, 'A', T0);
    expect(applyTimerAction(KEY, { action: 'add', ms: PAGE_TIMER_MAX_MS }, 'A', T0).timer!.pausedRemainingMs).toBe(PAGE_TIMER_MAX_MS);
  });

  it('reset clears it', () => {
    applyTimerAction(KEY, { action: 'start', durationMs: MIN }, 'A', T0);
    const change = applyTimerAction(KEY, { action: 'reset' }, 'A', T0 + 1);
    expect(change).toMatchObject({ timer: null, changed: true });
    expect(readTimer(KEY, T0 + 2)).toBeNull();
  });

  it('keeps timers of different keys apart', () => {
    applyTimerAction('a', { action: 'start', durationMs: MIN }, 'A', T0);
    applyTimerAction('b', { action: 'start', durationMs: 2 * MIN }, 'B', T0);
    applyTimerAction('a', { action: 'reset' }, 'A', T0);
    expect(readTimer('a', T0)).toBeNull();
    expect(readTimer('b', T0)?.durationMs).toBe(2 * MIN);
  });

  it('a finished timer stays visible for the linger window, then clears itself', () => {
    applyTimerAction(KEY, { action: 'start', durationMs: MIN }, 'A', T0);
    const end = T0 + MIN;
    expect(readTimer(KEY, end + 1)).not.toBeNull();
    expect(remainingMs(readTimer(KEY, end + 1)!, end + 1)).toBe(0);
    expect(readTimer(KEY, end + PAGE_TIMER_FINISHED_LINGER_MS - 1)).not.toBeNull();
    expect(readTimer(KEY, end + PAGE_TIMER_FINISHED_LINGER_MS)).toBeNull();
    expect(timerCount()).toBe(0); // reading pruned it
  });

  it('the sweep drops finished and long-paused timers and keeps live ones', () => {
    applyTimerAction('finished', { action: 'start', durationMs: MIN }, 'A', T0);
    applyTimerAction('paused', { action: 'start', durationMs: 10 * MIN }, 'A', T0);
    applyTimerAction('paused', { action: 'pause' }, 'A', T0 + 1000);
    applyTimerAction('live', { action: 'start', durationMs: PAGE_TIMER_MAX_MS }, 'A', T0);
    expect(sweepTimers(T0 + MIN + PAGE_TIMER_FINISHED_LINGER_MS)).toBe(1);
    expect(sweepTimers(T0 + 1000 + PAUSED_TTL_MS)).toBe(1);
    expect(timerCount()).toBe(1);
    expect(readTimer('live', T0 + 1000 + PAUSED_TTL_MS)).not.toBeNull();
  });

  it('every change gets a larger revision; a no-op keeps the current one; updatedAt only grows', () => {
    const first = applyTimerAction(KEY, { action: 'start', durationMs: MIN }, 'A', T0);
    const second = applyTimerAction(KEY, { action: 'pause' }, 'A', T0); // same millisecond
    expect(second.rev).toBeGreaterThan(first.rev);
    expect(second.timer!.updatedAt).toBeGreaterThan(first.timer!.updatedAt);
    const noop = applyTimerAction(KEY, { action: 'pause' }, 'A', T0 + 5);
    expect(noop.changed).toBe(false);
    expect(noop.rev).toBe(currentRev());
  });
});
