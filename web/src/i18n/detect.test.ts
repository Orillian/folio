import { describe, expect, it } from 'vitest';
import { UI_LANGUAGES, toUiLanguage } from './languages';
import { pickInitialLanguage } from './index';

describe('interface languages', () => {
  it('are Ukrainian and English only, Ukrainian first', () => {
    expect([...UI_LANGUAGES]).toEqual(['uk', 'en']);
  });
});

describe('toUiLanguage', () => {
  it('accepts our two languages with or without a region, in any case', () => {
    expect(toUiLanguage('uk')).toBe('uk');
    expect(toUiLanguage('uk-UA')).toBe('uk');
    expect(toUiLanguage('EN-gb')).toBe('en');
  });

  it('maps Russian to Ukrainian', () => {
    expect(toUiLanguage('ru')).toBe('uk');
    expect(toUiLanguage('ru-RU')).toBe('uk');
  });

  it('rejects everything else', () => {
    expect(toUiLanguage('de-DE')).toBeNull();
    expect(toUiLanguage('')).toBeNull();
    expect(toUiLanguage(null)).toBeNull();
    expect(toUiLanguage(undefined)).toBeNull();
  });
});

describe('pickInitialLanguage', () => {
  it('prefers the saved choice, and a saved ru becomes uk', () => {
    expect(pickInitialLanguage('en', ['uk'])).toBe('en');
    expect(pickInitialLanguage('ru', ['en'])).toBe('uk');
  });

  it('reads the browser languages in order; a Russian browser gets Ukrainian', () => {
    expect(pickInitialLanguage(null, ['ru-RU', 'en-US'])).toBe('uk');
    expect(pickInitialLanguage(null, ['de-DE', 'en-US', 'uk'])).toBe('en');
    expect(pickInitialLanguage('xx', ['uk-UA'])).toBe('uk');
  });

  it('falls back to English when nothing matches', () => {
    expect(pickInitialLanguage(null, ['de-DE', 'fr'])).toBe('en');
    expect(pickInitialLanguage(null, [])).toBe('en');
  });
});
