// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ZOOM, ZOOM_STEPS, ZOOM_STORAGE_KEY, clampZoom, readStoredZoom, stepZoom, writeStoredZoom, zoomAppliesToKind, zoomKeyAction } from './compareZoom';

describe('compare zoom', () => {
  it('steps through the list and stops at both ends', () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(100, -1)).toBe(90);
    expect(stepZoom(125, 1)).toBe(125);
    expect(stepZoom(50, -1)).toBe(50);
    const walked = [50];
    while (walked[walked.length - 1] !== 125) walked.push(stepZoom(walked[walked.length - 1], 1));
    expect(walked).toEqual([...ZOOM_STEPS]);
  });

  it('moves from a value between steps to the nearest step in the direction asked', () => {
    expect(stepZoom(105, 1)).toBe(110);
    expect(stepZoom(105, -1)).toBe(100);
    expect(stepZoom(200, -1)).toBe(110);
  });

  it('clamps and refuses garbage', () => {
    expect(clampZoom(10)).toBe(50);
    expect(clampZoom(900)).toBe(125);
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ZOOM);
  });

  it('maps keys', () => {
    expect(zoomKeyAction('=')).toBe('in');
    expect(zoomKeyAction('+')).toBe('in');
    expect(zoomKeyAction('-')).toBe('out');
    expect(zoomKeyAction('0')).toBe('reset');
    expect(zoomKeyAction('a')).toBeNull();
  });

  it('applies the zoom to document-like kinds only', () => {
    for (const kind of ['doc', 'form', 'table', 'base', 'folder', undefined]) expect(zoomAppliesToKind(kind)).toBe(true);
    for (const kind of ['board', 'canvas', 'artifact', 'pdf', 'office']) expect(zoomAppliesToKind(kind)).toBe(false);
  });

  describe('storage', () => {
    beforeEach(() => localStorage.clear());

    it('round-trips and falls back to the default', () => {
      expect(readStoredZoom()).toBe(DEFAULT_ZOOM);
      writeStoredZoom(125);
      expect(readStoredZoom()).toBe(125);
      localStorage.setItem(ZOOM_STORAGE_KEY, 'abc');
      expect(readStoredZoom()).toBe(DEFAULT_ZOOM);
      localStorage.setItem(ZOOM_STORAGE_KEY, '9999');
      expect(readStoredZoom()).toBe(125);
    });
  });
});
