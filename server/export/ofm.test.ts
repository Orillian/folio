/**
 * Obsidian-flavoured markdown in the PDF and DOCX exports (wave 2): every
 * construct has a printable fallback - wikilink -> its words, embed ->
 * "[embedded: Note]", callout -> a quote headed by its title, `%%comments%%`
 * and `^block-id`s gone, tags as text, math as TeX in code - and an image
 * embed becomes a real image with an absolute URL. No database: the processors
 * under test are pure.
 */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { renderDocx } from './docx.js';
import { rewriteLinks } from './markdown.js';
import { buildPagePathIndex } from '../wikilinks.js';
import { markdownToHtml } from './print.js';

const FIXTURE = [
  '# Notes',
  '',
  'See [[Target note]], [[Target note|the alias]] and [[Target note#Some Heading]]. Tagged #plan/q4 here. %%a hidden remark%%',
  '',
  'Inline math $E = mc^2$ and a price of $5 and $6.',
  '',
  '$$',
  '\\int_0^1 x\\,dx',
  '$$',
  '',
  '![[Embedded note]]',
  '',
  '![[Embedded note#Part]]',
  '',
  '> [!warning]- Careful now',
  '> the body of the callout',
  '',
  '> [!NOTE]',
  '> plain alert',
  '',
  'A paragraph that can be linked to. ^para-1',
  '',
  '%%',
  'a block comment',
  '',
  'over two paragraphs',
  '%%',
  '',
  'The end.',
].join('\n');

describe('export: OFM through the print (PDF) processor', () => {
  it('turns every construct into printable text', async () => {
    const html = await markdownToHtml(FIXTURE);
    expect(html).toContain('See Target note, the alias and Target note > Some Heading.');
    expect(html).toContain('#plan/q4');
    expect(html).toContain('<code>$E = mc^2$</code>');
    expect(html).toContain('<pre><code class="language-tex">\\int_0^1 x\\,dx\n</code></pre>');
    expect(html).toContain('[embedded: Embedded note]');
    expect(html).toContain('[embedded: Embedded note > Part]');
    expect(html).toContain('<blockquote>\n<p><strong>Careful now</strong></p>\n<p>the body of the callout</p>\n</blockquote>');
    expect(html).toContain('<p><strong>Note</strong></p>');
    expect(html).toContain('<p>A paragraph that can be linked to.</p>');
    expect(html).toContain('<p>The end.</p>');
    expect(html).toContain('a price of $5 and $6.');
  });

  it('leaves no Obsidian syntax and no comment text behind', async () => {
    const html = await markdownToHtml(FIXTURE);
    for (const raw of ['[[', '%%', 'hidden remark', 'block comment', '^para-1', '[!warning]', '[!NOTE]']) {
      expect(html, raw).not.toContain(raw);
    }
  });
});

describe('export: OFM through the DOCX processor', () => {
  it('prints the same words into the document', async () => {
    const buf = await renderDocx({ markdown: FIXTURE, entry: { space: 'x', title: 'Notes' } as never, baseUrl: 'https://folio.example.com' });
    const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string');
    const text = xml.replace(/<[^>]+>/g, '').replace(/&gt;/g, '>');
    expect(text).toContain('See Target note, the alias and Target note > Some Heading.');
    expect(text).toContain('#plan/q4');
    expect(text).toContain('$E = mc^2$');
    expect(text).toContain('\\int_0^1 x\\,dx');
    expect(text).toContain('[embedded: Embedded note]');
    expect(text).toContain('Careful now');
    expect(text).toContain('the body of the callout');
    expect(text).toContain('A paragraph that can be linked to.');
    for (const raw of ['[[', '%%', 'hidden remark', 'block comment', '^para-1', '[!warning]']) {
      expect(text, raw).not.toContain(raw);
    }
  });
});

describe('export: image embeds', () => {
  const ctx = {
    baseUrl: 'https://folio.example.com',
    space: 'eng',
    dirPath: 'guides',
    idByPath: new Map<string, string>(),
    included: new Map(),
    ownAnchors: new Map<string, string>(),
  };

  it('become markdown images with absolute file URLs, relative to the page', () => {
    expect(rewriteLinks('x ![[photo.png|300]] y', ctx)).toBe('x ![photo.png|300](https://folio.example.com/files/eng/guides/photo.png) y');
    expect(rewriteLinks('![[../assets/a b.png|a cat|120]]', ctx)).toBe('![a cat|120](<https://folio.example.com/files/eng/assets/a b.png>)');
  });

  it('leave note embeds, wikilinks, code and fences alone', () => {
    expect(rewriteLinks('![[Some note]] and [[photo.png]]', ctx)).toBe('![[Some note]] and [[photo.png]]');
    expect(rewriteLinks('`![[photo.png]]`', ctx)).toBe('`![[photo.png]]`');
    expect(rewriteLinks('```\n![[photo.png]]\n```', ctx)).toBe('```\n![[photo.png]]\n```');
  });
});

describe('export: attachments resolved by name', () => {
  const paths = ['Attachments/x.png', 'guides/near.png'];
  const files = { has: (p: string) => paths.includes(p), wikiIndex: buildPagePathIndex(paths), isFolder: () => false };
  const ctx = {
    baseUrl: 'https://folio.example.com',
    space: 'eng',
    dirPath: 'guides',
    idByPath: new Map<string, string>(),
    included: new Map(),
    ownAnchors: new Map<string, string>(),
    files,
  };

  it('finds a markdown image and an image embed by name', () => {
    expect(rewriteLinks('![](x.png)', ctx)).toBe('![](https://folio.example.com/files/eng/Attachments/x.png)');
    expect(rewriteLinks('![[x.png]]', ctx)).toBe('![x.png](https://folio.example.com/files/eng/Attachments/x.png)');
  });

  it('keeps the path as written when a file is there or none is found', () => {
    expect(rewriteLinks('![](near.png)', ctx)).toBe('![](https://folio.example.com/files/eng/guides/near.png)');
    expect(rewriteLinks('![](missing.png)', ctx)).toBe('![](https://folio.example.com/files/eng/guides/missing.png)');
  });
});
