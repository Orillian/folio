import { describe, expect, it } from 'vitest';
import { folderDisplay, folderTitleMap } from './folderTitles';

const pages = [
  { path: 'index.md', title: 'Home' },
  { path: 'ai-sdlc/index.md', title: 'AI SDLC' },
  { path: 'ai-sdlc/prompts-library/README.md', title: 'Prompts library' },
  { path: 'ai-sdlc/prompts-library/a.md', title: 'A' },
  { path: 'checklists.md', title: 'Checklists' },
  { path: 'checklists/one.md', title: 'One' },
  { path: 'lonely/x.md', title: 'X' },
  { path: 'guide/index.md', title: 'Guide (index)' },
  { path: 'guide/README.md', title: 'Guide (readme)' },
  { path: 'plans.table.md', title: 'Plans table' },
  { path: 'plans/q1.md', title: 'Q1' },
  { path: 'dup.md', title: 'Dup one' },
  { path: 'dup.canvas', title: 'Dup two' },
  { path: 'dup/z.md', title: 'Z' },
];

describe('folderTitleMap / folderDisplay', () => {
  const titles = folderTitleMap(pages);

  it('an index.md or README.md is the page of its directory; index.md wins', () => {
    expect(titles.get('ai-sdlc')).toBe('AI SDLC');
    expect(titles.get('ai-sdlc/prompts-library')).toBe('Prompts library');
    expect(titles.get('guide')).toBe('Guide (index)');
  });

  it('a same-named page claims the directory, also with a kind suffix; an ambiguous claim is left out', () => {
    expect(titles.get('checklists')).toBe('Checklists');
    expect(titles.get('plans')).toBe('Plans table');
    expect(titles.has('dup')).toBe(false);
  });

  it('the root index page is the home, not a folder', () => {
    expect(titles.has('')).toBe(false);
  });

  it('nested paths are a breadcrumb of titles', () => {
    expect(folderDisplay('ai-sdlc/prompts-library', titles)).toBe('AI SDLC / Prompts library');
    expect(folderDisplay('ai-sdlc/', titles)).toBe('AI SDLC');
  });

  it('a segment without a page falls back to its slug; the root is null', () => {
    expect(folderDisplay('lonely', titles)).toBe('lonely');
    expect(folderDisplay('lonely/deep', titles)).toBe('lonely / deep');
    expect(folderDisplay('ai-sdlc/missing/x', titles)).toBe('AI SDLC / missing / x');
    expect(folderDisplay('', titles)).toBeNull();
    expect(folderDisplay('/', titles)).toBeNull();
  });
});
