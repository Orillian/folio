import { describe, expect, it } from 'vitest';
import { substituteTemplate, todayDateStamp } from './templateVars.js';

describe('templateVars', () => {
  const vars = { date: '2026-10-19', author: 'Ann', title: 'Sync' };

  it('fills the three known placeholders, whitespace tolerated, every occurrence', () => {
    expect(substituteTemplate('{{date}} / {{ author }} / {{title}} / {{date}}', vars)).toBe('2026-10-19 / Ann / Sync / 2026-10-19');
  });

  it('leaves unknown placeholders alone', () => {
    expect(substituteTemplate('{{other}} {{ title }}', vars)).toBe('{{other}} Sync');
  });

  it('formats the local date as YYYY-MM-DD', () => {
    expect(todayDateStamp(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});
