import { describe, expect, it } from 'vitest';
import { resolveAssetSrc } from '../../editor/paths';
import { attachmentLookupFromLinks } from '../wikilinks';
import { link, pinEnglish, ready, render } from './render';

pinEnglish();

const image = link({ linkPath: 'x.png', syntax: 'image', kind: 'asset', targetPath: 'Attachments/x.png' });
const embed = link({ linkPath: 'y.png', syntax: 'embed', kind: 'asset', targetPath: 'Attachments/y.png' });
const pdf = link({ linkPath: 'doc.pdf', syntax: 'wikilink', kind: 'asset', targetPath: 'Files/doc.pdf' });

describe('attachments resolved by name', () => {
  it('serves a markdown image from the path the index resolved', () => {
    expect(render('![](x.png)', ready([image]))).toContain('src="/files/eng/Attachments/x.png"');
  });

  it('serves an ![[image]] embed from the resolved path', () => {
    expect(render('![[y.png]]', ready([embed]))).toContain('src="/files/eng/Attachments/y.png"');
  });

  it('finds a src with a space by the path as written', () => {
    const spaced = link({ linkPath: 'my pic.png', syntax: 'image', kind: 'asset', targetPath: 'Attachments/my pic.png' });
    expect(render('![](<my pic.png>)', ready([spaced]))).toContain('/files/eng/Attachments/my pic.png');
  });

  it('serves a link to a file and a [[file]] wikilink from the resolved path', () => {
    const html = render('[manual](doc.pdf) and [[doc.pdf]]', ready([pdf, link({ linkPath: 'doc.pdf', syntax: 'md', kind: 'asset', targetPath: 'Files/doc.pdf' })]));
    expect(html.match(/href="\/files\/eng\/Files\/doc\.pdf"/g)).toHaveLength(2);
  });

  it('keeps the relative path when the index has no resolved attachment', () => {
    expect(render('![](x.png)')).toContain('src="/files/eng/notes/x.png"');
    expect(render('![](x.png)', ready([]))).toContain('src="/files/eng/notes/x.png"');
    const unresolved = link({ linkPath: 'x.png', syntax: 'image', kind: 'unresolved', targetPath: 'notes/x.png' });
    expect(render('![](x.png)', ready([unresolved]))).toContain('src="/files/eng/notes/x.png"');
  });

  it('keeps the share token on the resolved URL', () => {
    expect(render('![](x.png)', { ...ready([image]), shareToken: 't k' })).toContain('src="/files/eng/Attachments/x.png?share=t%20k"');
  });
});

describe('live editor src', () => {
  const lookup = attachmentLookupFromLinks([image]);
  it('uses the resolved path, else the page-relative one', () => {
    expect(resolveAssetSrc('x.png', 'eng', 'notes/page.md', undefined, lookup)).toBe('/files/eng/Attachments/x.png');
    expect(resolveAssetSrc('z.png', 'eng', 'notes/page.md', undefined, lookup)).toBe('/files/eng/notes/z.png');
    expect(resolveAssetSrc('x.png', 'eng', 'notes/page.md', 'tok', lookup)).toBe('/files/eng/Attachments/x.png?share=tok');
  });
});
