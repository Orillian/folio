import { describe, expect, it } from 'vitest';
import { pinEnglish, render } from './render';

pinEnglish();

describe('reading: %%comments%%', () => {
  it('hides an inline comment, markup inside it included', () => {
    const html = render('before %% a *hidden* [[link]] #tag %% after');
    expect(html).toBe('<p>before  after</p>');
  });

  it('hides a block comment that runs through several paragraphs', () => {
    const html = render('First\n\n%%\nnot for readers\n\nsecond hidden paragraph\n%%\n\nLast');
    expect(html).toContain('<p>First</p>');
    expect(html).toContain('<p>Last</p>');
    expect(html).not.toContain('hidden');
    expect(html).not.toContain('%%');
  });

  it('leaves no stray line break or empty paragraph behind', () => {
    expect(render('Visible text\n%%\nspanning\nlines\n%%')).toBe('<p>Visible text</p>');
    expect(render('%% only a comment %%')).toBe('');
    expect(render('Before\n\n%% only a comment %%\n\nAfter')).toBe('<p>Before</p>\n<p>After</p>');
  });

  it('hides a comment inside a quote, a list item and a table cell', () => {
    expect(render('> quote %% gone %% kept')).not.toContain('gone');
    expect(render('- item %% gone %% kept')).not.toContain('gone');
    const table = render('| a | b |\n|---|---|\n| x %% gone %% | y |');
    expect(table).not.toContain('gone');
    expect(table).toContain('<td>x </td>');
  });

  it('shows %% in code and an unclosed %% as text', () => {
    expect(render('`%% kept %%`')).toContain('<code>%% kept %%</code>');
    expect(render('```\n%% kept %%\n```')).toContain('%% kept %%');
    expect(render('open %% never closed')).toContain('open %% never closed');
    expect(render('\\%% not %% a comment')).toContain('%% not %% a comment');
  });
});

describe('reading: ^block-id', () => {
  it('hides the id and puts an anchor on the paragraph', () => {
    const html = render('A paragraph to link to. ^intro-1\n\nNext');
    expect(html).toContain('<p id="user-content-^intro-1">A paragraph to link to.</p>');
    expect(html).not.toContain('^intro-1</p>');
  });

  it('anchors a list item (not its paragraph, which a tight list does not draw)', () => {
    const html = render('- first ^item-a\n- second');
    expect(html).toContain('<li id="user-content-^item-a">first</li>');
  });

  it('puts the anchor of an id on its own line on the block above', () => {
    const html = render('| a |\n|---|\n| b |\n\n^table-id\n\nText');
    expect(html).toContain('id="user-content-^table-id"');
    expect(html).toContain('<table');
    expect(html).not.toContain('^table-id</p>');
    expect(html).toContain('<p>Text</p>');
  });

  it('leaves a caret that is not an id at the end of a paragraph alone', () => {
    expect(render('x^2 is a power')).toContain('x^2 is a power');
    expect(render('^not an id\nsecond line')).toContain('^not an id');
    expect(render('`code ^id`')).toContain('<code>code ^id</code>');
  });
});
