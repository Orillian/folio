import { describe, expect, it } from 'vitest';
import { attachmentLookupFromLinks, WIKILINKS_PENDING } from '../wikilinks';
import { link, pinEnglish, ready, render } from './render';

pinEnglish();

describe('![[spec.pdf]] by name (a PDF is a page kind in the index)', () => {
  const pdf = link({ linkPath: 'spec.pdf', syntax: 'embed', kind: 'page', targetPageId: 'p-pdf', targetPath: 'attachments/spec.pdf' });
  const note = link({ linkPath: 'Note', syntax: 'wikilink', kind: 'page', targetPageId: 'p-note', targetPath: 'Note.md' });

  it('looks a page-kind file up, but never a note', () => {
    const lookup = attachmentLookupFromLinks([pdf, note]);
    expect(lookup('spec.pdf')).toBe('attachments/spec.pdf');
    expect(lookup('Note')).toBeUndefined();
  });

  it('serves the embed link from the resolved path', () => {
    expect(render('![[spec.pdf]]', ready([pdf]))).toContain('href="/files/eng/attachments/spec.pdf"');
  });
});

describe('no wasted request for a bare name while the links are pending', () => {
  it('leaves the img without a src until the index answered', () => {
    const html = render('![[diagram.png]]', { wikilinks: WIKILINKS_PENDING });
    expect(html).toContain('<img');
    expect(html).not.toContain('src=');
  });
  it('still resolves a path with a folder at once', () => {
    expect(render('![](img/a.png)', { wikilinks: WIKILINKS_PENDING })).toContain('src="/files/eng/notes/img/a.png"');
  });
});

describe('inline embeds transclude', () => {
  const note = link({ linkPath: 'Note', syntax: 'embed', kind: 'page', targetPageId: 'p-note', targetPath: 'Note.md' });
  it('splits the paragraph around an embed in the middle of a line', () => {
    const html = render('see ![[Note]] here', { ...ready([note]), embedsEnabled: true });
    expect(html).toContain('<p>see</p>');
    expect(html).toContain('data-folio-embed="p-note"');
    expect(html).toContain('<p>here</p>');
  });
  it('keeps a lone embed as it was', () => {
    expect(render('![[Note]]', { ...ready([note]), embedsEnabled: true })).not.toContain('<p>');
  });
});

describe('a wikilink alias that is a code span', () => {
  it('is a link whose text is code', () => {
    const l = link({ linkPath: 'Functions', syntax: 'wikilink', kind: 'page', targetPageId: 'p-f', targetPath: 'Functions.md', fragment: 'hasTag' });
    const html = render('see [[Functions#hasTag|`hasTag`]] ok', ready([l]));
    expect(html).toContain('<code>hasTag</code></a>');
    expect(html).not.toContain('[[');
  });
});

describe('callout marker followed by a no-break space', () => {
  it('is a callout with its title', () => {
    const html = render('> [!abstract] Title\n> body');
    expect(html).toContain('md-alert');
    expect(html).toContain('>Title<');
    expect(html).not.toContain('[!abstract]');
  });
});
