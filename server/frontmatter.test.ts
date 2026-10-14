/**
 * server/frontmatter.ts — Folio edits only its own front matter keys (id,
 * order, status, icon, cover) and keeps every other key byte for byte: the
 * keys of Docusaurus/MkDocs/Hugo/Jekyll, their quoting, comments and lists.
 * Pure: no PG, no fs (see frontmatterPreserve.test.ts for the storage paths).
 */
import { describe, expect, it } from 'vitest';
import { mergeFrontmatter } from './frontmatter.js';

const FOREIGN = [
  '# Docusaurus page settings',
  'title: "Getting started: the basics"',
  "description: 'It''s quick'",
  'sidebar_position: 2',
  'slug: /getting-started',
  'tags:',
  '  - intro',
  '  - setup',
  'keywords: [docs, folio, "a, b"]',
  'authors:',
  '- name: Ann',
  '  url: https://example.com/ann # her site',
  'summary: |',
  '  First line.',
  '',
  '  Second paragraph.',
  'folded: >-',
  '  one',
  '  two',
  'nested:',
  '  deep:',
  '    value: 1',
  'date: 2024-01-02',
  'draft: false',
];

function file(lines: string[], body = '# Hello\n\nText.\n'): string {
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

describe('mergeFrontmatter', () => {
  it('adds Folio keys at the end of a foreign block and leaves every foreign line untouched', () => {
    const raw = file(FOREIGN);
    const out = mergeFrontmatter(raw, { id: 'ID1', icon: 'rocket' }, '# Hello\n\nText.\n');
    expect(out).toBe(file([...FOREIGN, 'id: ID1', 'icon: rocket']));
  });

  it('updates and removes a Folio key in place, keeping its position and everything around it', () => {
    const raw = file(['title: Hi', 'icon: cat', 'order: 3', 'tags: [a, b] # inline list', 'id: X']);
    const out = mergeFrontmatter(raw, { id: 'X', icon: 'dog' }, '# Hello\n\nText.\n');
    // order removed (undefined), icon replaced where it was, id unchanged (same value -> same spelling)
    expect(out).toBe(file(['title: Hi', 'icon: dog', 'tags: [a, b] # inline list', 'id: X']));
  });

  it('a save that changes nothing keeps the file byte-identical, the user’s own quoting of Folio keys included', () => {
    const raw = file(["id: '01ABC'", 'status: "draft"', ...FOREIGN]);
    expect(mergeFrontmatter(raw, { id: '01ABC', status: 'draft' }, '# Hello\n\nText.\n')).toBe(raw);
  });

  it('id: undefined leaves the file’s id alone; null removes it', () => {
    const raw = file(['title: T', 'id: KEEP']);
    expect(mergeFrontmatter(raw, {}, '# Hello\n\nText.\n')).toBe(raw);
    expect(mergeFrontmatter(raw, { id: null }, '# Hello\n\nText.\n')).toBe(file(['title: T']));
  });

  it('no block and nothing to write -> no block at all; Folio keys only -> a fresh block, id first', () => {
    expect(mergeFrontmatter('# Plain\n', {}, '# Plain\n')).toBe('# Plain\n');
    expect(mergeFrontmatter(undefined, {}, '# New')).toBe('# New\n');
    expect(mergeFrontmatter('# Plain\n', { id: 'N1', order: 2 }, '# Plain\n')).toBe('---\nid: N1\norder: 2\n---\n# Plain\n');
  });

  it('a block left empty by removing Folio’s only key disappears', () => {
    expect(mergeFrontmatter(file(['icon: 🚀']), {}, '# Hello\n')).toBe('# Hello\n');
  });

  it('a Folio key spelled as a block list (column-0 dashes) is replaced whole', () => {
    const raw = file(['title: T', 'status:', '- draft', 'tags:', '- a', '- b']);
    const out = mergeFrontmatter(raw, { status: 'published' }, '# Hello\n\nText.\n');
    expect(out).toBe(file(['title: T', 'status: published', 'tags:', '- a', '- b']));
  });

  it('keeps CRLF line endings of the block', () => {
    const raw = '---\r\ntitle: T\r\n---\r\n# Hello\r\n';
    expect(mergeFrontmatter(raw, { icon: 'x' }, '# Hello\r\n')).toBe('---\r\ntitle: T\r\nicon: x\r\n---\r\n# Hello\r\n');
  });

  it('an unparseable foreign block is kept verbatim; only the body changes', () => {
    const raw = '---\ntitle: Fix: login\n---\n# Old\n';
    expect(mergeFrontmatter(raw, { id: 'ID', icon: 'x' }, '# New\n')).toBe('---\ntitle: Fix: login\n---\n# New\n');
    // An unparseable file is edited as its raw text: the body already holds the block.
    expect(mergeFrontmatter(raw, { id: 'ID' }, '---\ntitle: Fix: login\n---\n# Edited\n')).toBe('---\ntitle: Fix: login\n---\n# Edited\n');
  });

  it("an unparseable block made only of Folio's keys is Folio's own and is rewritten", () => {
    const raw = '---\nid: A\nicon: : x\n---\n# Body\n';
    expect(mergeFrontmatter(raw, { id: 'A' }, '# Body\n')).toBe('---\nid: A\n---\n# Body\n');
  });

  it('never drops data even when the block cannot be edited line by line (falls back to a re-serialization)', () => {
    // A Folio key nested in a flow mapping on one line cannot be located as a top-level line.
    const raw = '---\n{title: T, icon: old}\n---\n# Body\n';
    const out = mergeFrontmatter(raw, { icon: 'new' }, '# Body\n');
    expect(out).toContain('title: T');
    expect(out).toContain('icon: new');
    expect(out).not.toContain('old');
  });
});
