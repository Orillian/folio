import { describe, expect, it } from 'vitest';
import { link, pinEnglish, ready, render } from './render';

pinEnglish();

describe('reading: wikilinks', () => {
  const links = [
    link({ linkPath: 'Note', syntax: 'wikilink', kind: 'page', targetPageId: 'P1' }),
    link({ linkPath: 'Note', syntax: 'wikilink', kind: 'page', targetPageId: 'P1', fragment: 'Some Heading', fragmentKind: 'heading', fragmentResolved: true }),
    link({ linkPath: 'Note', syntax: 'wikilink', kind: 'page', targetPageId: 'P1', fragment: '^blk-1', fragmentKind: 'block', fragmentResolved: true }),
    link({ linkPath: 'Ghost', syntax: 'wikilink', kind: 'unresolved', targetPath: 'Ghost.md' }),
    link({ linkPath: 'spec.pdf', syntax: 'wikilink', kind: 'asset', targetPath: 'notes/spec.pdf' }),
  ];

  it('links a resolved wikilink to the page, with the heading slug or the block id after #', () => {
    const html = render('See [[Note]], [[Note|the note]], [[Note#Some Heading]] and [[Note#^blk-1]].', ready(links));
    expect(html).toContain('href="/s/eng/p/P1" class="folio-wikilink" data-wikilink="Note" data-wikilink-state="page" data-folio-nav="/s/eng/p/P1">Note</a>');
    expect(html).toContain('>the note</a>');
    expect(html).toContain('data-folio-nav="/s/eng/p/P1#some-heading"');
    expect(html).toContain('>Note > Some Heading</a>');
    expect(html).toContain('data-folio-nav="/s/eng/p/P1#^blk-1"');
    expect(html).not.toContain('[[');
  });

  it('draws a link to a page that does not exist as dashed-unresolved, keeping the target for the create offer', () => {
    const html = render('[[Ghost]]', ready(links));
    expect(html).toContain('class="folio-wikilink folio-wikilink--unresolved"');
    expect(html).toContain('data-wikilink="Ghost"');
    expect(html).toContain('data-wikilink-state="unresolved"');
    expect(html).not.toContain('data-folio-nav');
  });

  it('makes a link to a file a file link', () => {
    const html = render('[[spec.pdf]]', ready(links));
    expect(html).toContain('href="/files/eng/notes/spec.pdf"');
    expect(html).toContain('target="_blank"');
  });

  it('uses the public site URL for a page of a public site', () => {
    const html = render('[[Note#Some Heading]]', { ...ready(links), pageUrl: (id) => `/public/eng/p/${id}` });
    expect(html).toContain('data-folio-nav="/public/eng/p/P1#some-heading"');
  });

  it('draws the words only while the answer is on its way, where none can come, or when the index has no row yet', () => {
    expect(render('[[Note]]', { wikilinks: { status: 'pending' } })).toContain('data-wikilink-state="pending"');
    expect(render('[[Note]]')).toContain('<span class="folio-wikilink folio-wikilink--static" data-wikilink="Note">Note</span>');
    expect(render('[[Brand new]]', ready(links))).toContain('folio-wikilink--static');
  });

  it('scrolls a link to a heading of this very page, and shows the heading as its text', () => {
    const html = render('[[#Some Heading]]');
    expect(html).toContain('data-wikilink-self="#some-heading"');
    expect(html).toContain('>Some Heading</a>');
  });

  it('reads an escaped pipe in a table cell and ignores escaped brackets and code', () => {
    const table = render('| a |\n|---|\n| [[Note\\|alias]] |', ready(links));
    expect(table).toContain('>alias</a>');
    const literal = render('\\[[Note]] and `[[Note]]`', ready(links));
    expect(literal).toContain('[[Note]] and <code>[[Note]]</code>');
    expect(literal).not.toContain('folio-wikilink');
  });

  it('does not take [[x]](url) for a wikilink', () => {
    const html = render('[[x]](https://e.com)');
    expect(html).not.toContain('folio-wikilink');
  });
});

describe('reading: embeds', () => {
  const links = [
    link({ linkPath: 'Other note', syntax: 'embed', kind: 'page', targetPageId: 'P2' }),
    link({ linkPath: 'Other note', syntax: 'embed', kind: 'page', targetPageId: 'P2', fragment: 'Part', fragmentKind: 'heading', fragmentResolved: true }),
    link({ linkPath: 'Lost', syntax: 'embed', kind: 'unresolved', targetPath: 'Lost.md' }),
  ];

  it('draws an image embed as an image with its width and height', () => {
    expect(render('![[photo.png|300]]')).toContain('<img src="/files/eng/notes/photo.png" alt="photo.png" width="300">');
    expect(render('![[assets/photo.png|300x200]]')).toContain('width="300" height="200"');
    expect(render('![[photo.png|a cat|120]]')).toContain('alt="a cat" width="120"');
    expect(render('![[photo.png]]')).not.toContain('width=');
  });

  it('links an embedded file instead of drawing it', () => {
    const html = render('![[report.pdf]]');
    expect(html).toContain('href="/files/eng/notes/report.pdf"');
    expect(html).toContain('>report.pdf</a>');
  });

  it('puts a placeholder where a note is embedded on its own line', () => {
    const html = render('before\n\n![[Other note]]\n\n![[Other note#Part]]\n\nafter', { ...ready(links), embedsEnabled: true });
    expect(html).toContain('<div class="folio-embed" data-wikilink="Other note" data-wikilink-embed="true" data-wikilink-state="page" data-folio-embed="P2" data-embed-label="Other note">Other note</div>');
    expect(html).toContain('data-folio-embed="P2" data-embed-fragment="Part"');
    expect(html).toContain('<p>before</p>');
    expect(html).toContain('<p>after</p>');
  });

  it('shows the name only where the note cannot be loaded or does not exist', () => {
    expect(render('![[Other note]]', { ...ready(links), embedsEnabled: false })).toContain('folio-embed folio-embed--static');
    expect(render('![[Lost]]', { ...ready(links), embedsEnabled: true })).toContain('folio-embed folio-embed--unresolved');
    expect(render('![[Other note]]')).toContain('folio-embed folio-embed--static');
  });

  it('transcludes a note embedded in the middle of a sentence, as a block between two paragraphs', () => {
    const html = render('see ![[Other note]] here', { ...ready(links), embedsEnabled: true });
    expect(html).toContain('<p>see</p>');
    expect(html).toContain('data-folio-embed="P2"');
    expect(html).toContain('<p>here</p>');
  });
});
