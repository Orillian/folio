import { describe, expect, it } from 'vitest';
import { splitMermaidFences } from './mermaidSplit';

describe('```base fences (Obsidian Bases)', () => {
  it('a closed ```base fence becomes its own segment; an unterminated one stays text', () => {
    const md = '# Title\n\n```base\nfilters: file.hasTag("x")\n```\n\nafter\n';
    expect(splitMermaidFences(md)).toEqual([
      { type: 'text', value: '# Title\n' },
      { type: 'base', code: 'filters: file.hasTag("x")' },
      { type: 'text', value: '\nafter\n' },
    ]);
    expect(splitMermaidFences('```base\nviews: []\n').every((s) => s.type === 'text')).toBe(true);
    // Inside another fence it is just text (a doc explaining the syntax).
    expect(splitMermaidFences('````md\n```base\nx\n```\n````\n').every((s) => s.type === 'text')).toBe(true);
  });
});
