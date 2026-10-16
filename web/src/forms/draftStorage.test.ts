// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DRAFT_MAX_AGE_MS, answersDraftKey, builderDraftKey, formatDraftTime, readDraft, removeDraft, writeDraft } from './draftStorage';

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe('draft keys', () => {
  it('isolates builder drafts per user and per form page', () => {
    const keys = new Set([
      builderDraftKey('p1', 'alice'),
      builderDraftKey('p1', 'bob'),
      builderDraftKey('p2', 'alice'),
      builderDraftKey('p1', undefined),
    ]);
    expect(keys.size).toBe(4);
  });

  it('isolates respondent answers per form and per who is filling (user / share token / embed)', () => {
    const keys = new Set([
      answersDraftKey('f1', 'u:alice'),
      answersDraftKey('f1', 'u:bob'),
      answersDraftKey('f2', 'u:alice'),
      answersDraftKey('f1', 't:tok'),
      answersDraftKey('f1', 'embed'),
    ]);
    expect(keys.size).toBe(5);
    expect(builderDraftKey('f1', 'alice')).not.toBe(answersDraftKey('f1', 'alice'));
  });
});

describe('readDraft / writeDraft / removeDraft', () => {
  it('round-trips data with its timestamp', () => {
    writeDraft('k', { a: 1 }, 1000);
    expect(readDraft<{ a: number }>('k', 2000)).toEqual({ savedAt: 1000, data: { a: 1 } });
    removeDraft('k');
    expect(readDraft('k')).toBeNull();
  });

  it('treats malformed JSON, a foreign shape and an abandoned (too old) draft as no draft', () => {
    window.localStorage.setItem('bad', '{nope');
    window.localStorage.setItem('shape', JSON.stringify({ v: 2, savedAt: 1, data: {} }));
    expect(readDraft('bad')).toBeNull();
    expect(readDraft('shape')).toBeNull();
    writeDraft('old', { a: 1 }, 1000);
    expect(readDraft('old', 1000 + DRAFT_MAX_AGE_MS + 1)).toBeNull();
    expect(window.localStorage.getItem('old')).toBeNull();
  });

  it('never throws when storage is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      expect(() => writeDraft('k', { a: 1 })).not.toThrow();
      expect(() => removeDraft('k')).not.toThrow();
      expect(readDraft('k')).toBeNull();
    } finally {
      Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('formatDraftTime', () => {
  it('shows only the time for today and adds the date otherwise', () => {
    const now = new Date(2026, 9, 16, 15, 0).getTime();
    const today = formatDraftTime(new Date(2026, 9, 16, 14, 5).getTime(), 'en', now);
    const earlier = formatDraftTime(new Date(2026, 9, 14, 14, 5).getTime(), 'en', now);
    expect(today).toMatch(/2:05|14:05/);
    expect(earlier.length).toBeGreaterThan(today.length);
  });
});
