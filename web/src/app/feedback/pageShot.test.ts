// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cropSourceRect, isCapturable, MIN_CROP_CSS_PX, REPORT_EXCLUDE_ATTR } from './pageShot';

const VIEW = { width: 1000, height: 500 };

describe('cropSourceRect', () => {
  it('maps a selection in CSS pixels to canvas pixels with the device pixel ratio', () => {
    const canvas = { width: 2000, height: 1000 }; // a 2x capture
    expect(cropSourceRect({ x: 100, y: 50, width: 300, height: 200 }, VIEW, canvas)).toEqual({ x: 200, y: 100, width: 600, height: 400 });
  });

  it('is 1:1 at a ratio of 1', () => {
    expect(cropSourceRect({ x: 10, y: 20, width: 100, height: 80 }, VIEW, VIEW)).toEqual({ x: 10, y: 20, width: 100, height: 80 });
  });

  it('normalises a selection dragged right-to-left and bottom-to-top', () => {
    expect(cropSourceRect({ x: 400, y: 250, width: -300, height: -200 }, VIEW, VIEW)).toEqual({ x: 100, y: 50, width: 300, height: 200 });
  });

  it('clamps a selection that leaves the image', () => {
    const canvas = { width: 1500, height: 750 }; // 1.5x
    expect(cropSourceRect({ x: -50, y: -50, width: 200, height: 150 }, VIEW, canvas)).toEqual({ x: 0, y: 0, width: 225, height: 150 });
    expect(cropSourceRect({ x: 900, y: 450, width: 400, height: 400 }, VIEW, canvas)).toEqual({ x: 1350, y: 675, width: 150, height: 75 });
  });

  it('never returns a rectangle outside the canvas, whatever the rounding', () => {
    const canvas = { width: 1333, height: 667 };
    const rect = cropSourceRect({ x: 333.3, y: 111.1, width: 666.7, height: 388.9 }, VIEW, canvas)!;
    expect(rect.x + rect.width).toBeLessThanOrEqual(canvas.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(canvas.height);
    expect(rect.width).toBeGreaterThan(0);
  });

  it('treats a stray click or a sliver as no selection', () => {
    expect(cropSourceRect({ x: 10, y: 10, width: 0, height: 0 }, VIEW, VIEW)).toBeNull();
    expect(cropSourceRect({ x: 10, y: 10, width: MIN_CROP_CSS_PX - 1, height: 200 }, VIEW, VIEW)).toBeNull();
    expect(cropSourceRect({ x: 10, y: 10, width: 200, height: MIN_CROP_CSS_PX - 1 }, VIEW, VIEW)).toBeNull();
    expect(cropSourceRect({ x: 10, y: 10, width: MIN_CROP_CSS_PX, height: MIN_CROP_CSS_PX }, VIEW, VIEW)).not.toBeNull();
  });

  it('counts only the part inside the image toward the minimum', () => {
    expect(cropSourceRect({ x: 995, y: 10, width: 100, height: 100 }, VIEW, VIEW)).toBeNull();
  });

  it('returns null for empty sizes', () => {
    expect(cropSourceRect({ x: 0, y: 0, width: 50, height: 50 }, { width: 0, height: 0 }, VIEW)).toBeNull();
  });
});

describe('isCapturable', () => {
  it('leaves out elements marked for exclusion and keeps everything else', () => {
    const marked = document.createElement('div');
    marked.setAttribute(REPORT_EXCLUDE_ATTR, '');
    expect(isCapturable(marked)).toBe(false);
    expect(isCapturable(document.createElement('div'))).toBe(true);
    expect(isCapturable(document.createTextNode('text'))).toBe(true);
  });
});
