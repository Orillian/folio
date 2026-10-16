import { describe, expect, it } from 'vitest';
import { PAGE_TIMER_FINISHED_LINGER_MS, PAGE_TIMER_MAX_MS, type PageTimerState } from '@shared/contracts';
import { clockOffset, formatClock, isGone, msLeft, nextBeatDelay, parseCustomTime, phaseOf, secondsShown } from './timerMath';

const running = (endsAt: number): PageTimerState => ({ durationMs: 60_000, endsAt, pausedRemainingMs: null, startedByName: 'A', updatedAt: 0 });
const paused = (ms: number): PageTimerState => ({ durationMs: 60_000, endsAt: null, pausedRemainingMs: ms, startedByName: 'A', updatedAt: 0 });

describe('countdown from the server end moment, corrected by the clock offset', () => {
  it('two devices with clocks 40 s apart reach zero at the same real moment', () => {
    const REAL_NOW = 1_800_000_000_000;
    const serverNow = REAL_NOW; // the server's clock is right
    const endsAt = serverNow + 90_000;
    const fastLocal = REAL_NOW + 40_000; // this device's clock runs ahead
    const slowLocal = REAL_NOW - 25_000; // and this one behind
    const fastOffset = clockOffset(serverNow, fastLocal);
    const slowOffset = clockOffset(serverNow, slowLocal);
    expect(msLeft(running(endsAt), fastLocal, fastOffset)).toBe(90_000);
    expect(msLeft(running(endsAt), slowLocal, slowOffset)).toBe(90_000);
    // 90 s later by the REAL clock (each device's own clock moved by 90 s):
    expect(msLeft(running(endsAt), fastLocal + 90_000, fastOffset)).toBe(0);
    expect(msLeft(running(endsAt), slowLocal + 90_000, slowOffset)).toBe(0);
  });

  it('a paused timer does not move with the clock', () => {
    expect(msLeft(paused(42_000), 123, 456)).toBe(42_000);
    expect(msLeft(paused(42_000), 9_999_999, 0)).toBe(42_000);
  });

  it('phases: running while time is left, finished at zero and after, paused from endsAt null', () => {
    expect(phaseOf(running(10_000), 0, 0)).toBe('running');
    expect(phaseOf(running(10_000), 9_999, 0)).toBe('running');
    expect(phaseOf(running(10_000), 10_000, 0)).toBe('finished');
    expect(phaseOf(paused(5_000), 0, 0)).toBe('paused');
  });

  it('a finished timer disappears from view when the server would have cleared it', () => {
    const t = running(1000);
    expect(isGone(t, 1000 + PAGE_TIMER_FINISHED_LINGER_MS - 1, 0)).toBe(false);
    expect(isGone(t, 1000 + PAGE_TIMER_FINISHED_LINGER_MS, 0)).toBe(true);
    expect(isGone(paused(1000), 10 ** 15, 0)).toBe(false);
  });
});

describe('the clock face', () => {
  it('rounds UP, so 00:00 appears exactly when the time is up', () => {
    expect(secondsShown(1)).toBe(1);
    expect(secondsShown(1000)).toBe(1);
    expect(secondsShown(1001)).toBe(2);
    expect(secondsShown(0)).toBe(0);
    expect(secondsShown(-500)).toBe(0);
    expect(formatClock(300_000)).toBe('05:00');
    expect(formatClock(299_001)).toBe('05:00');
    expect(formatClock(299_000)).toBe('04:59');
    expect(formatClock(9_000)).toBe('00:09');
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(PAGE_TIMER_MAX_MS)).toBe('3:00:00');
    expect(formatClock(3_661_000)).toBe('1:01:01');
  });

  it('re-renders on the beat: the delay lands just after the displayed second changes', () => {
    expect(nextBeatDelay(3500)).toBe(505);
    expect(nextBeatDelay(3000)).toBe(1005);
    expect(nextBeatDelay(2999)).toBe(1004);
    expect(nextBeatDelay(1)).toBe(6);
    for (const ms of [1, 999, 1000, 1001, 59_999, 60_000]) {
      const delay = nextBeatDelay(ms);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(1005);
      expect(secondsShown(ms - delay)).toBeLessThan(secondsShown(ms));
    }
  });
});

describe('custom time validation', () => {
  it('accepts minutes and/or seconds', () => {
    expect(parseCustomTime('2', '30')).toEqual({ ok: true, durationMs: 150_000 });
    expect(parseCustomTime('7', '')).toEqual({ ok: true, durationMs: 420_000 });
    expect(parseCustomTime('', '45')).toEqual({ ok: true, durationMs: 45_000 });
    expect(parseCustomTime(' 1 ', ' 90 ')).toEqual({ ok: true, durationMs: 150_000 });
    expect(parseCustomTime('180', '0')).toEqual({ ok: true, durationMs: PAGE_TIMER_MAX_MS });
  });

  it('refuses empty, zero, negative, fractional, textual and over-the-cap values', () => {
    for (const [m, s] of [['', ''], ['0', '0'], ['-1', '0'], ['1.5', ''], ['', '2.5'], ['abc', ''], ['1e3', ''], ['181', ''], ['180', '1'], ['', '10800'], ['', '10801'], ['99999', '']]) {
      expect(parseCustomTime(m, s), `${m}/${s}`).toEqual({ ok: false });
    }
  });
});
