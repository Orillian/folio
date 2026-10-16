/**
 * Folio app URLs in the page index (pure): every form the UI writes or a reader
 * pastes — root-relative and absolute on the instance host, the space home, a
 * folder route, another space, an unknown id, fragments, query strings,
 * percent-encoding — and what stays external. Plus the chunked parse of big
 * bodies (markdownAst.ts) agreeing with the whole-body parse on what the index reads.
 */
import { describe, expect, it } from 'vitest';
import { parseChunks, parseMarkdownAst, parseMarkdownAstChunked, PARSE_CHUNK_CHARS } from '../markdownAst.js';
import { parsePageMeta } from './parse.js';
import { classifyLinkTarget, NO_PAGES, parseAppLink, type AppPageLookup, type PageLookup } from './resolve.js';

const HOST = 'folio.example.com';
const ID = '01M34CK3G0CHVQZ3RJP4QNACAG';

describe('parseAppLink', () => {
  it('root-relative page, space home and folder routes, with a trailing slash, a query or a fragment', () => {
    expect(parseAppLink(`/s/impl/p/${ID}`, HOST)).toEqual({ space: 'impl', kind: 'page', id: ID });
    expect(parseAppLink(`/s/impl/p/${ID}/`, HOST)).toEqual({ space: 'impl', kind: 'page', id: ID });
    expect(parseAppLink(`/s/impl/p/${ID}?v=2#intro`, HOST)).toEqual({ space: 'impl', kind: 'page', id: ID });
    expect(parseAppLink('/s/impl', HOST)).toEqual({ space: 'impl', kind: 'dir', dir: '' });
    expect(parseAppLink('/s/impl/', HOST)).toEqual({ space: 'impl', kind: 'dir', dir: '' });
    expect(parseAppLink('/s/impl/d/docs/guides/', HOST)).toEqual({ space: 'impl', kind: 'dir', dir: 'docs/guides' });
  });

  it('absolute URLs count only on the instance host (any case, any port, trailing dot); without a host only root-relative ones', () => {
    expect(parseAppLink(`https://${HOST}/s/impl/p/${ID}`, HOST)).toEqual({ space: 'impl', kind: 'page', id: ID });
    expect(parseAppLink(`http://FOLIO.example.com.:4870/s/impl`, HOST)).toEqual({ space: 'impl', kind: 'dir', dir: '' });
    expect(parseAppLink(`https://other.example.com/s/impl/p/${ID}`, HOST)).toBeNull();
    expect(parseAppLink(`https://${HOST}/s/impl/p/${ID}`, '')).toBeNull();
    expect(parseAppLink(`//${HOST}/s/impl/p/${ID}`, HOST)).toBeNull();
  });

  it('percent-encoded slugs, ids and folders are decoded; a malformed escape is no app link', () => {
    expect(parseAppLink('/s/my%20space/p/a%2Fb', HOST)).toEqual({ space: 'my space', kind: 'page', id: 'a/b' });
    expect(parseAppLink('/s/x/d/My%20Docs/%D0%BF%D0%BB%D0%B0%D0%BD', HOST)).toEqual({ space: 'x', kind: 'dir', dir: 'My Docs/план' });
    expect(parseAppLink('/s/x/p/%E0%A4%A', HOST)).toBeNull();
    expect(parseAppLink('/s/x/d/../../etc', HOST)).toBeNull();
  });

  it('other app routes, share and public links, files and plain paths are not page links', () => {
    for (const href of ['/s/impl/graph', '/s/impl/settings', '/share/tok123', `/share/tok123/p/${ID}`, `/public/site/p/${ID}`, '/files/impl/a.png', '/docs/x.md', 'docs/x.md', 'mailto:a@b.c']) {
      expect(parseAppLink(href, HOST), href).toBeNull();
    }
  });
});

