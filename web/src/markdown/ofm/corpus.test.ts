/**
 * Acceptance on the Obsidian help's Sandbox/Formatting notes (Obsidian vault
 * compatibility, wave 2): every note renders through the reading pipeline with
 * none of the Obsidian syntax left over as text. The corpus is not in the
 * repository (the help has no licence; see the brief) - the test looks for it
 * in `donors/obsidian/obsidian-help` of this checkout or of any parent of it
 * (a git worktree sits inside the main checkout), or in $OBSIDIAN_HELP_DIR, and
 * is skipped when it is not there. Nothing from it is copied anywhere.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pinEnglish, render, withoutCode } from './render';

pinEnglish();

function findFormattingDir(): string | null {
  const fromEnv = process.env.OBSIDIAN_HELP_DIR;
  if (fromEnv && existsSync(path.join(fromEnv, 'Sandbox', 'Formatting'))) return path.join(fromEnv, 'Sandbox', 'Formatting');
  let dir = import.meta.dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'donors', 'obsidian', 'obsidian-help', 'Sandbox', 'Formatting');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const corpus = findFormattingDir();

describe.skipIf(!corpus)('reading: the Obsidian Sandbox/Formatting notes', () => {
  const files = corpus ? readdirSync(corpus).filter((f) => f.endsWith('.md')) : [];

  it('finds the notes', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    it(`${file}: no raw wikilink, comment or callout marker is left`, () => {
      const markdown = readFileSync(path.join(corpus!, file), 'utf8');
      // Both ways: nothing can resolve a link (static text) and every embed is a placeholder.
      for (const options of [{}, { embedsEnabled: true, tagsClickable: true }]) {
        const visible = withoutCode(render(markdown, options));
        expect(visible, file).not.toContain('[[');
        expect(visible, file).not.toContain('%%');
        expect(visible, file).not.toMatch(/(^|\n)> \[!/);
        expect(visible, file).not.toMatch(/\[![A-Za-z]/);
      }
    });
  }
});
