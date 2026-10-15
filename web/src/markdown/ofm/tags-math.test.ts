import { describe, expect, it } from 'vitest';
import { pinEnglish, render } from './render';

pinEnglish();

describe('reading: #tags', () => {
  it('draws a tag as a chip carrying the normalized tag', () => {
    const html = render('Plan for #Q4 and #team/alpha today', { tagsClickable: true });
    expect(html).toContain('<a href="#" class="folio-tag" data-folio-tag="q4">#Q4</a>');
    expect(html).toContain('data-folio-tag="team/alpha">#team/alpha</a>');
  });

  it('follows the index rule: not a number, a colour, a fragment, code, a link or HTML', () => {
    const html = render(
      '#123 #fff #a1b2c3 a#b https://e.com/#frag `#code` [x #inlink](u) <b>#html</b>\n\n```\n#fenced\n```\n\n\\#escaped',
      { tagsClickable: true },
    );
    expect(html).not.toContain('folio-tag');
  });

  it('is a plain chip where clicking it has nowhere to go', () => {
    expect(render('#tag')).toContain('<span class="folio-tag folio-tag--static" data-folio-tag="tag">#tag</span>');
  });

  it('finds tags in a heading, a list item and a callout title', () => {
    expect(render('## Plan #q4', { tagsClickable: true })).toContain('data-folio-tag="q4"');
    expect(render('- item #q4', { tagsClickable: true })).toContain('data-folio-tag="q4"');
    expect(render('> [!tip] Idea #q4\n> body', { tagsClickable: true })).toContain('data-folio-tag="q4"');
  });
});

describe('reading: math', () => {
  it('carries inline TeX for KaTeX and shows it as text until then', () => {
    const html = render('Euler: $e^{i\\pi} + 1 = 0$ done');
    expect(html).toContain('<span class="folio-math" data-math="e^{i\\pi} + 1 = 0">$e^{i\\pi} + 1 = 0$</span>');
  });

  it('keeps TeX that markdown would mangle: emphasis marks, escapes, line breaks', () => {
    const html = render('$a*b*c$ and $\\{x\\}$');
    expect(html).toContain('data-math="a*b*c"');
    expect(html).toContain('data-math="\\{x\\}"');
    const display = render('$$\\begin{vmatrix}a & b\\\\\nc & d\n\\end{vmatrix}=ad-bc$$');
    expect(display).toContain('<div class="folio-math folio-math-display" data-math="\\begin{vmatrix}a &#x26; b\\\\\nc &#x26; d\n\\end{vmatrix}=ad-bc">');
  });

  it('draws a display formula standing alone as a block', () => {
    expect(render('$$x^2$$')).toBe('<div class="folio-math folio-math-display" data-math="x^2">$$x^2$$</div>');
  });

  it('leaves prices and code alone', () => {
    expect(render('It costs $5 and $6, between $5-$10.')).not.toContain('folio-math');
    expect(render('`$x$`')).toContain('<code>$x$</code>');
    expect(render('\\$x\\$')).not.toContain('folio-math');
  });
});
