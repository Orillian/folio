import { describe, expect, it } from 'vitest';
import { extractNotes } from '../notes';
import { pinEnglish, render, withoutCode } from './render';

pinEnglish();

describe('reading: callouts (Obsidian and GitHub alike)', () => {
  it('keeps GitHub alerts exactly as they were', () => {
    const html = render('> [!NOTE]\n> remember this');
    expect(html).toBe(
      '<div class="md-alert md-alert-note" data-alert="note" data-callout="note" data-alert-label="Note" data-note-index="0">\n<p>remember this</p>\n</div>',
    );
  });

  it('reads any type in any case; the type stays in data-callout, the look folds onto the five', () => {
    const cases: Array<[string, string, string]> = [
      ['INFO', 'note', 'Info'],
      ['Tip', 'tip', 'Tip'],
      ['hint', 'tip', 'Hint'],
      ['important', 'important', 'Important'],
      ['Warning', 'warning', 'Warning'],
      ['danger', 'caution', 'Danger'],
      ['Bug', 'caution', 'Bug'],
      ['faq', 'note', 'Faq'],
      ['my-custom', 'note', 'My-custom'],
    ];
    for (const [written, kind, label] of cases) {
      const html = render(`> [!${written}]\n> body`);
      expect(html, written).toContain(`class="md-alert md-alert-${kind}"`);
      expect(html, written).toContain(`data-callout="${written.toLowerCase()}"`);
      expect(html, written).toContain(`data-alert-label="${label}"`);
      expect(html, written).not.toContain('[!');
    }
  });

  it('puts a title in a title row and drops the type label', () => {
    const html = render('> [!tip] Remember **this**\n> and that');
    expect(html).toContain('<div class="md-alert-title">Remember <strong>this</strong></div>');
    expect(html).toContain('<p>and that</p>');
    expect(html).not.toContain('data-alert-label');
  });

  it('makes a fold sign a details element: + open, - closed, the title in the summary', () => {
    const open = render('> [!faq]+ Is it open?\n> yes');
    expect(open).toContain('<details class="md-alert md-alert-note" data-alert="note" data-callout="faq" open');
    expect(open).toContain('<summary class="md-alert-title">Is it open?</summary>');
    const closed = render('> [!warning]-\n> hidden at first');
    expect(closed).toContain('<details class="md-alert md-alert-warning"');
    expect(closed).not.toContain(' open');
    expect(closed).toContain('<summary class="md-alert-title">Warning</summary>');
  });

  it('nests callouts and keeps their body markup', () => {
    const html = render('> [!info] Outer\n> text\n>\n> > [!danger]- Inner\n> > deep **bold**\n');
    expect(html).toContain('md-alert-note');
    expect(html).toContain('<details class="md-alert md-alert-caution"');
    expect(html).toContain('deep <strong>bold</strong>');
  });

  it('leaves a plain quote, a broken marker and a marker with trailing text alone', () => {
    expect(render('> just a quote')).toContain('<blockquote>');
    for (const broken of ['> [!note]x text', '> [!] x', '> !NOTE', '> [ !note]']) {
      const html = render(`${broken}\n> body`);
      expect(html, broken).toContain('<blockquote>');
      expect(html, broken).not.toContain('md-alert');
    }
  });

  it('numbers a foldable callout in the notes panel like any other', () => {
    const md = '> [!note] A\n\n> [!faq]- B\n> text\n\n- [ ] task\n';
    const html = render(md);
    expect(html.match(/data-note-index="\d+"/g)).toEqual(['data-note-index="0"', 'data-note-index="1"', 'data-note-index="2"']);
    expect(extractNotes(md).map((n) => [n.kind, n.text])).toEqual([
      ['note', 'A'],
      ['note', 'B'],
      ['task', 'task'],
    ]);
  });

  it('turns no callout marker inside code into anything', () => {
    const html = withoutCode(render('```\n> [!note]\n> x\n```\n'));
    expect(html).not.toContain('md-alert');
  });
});