describe('classifyLinkTarget for app links', () => {
  const app: AppPageLookup = {
    byId: (id) => (id === ID ? { space: 'impl', path: 'guides/setup.md' } : id === 'OTHER' ? { space: 'ops', path: 'runbook.md' } : null),
    dirPage: (space, dir) => (space === 'impl' && dir === '' ? { id: 'HOME', path: 'index.md' } : space === 'ops' && dir === 'team' ? { id: 'TEAM', path: 'team/index.md' } : null),
  };
  const pages: PageLookup = { ...NO_PAGES, space: 'impl', appHost: HOST, app };

  it('a page of this space by its path; another space by its route; the space home and a folder by their index page', () => {
    expect(classifyLinkTarget('md', `/s/impl/p/${ID}`, 'notes', pages)).toEqual({ kind: 'page', targetPath: 'guides/setup.md', targetPageId: ID });
    expect(classifyLinkTarget('html', `https://${HOST}/s/impl/p/${ID}?x=1`, '', pages)).toEqual({ kind: 'page', targetPath: 'guides/setup.md', targetPageId: ID });
    // the slug in the URL does not decide: the id does (a page that moved to another space keeps its links)
    expect(classifyLinkTarget('md', '/s/impl/p/OTHER', '', pages)).toEqual({ kind: 'page', targetPath: '/s/ops/p/OTHER', targetPageId: 'OTHER' });
    expect(classifyLinkTarget('reference', `https://${HOST}/s/impl`, '', pages)).toEqual({ kind: 'page', targetPath: 'index.md', targetPageId: 'HOME' });
    expect(classifyLinkTarget('md', '/s/ops/d/team', '', pages)).toEqual({ kind: 'page', targetPath: '/s/ops/p/TEAM', targetPageId: 'TEAM' });
  });

  it('an unknown id or home on our host is unresolved (as its route); another host stays external; at parse time it is provisionally unresolved', () => {
    expect(classifyLinkTarget('md', '/s/impl/p/NOPE', '', pages)).toEqual({ kind: 'unresolved', targetPath: '/s/impl/p/NOPE', targetPageId: null });
    expect(classifyLinkTarget('md', '/s/gone', '', pages)).toEqual({ kind: 'unresolved', targetPath: '/s/gone', targetPageId: null });
    expect(classifyLinkTarget('md', `https://elsewhere.example/s/impl/p/${ID}`, '', pages)).toEqual({ kind: 'external', targetPath: `https://elsewhere.example/s/impl/p/${ID}`, targetPageId: null });
    expect(classifyLinkTarget('md', '/share/tok', '', pages).kind).toBe('external');
    expect(classifyLinkTarget('md', `/s/impl/p/${ID}`, '', { ...NO_PAGES, space: 'impl', appHost: HOST })).toEqual({ kind: 'unresolved', targetPath: `/s/impl/p/${ID}`, targetPageId: null });
  });

  it('a wikilink is never read as an app URL', () => {
    expect(classifyLinkTarget('wikilink', `/s/impl/p/${ID}`, '', pages).kind).not.toBe('page');
  });
});

describe('parsePageMeta with app URLs', () => {
  it('splits the fragment of an app URL off like a relative link; keeps the query; records a pasted (bare) Folio URL, not other bare URLs', () => {
    const body = [
      `[a](/s/impl/p/${ID}#set-up) [b](https://${HOST}/s/impl/p/${ID}?tab=1#^blk) [c](https://example.com/page#x)`,
      '',
      `Pasted: https://${HOST}/s/impl/p/${ID} and https://example.com/x and <https://${HOST}/s/impl>`,
    ].join('\n');
    const links = parsePageMeta(body).links.map((l) => [l.linkPath, l.fragment, l.fragmentKind, l.fragmentKey, l.displayText, l.line]);
    expect(links).toEqual([
      [`/s/impl/p/${ID}`, 'set-up', 'heading', 'set-up', 'a', 1],
      [`https://${HOST}/s/impl/p/${ID}?tab=1`, '^blk', 'block', 'blk', 'b', 1],
      ['https://example.com/page#x', null, null, null, 'c', 1],
      [`https://${HOST}/s/impl/p/${ID}`, null, null, null, null, 3],
      [`https://${HOST}/s/impl`, null, null, null, null, 3],
    ]);
  });
});

