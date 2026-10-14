// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  appPageUrl,
  publicBasePath,
  publicFileUrl,
  publicHomeUrl,
  publicPageUrl,
  publicUrlForAppPath,
  readHostSiteSlug,
} from './publicSite';

describe('public site URLs', () => {
  const path = { space: 'docs', mode: 'path' as const };
  const host = { space: 'docs', mode: 'host' as const };

  it('path mode lives under /public/<slug>', () => {
    expect(publicBasePath(path)).toBe('/public/docs');
    expect(publicHomeUrl(path)).toBe('/public/docs');
    expect(publicPageUrl(path, 'p1')).toBe('/public/docs/p/p1');
  });

  it('host mode is rooted at "/"', () => {
    expect(publicBasePath(host)).toBe('');
    expect(publicHomeUrl(host)).toBe('/');
    expect(publicPageUrl(host, 'p1')).toBe('/p/p1');
  });

  it('encodes what needs it', () => {
    expect(publicPageUrl(path, 'a/b c')).toBe('/public/docs/p/a%2Fb%20c');
    expect(publicFileUrl('docs', 'img/my shot #1.png')).toBe('/files/docs/img/my%20shot%20%231.png');
  });

  it('the sign-in link opens the same page in the app and opts out of the public redirect', () => {
    const site = { space: 'docs', instanceUrl: 'https://folio.example.com/' };
    expect(appPageUrl(site, 'p1')).toBe('https://folio.example.com/s/docs/p/p1?signin=1');
    expect(appPageUrl(site)).toBe('https://folio.example.com/s/docs?signin=1');
    expect(appPageUrl(site, null)).toBe('https://folio.example.com/s/docs?signin=1');
  });
});

describe('readHostSiteSlug', () => {
  it('reads the boot meta tag, and only when it has a value', () => {
    const doc = document.implementation.createHTMLDocument('x');
    expect(readHostSiteSlug(doc)).toBeNull();
    doc.head.innerHTML = '<meta name="folio-public-site" content="  ">';
    expect(readHostSiteSlug(doc)).toBeNull();
    doc.head.innerHTML = '<meta name="folio-public-site" content="docs">';
    expect(readHostSiteSlug(doc)).toBe('docs');
  });
});

describe('publicUrlForAppPath', () => {
  it('recognizes the app URLs of a space and of one of its pages', () => {
    expect(publicUrlForAppPath('/s/docs')).toEqual({ space: 'docs', pageId: null });
    expect(publicUrlForAppPath('/s/docs/p/abc')).toEqual({ space: 'docs', pageId: 'abc' });
    expect(publicUrlForAppPath('/s/docs/d/some/folder')).toEqual({ space: 'docs', pageId: null });
    expect(publicUrlForAppPath('/s/my%20space/p/a%2Fb')).toEqual({ space: 'my space', pageId: 'a/b' });
  });

  it('ignores every other path', () => {
    expect(publicUrlForAppPath('/')).toBeNull();
    expect(publicUrlForAppPath('/admin/access')).toBeNull();
    expect(publicUrlForAppPath('/public/docs')).toBeNull();
    expect(publicUrlForAppPath('/spaces/docs')).toBeNull();
  });
});
