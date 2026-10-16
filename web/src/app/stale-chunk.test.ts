// @vitest-environment jsdom
/**
 * A tab left open across a deploy fails to load a hashed chunk with one of a
 * handful of browser-specific messages — see stale-chunk.ts's doc comment
 * for the full story. These pin: which messages count as "stale chunk", that
 * an ordinary error does not, and that the reload guard fires exactly once
 * per failing chunk per minute (a real, persistent 404 must stop retrying and
 * let the caller show its own error text instead of reloading forever — and
 * rendering the shell must not reset that, 16.10.2026).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConnectivityForTests } from './offline/connectivity';
import {
  RELOAD_WINDOW_MS,
  isStaleChunkError,
  quietImport,
  resetStaleChunkStateForTests,
  shouldReportStaleChunk,
  staleChunkKey,
  tryReloadForStaleChunk,
} from './stale-chunk';

describe('isStaleChunkError', () => {
  it('recognizes every known browser wording', () => {
    expect(isStaleChunkError(new Error('Failed to fetch dynamically imported module: https://folio.example/assets/x.js'))).toBe(true);
    expect(isStaleChunkError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isStaleChunkError(new TypeError('Importing a module script failed'))).toBe(true);
    expect(isStaleChunkError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true);
    // A bare string (not wrapped in an Error) is accepted too — callers pass
    // both shapes (mermaid.render()'s rejection, vite:preloadError's payload).
    expect(isStaleChunkError('Failed to fetch dynamically imported module')).toBe(true);
  });

  it('does not fire on an ordinary error', () => {
    expect(isStaleChunkError(new Error('Parse error on line 3'))).toBe(false);
    expect(isStaleChunkError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
  });
});

const chunkError = (name: string) => new Error(`Failed to fetch dynamically imported module: https://folio.example/assets/${name}.js`);

describe('staleChunkKey', () => {
  it('is the chunk path when the message names it, ignoring origin and query', () => {
    expect(staleChunkKey(chunkError('Grid-abc12345'))).toBe('chunk:/assets/Grid-abc12345.js');
    expect(staleChunkKey(new Error('error loading dynamically imported module: /assets/Grid-abc12345.js?x=1'))).toBe('chunk:/assets/Grid-abc12345.js');
  });

  it('falls back to the running build when the browser names nothing (Safari)', () => {
    expect(staleChunkKey(new TypeError('Importing a module script failed.'))).toMatch(/^build:/);
  });
});

describe('tryReloadForStaleChunk', () => {
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
    resetStaleChunkStateForTests();
    resetConnectivityForTests();
    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetStaleChunkStateForTests();
  });

  /** What a reload does to the page: module state is gone, sessionStorage stays. */
  const reloadHappened = () => {
    const stored = sessionStorage.getItem('folio:stale-chunk-reloads');
    resetStaleChunkStateForTests();
    if (stored) sessionStorage.setItem('folio:stale-chunk-reloads', stored);
  };

  it('does nothing for a non-stale-chunk error', () => {
    expect(tryReloadForStaleChunk(new Error('boom'))).toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('first failure reloads once', () => {
    expect(tryReloadForStaleChunk(chunkError('Grid-a'))).toBe(true);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('several reports of the same failure while the page is leaving cause one reload and no error screen', () => {
    // vite:preloadError, then the boundary that caught the same rejection.
    expect(tryReloadForStaleChunk(chunkError('Grid-a'))).toBe(true);
    expect(tryReloadForStaleChunk(chunkError('Grid-a'))).toBe(true);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('the same chunk failing again after the reload, inside the window: no reload (error screen)', () => {
    expect(tryReloadForStaleChunk(chunkError('Grid-a'))).toBe(true);
    reloadHappened();
    vi.advanceTimersByTime(3_000);
    expect(tryReloadForStaleChunk(chunkError('Grid-a'))).toBe(false);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('a different chunk is independent', () => {
    expect(tryReloadForStaleChunk(chunkError('Grid-a'))).toBe(true);
    reloadHappened();
    expect(tryReloadForStaleChunk(chunkError('Board-b'))).toBe(true);
    expect(reloadSpy).toHaveBeenCalledTimes(2);
    reloadHappened();
    expect(tryReloadForStaleChunk(chunkError('Grid-a'))).toBe(false);
  });

  it('the guard is not cleared by anything but time: a render of the shell does not reset it', () => {
    expect(tryReloadForStaleChunk(chunkError('Grid-a'))).toBe(true);
    reloadHappened();
    // main.tsx used to clear the flag here ("we rendered"); nothing may.
    vi.advanceTimersByTime(RELOAD_WINDOW_MS - 1_000);
    expect(tryReloadForStaleChunk(chunkError('Grid-a'))).toBe(false);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('after the window a later failure may reload once more', () => {
    expect(tryReloadForStaleChunk(chunkError('Grid-a'))).toBe(true);
    reloadHappened();
    vi.advanceTimersByTime(RELOAD_WINDOW_MS + 1);
    expect(tryReloadForStaleChunk(chunkError('Grid-a'))).toBe(true);
    expect(reloadSpy).toHaveBeenCalledTimes(2);
  });

  it('caps reloads inside one window however many different chunks fail', () => {
    for (const name of ['a', 'b', 'c']) {
      expect(tryReloadForStaleChunk(chunkError(name))).toBe(true);
      reloadHappened();
    }
    expect(tryReloadForStaleChunk(chunkError('d'))).toBe(false);
    expect(reloadSpy).toHaveBeenCalledTimes(3);
  });

  it('survives unusable storage without throwing', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(tryReloadForStaleChunk(chunkError('Grid-a'))).toBe(true);
    spy.mockRestore();
  });

  // The owner, 29.09.2026: creating a board offline took the whole app off
  // the screen — the chunk could not be fetched, this guard read that as a
  // stale bundle and reloaded into the browser's "no internet" page.
  it('never reloads while offline: the chunk is unreachable, not stale', () => {
    const err = chunkError('Grid-a');
    resetConnectivityForTests({ state: 'offline' });
    expect(tryReloadForStaleChunk(err)).toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
    // …and the reload this chunk is allowed is still available once back online.
    resetConnectivityForTests();
    expect(tryReloadForStaleChunk(err)).toBe(true);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('a background import that fails reloads nobody and rejects nothing', async () => {
    const err = chunkError('Board-b');
    const result = await quietImport(async () => {
      // What vite:preloadError's listener would do while the import is in flight.
      expect(tryReloadForStaleChunk(err)).toBe(false);
      throw err;
    });
    expect(result).toBeUndefined();
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe('shouldReportStaleChunk', () => {
  beforeEach(() => resetStaleChunkStateForTests());

  it('says yes once per chunk, always yes for other errors', () => {
    expect(shouldReportStaleChunk(chunkError('Grid-a'))).toBe(true);
    expect(shouldReportStaleChunk(chunkError('Grid-a'))).toBe(false);
    expect(shouldReportStaleChunk(chunkError('Board-b'))).toBe(true);
    expect(shouldReportStaleChunk(new Error('boom'))).toBe(true);
    expect(shouldReportStaleChunk(new Error('boom'))).toBe(true);
  });
});