describe('chunked parse of big bodies', () => {
  const unit = [
    '## Section {n}',
    '',
    'Text with [a link](notes/n{n}.md#part) and #tag-{n} and [ref][r{n}]. ^b{n}',
    '',
    '- item [[Wiki {n}]] #list',
    '  - nested `code #no`',
    '',
    '```js',
    '',
    'const x = "[not](a-link.md) #not-a-tag";',
    '',
    '```',
    '',
    '> quote [q](q{n}.md)',
    '',
    'Setext {n}',
    '---',
    '',
    '<!--',
    '',
    '[hidden](in-comment.md)',
    '',
    '-->',
    '',
  ].join('\n');
  const defs = Array.from({ length: 50 }, (_, n) => `[r${n}]: refs/r${n}.md`).join('\n');
  const body = Array.from({ length: 400 }, (_, n) => unit.replaceAll('{n}', String(n % 50))).join('') + '\n' + defs + '\n';

  it('cuts only at column-0 line starts, outside fences and HTML comments, in pieces of about PARSE_CHUNK_CHARS', () => {
    const chunks = parseChunks(body);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks[0][0]).toBe(0);
    expect(chunks[chunks.length - 1][1]).toBe(body.length);
    for (let i = 1; i < chunks.length; i++) {
      const at = chunks[i][0];
      expect(chunks[i - 1][1]).toBe(at);
      expect(body[at - 1]).toBe('\n');
      expect(body[at]).not.toMatch(/[ \t\n]/);
      expect(chunks[i - 1][1] - chunks[i - 1][0]).toBeLessThanOrEqual(PARSE_CHUNK_CHARS + unit.length + 100);
    }
    // never inside the fence: every cut leaves the fences balanced
    for (const [start] of chunks.slice(1)) expect((body.slice(0, start).match(/^```/gm) ?? []).length % 2).toBe(0);
  });

  it('finds the same headings, tags, block ids and links, on the same lines, as one whole-body parse', () => {
    const whole = parseMarkdownAst(body);
    const chunked = parseMarkdownAstChunked(body);
    expect(chunked.children.length).toBeGreaterThan(0);
    const types = (t: typeof whole) => t.children.map((c) => `${c.type}@${c.position?.start.line}:${c.position?.start.offset}`);
    expect(types(chunked)).toEqual(types(whole));
    const meta = parsePageMeta(body);
    expect(meta.links.some((l) => l.linkPath === 'in-comment.md' || l.linkPath === 'a-link.md')).toBe(false);
    expect(meta.links.filter((l) => l.syntax === 'reference')).toHaveLength(400);
    expect(meta.headings).toHaveLength(800);
    expect(meta.blocks).toHaveLength(400);
    expect(meta.tags.filter((t) => t.tag === 'list')).toHaveLength(400);
    expect(meta.tags.some((t) => t.tag === 'no' || t.tag === 'not-a-tag')).toBe(false);
    // line numbers are the body's
    const lines = body.split('\n');
    for (const l of meta.links) expect(lines[l.line - 1]).toContain(l.syntax === 'wikilink' ? `[[${l.linkPath}` : l.syntax === 'reference' ? '][r' : `](${l.linkPath}`);
  });

  it('a big GFM table keeps its links and tags (the rows after a cut read as paragraph text), in linear time', () => {
    const table = `| a | b |\n|---|---|\n${'| x | [l](t.md) #t |\n'.repeat(12_000)}`;
    const started = performance.now();
    const meta = parsePageMeta(table);
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(meta.links).toHaveLength(12_000);
    expect(meta.tags).toHaveLength(12_000);
    expect(meta.links[11_999].line).toBe(12_002);
  });
});
