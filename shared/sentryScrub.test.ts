import { describe, expect, it } from 'vitest';
import { scrubBreadcrumb, scrubEvent, scrubText, scrubUrl } from './sentryScrub.js';

describe('scrubUrl', () => {
  it('drops the query, the fragment and credentials', () => {
    expect(scrubUrl('https://wiki.example.com/s/eng/p/abc?share=TOKEN#x')).toBe('https://wiki.example.com/s/eng/p/abc');
    expect(scrubUrl('https://user:ghp_secret@github.com/org/repo.git')).toBe('https://github.com/org/repo.git');
    expect(scrubUrl('/s/eng?q=search words')).toBe('/s/eng');
  });
  it('hides tokens inside paths', () => {
    expect(scrubUrl('/share/AbC123/p/page1')).toBe('/share/[token]/p/page1');
    expect(scrubUrl('/invite/TKN')).toBe('/invite/[token]');
    expect(scrubUrl('https://h/api/share/TKN/board?x=1')).toBe('https://h/api/share/[token]/board');
  });
  it('leaves nothing for an empty value', () => {
    expect(scrubUrl('')).toBeUndefined();
    expect(scrubUrl(undefined)).toBeUndefined();
  });
});

describe('scrubText', () => {
  it('cleans URLs inside a sentence', () => {
    expect(scrubText('Failed GET https://h/api/x?token=ZZ now')).toBe('Failed GET https://h/api/x now');
  });
});

describe('scrubBreadcrumb', () => {
  it('drops console and input crumbs and cleans the URLs of the rest', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'x' })).toBeNull();
    expect(scrubBreadcrumb({ category: 'ui.input', message: 'typed' })).toBeNull();
    expect(scrubBreadcrumb({ category: 'fetch', data: { url: '/api/a?share=T', status_code: 200 } })).toEqual({ category: 'fetch', data: { url: '/api/a', status_code: 200 } });
  });

  it('keeps a click as its selector only: attribute values, element text and data are gone', () => {
    const out = scrubBreadcrumb({
      type: 'default',
      category: 'ui.click',
      message: 'div#root > button.save[aria-label="Delete Q3 plan"][title=\'Secret\']',
      data: { text: 'Q3 plan', nodeId: 4 },
      innerText: 'Q3 plan',
    } as never);
    expect(out).toEqual({ type: 'default', category: 'ui.click', message: 'div#root > button.save[aria-label][title]' });
    expect(JSON.stringify(out)).not.toMatch(/Q3|Secret/);
    expect(scrubBreadcrumb({ category: 'ui.click', message: 'x'.repeat(900) })?.message).toHaveLength(300);
  });
});

describe('scrubEvent', () => {
  it('keeps the user id only and a clean request', () => {
    const out = scrubEvent({
      user: { id: 7, email: 'a@b.c', username: 'x' },
      request: { url: 'https://h/s/a?q=1', headers: { Authorization: 'Bearer t', Cookie: 'c=1', 'User-Agent': 'UA' }, cookies: { a: 'b' }, data: 'body' },
    });
    expect(out.user).toEqual({ id: '7' });
    expect(out.request).toEqual({ url: 'https://h/s/a', headers: { 'User-Agent': 'UA' } });
  });
  it('drops an anonymous user entirely', () => {
    expect(scrubEvent({ user: { ip_address: '1.1.1.1' } }).user).toBeUndefined();
  });
});
