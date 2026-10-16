import { describe, expect, it } from 'vitest';
import {
  FIT_FILL,
  FIT_MAX_ZOOM,
  FIT_MIN_ZOOM,
  computeFitViewport,
  isCanvasMeasured,
  sceneBounds,
  viewportShowsContent,
} from './boardFit';

const box = (x: number, y: number, width: number, height: number, extra: object = {}) => ({ x, y, width, height, ...extra });

describe('sceneBounds', () => {
  it('spans the live elements and skips deleted ones', () => {
    expect(sceneBounds([box(10, 20, 100, 50), box(200, 300, 10, 10), box(-9999, -9999, 5, 5, { isDeleted: true })])).toEqual({
      minX: 10,
      minY: 20,
      maxX: 210,
      maxY: 310,
    });
  });

  it('is null for no elements, only deleted ones, or only elements without finite geometry', () => {
    expect(sceneBounds([])).toBeNull();
    expect(sceneBounds([box(0, 0, 5, 5, { isDeleted: true })])).toBeNull();
    expect(sceneBounds([box(NaN, 0, 5, 5), box(0, Infinity, 5, 5), { x: 1, y: 1 }])).toBeNull();
  });

  it('ignores one broken element instead of poisoning the whole box', () => {
    expect(sceneBounds([box(0, 0, 10, 10), box(NaN, 5, 5, 5)])).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  });

  it('treats a negative width/height as a valid box', () => {
    expect(sceneBounds([box(100, 100, -40, -30)])).toEqual({ minX: 60, minY: 70, maxX: 100, maxY: 100 });
  });
});

describe('computeFitViewport', () => {
  const size = { width: 1000, height: 800 };

  it('fits a large board exactly (no 10% step), centred', () => {
    const bounds = { minX: 0, minY: 0, maxX: 4000, maxY: 1000 };
    const vp = computeFitViewport(bounds, size)!;
    expect(vp.zoom).toBeCloseTo((1000 * FIT_FILL) / 4000, 6); // 0.23, where the library would floor to 0.2
    expect(vp.scrollX).toBeCloseTo(1000 / 2 / vp.zoom - 2000, 6);
    expect(vp.scrollY).toBeCloseTo(800 / 2 / vp.zoom - 500, 6);
  });

  it('never magnifies: a small board opens at 100%', () => {
    expect(computeFitViewport({ minX: 0, minY: 0, maxX: 120, maxY: 80 }, size)!.zoom).toBe(FIT_MAX_ZOOM);
  });

  // The 3000% on prod: a zero-size box divides by zero and the library clamps Infinity to its maximum.
  it.each([
    ['a single point', { minX: 50, minY: 50, maxX: 50, maxY: 50 }],
    ['a horizontal line', { minX: 0, minY: 10, maxX: 0, maxY: 10 }],
    ['a sub-pixel box', { minX: 0, minY: 0, maxX: 1e-9, maxY: 1e-9 }],
  ])('a degenerate extent (%s) opens at 100%, centred, not at the maximum zoom', (_label, bounds) => {
    const vp = computeFitViewport(bounds, size)!;
    expect(vp.zoom).toBe(1);
    expect(vp.scrollX).toBeCloseTo(500 - (bounds.minX + bounds.maxX) / 2, 6);
  });

  it('never goes below the library minimum however wide the board is', () => {
    expect(computeFitViewport({ minX: 0, minY: 0, maxX: 1e6, maxY: 10 }, size)!.zoom).toBe(FIT_MIN_ZOOM);
  });

  it('returns null while the canvas is not laid out (0x0, a sliver, NaN) or there is no content', () => {
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    expect(computeFitViewport(bounds, { width: 0, height: 0 })).toBeNull();
    expect(computeFitViewport(bounds, { width: 1000, height: 3 })).toBeNull();
    expect(computeFitViewport(bounds, { width: NaN, height: 800 })).toBeNull();
    expect(computeFitViewport(bounds, null)).toBeNull();
    expect(computeFitViewport(null, size)).toBeNull();
  });

  it('returns null rather than a non-finite viewport', () => {
    expect(computeFitViewport({ minX: 0, minY: 0, maxX: NaN, maxY: 10 }, size)).toBeNull();
    expect(computeFitViewport({ minX: -Infinity, minY: 0, maxX: Infinity, maxY: 10 }, size)).toBeNull();
  });
});

describe('isCanvasMeasured', () => {
  it('needs both sides at a real size', () => {
    expect(isCanvasMeasured({ width: 744, height: 712 })).toBe(true);
    expect(isCanvasMeasured({ width: 744, height: 0 })).toBe(false);
    expect(isCanvasMeasured(null)).toBe(false);
  });
});

describe('viewportShowsContent', () => {
  const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 500 };
  const size = { width: 800, height: 600 };

  it('accepts a viewport that overlaps the content', () => {
    expect(viewportShowsContent({ scrollX: 0, scrollY: 0, zoom: 1 }, bounds, size)).toBe(true);
    expect(viewportShowsContent({ scrollX: -900, scrollY: 0, zoom: 1 }, bounds, size)).toBe(true); // right edge of the board
  });

  it('rejects a viewport looking at empty space', () => {
    expect(viewportShowsContent({ scrollX: -5000, scrollY: 0, zoom: 1 }, bounds, size)).toBe(false);
    expect(viewportShowsContent({ scrollX: 0, scrollY: 9000, zoom: 1 }, bounds, size)).toBe(false);
  });

  it('judges by the visible scene area, i.e. zoom matters', () => {
    // at 20% the 800x600 canvas covers 4000x3000 scene units, so an offset that misses the board at 100% still reaches it
    expect(viewportShowsContent({ scrollX: 3000, scrollY: 0, zoom: 1 }, bounds, size)).toBe(false);
    expect(viewportShowsContent({ scrollX: 3000, scrollY: 0, zoom: 0.2 }, bounds, size)).toBe(true);
  });

  it('has nothing to contradict on an empty board', () => {
    expect(viewportShowsContent({ scrollX: 1e6, scrollY: 0, zoom: 1 }, null, size)).toBe(true);
  });
});
