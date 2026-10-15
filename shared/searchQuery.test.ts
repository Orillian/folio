import { describe, expect, it } from 'vitest';
import { emptySearchQuery, formatSearchQuery, isEmptySearchQuery, normalizePathPrefix, normalizeSearchTag, parseSearchQuery } from './searchQuery.js';

const ast = (patch: Partial<ReturnType<typeof emptySearchQuery>>) => ({ ...emptySearchQuery(), ...patch });

describe('parseSearchQuery', () => {
  it('splits plain words and keeps their case', () => {
    expect(parseSearchQuery('  Roadmap  Alpha ')).toEqual(ast({ words: ['Roadmap', 'Alpha'] }));
    expect(isEmptySearchQuery(parseSearchQuery('   '))).toBe(true);
    expect(isEmptySearchQuery(parseSearchQuery(''))).toBe(true);
  });

  it('reads quoted phrases, also an unterminated one, and ignores an empty pair', () => {
    expect(parseSearchQuery('deploy "rolling  update" now')).toEqual(ast({ words: ['deploy', 'now'], phrases: ['rolling update'] }));
    expect(parseSearchQuery('"never closed phrase')).toEqual(ast({ phrases: ['never closed phrase'] }));
    expect(parseSearchQuery('foo "" bar')).toEqual(ast({ words: ['foo', 'bar'] }));
  });

  it('reads exclusions of words and of phrases, but a hyphen inside a word is part of it', () => {
    expect(parseSearchQuery('deploy -draft -"old plan"')).toEqual(ast({ words: ['deploy'], excluded: ['draft', 'old plan'] }));
    expect(parseSearchQuery('well-known')).toEqual(ast({ words: ['well-known'] }));
    expect(parseSearchQuery('a - b')).toEqual(ast({ words: ['a', 'b'] }));
    expect(parseSearchQuery('-')).toEqual(emptySearchQuery());
  });

  it('reads tag: with hierarchy, a tolerated #, and any case; repeated tags are all kept', () => {
    expect(parseSearchQuery('tag:Project/Alpha TAG:#ideas tag:#/x//y/')).toEqual(ast({ tags: ['project/alpha', 'ideas', 'x/y'] }));
    expect(parseSearchQuery('tag:a tag:A')).toEqual(ast({ tags: ['a'] }));
  });

  it('reads kind: and status: as lists (comma, pipe or repeated), lowercased, unknown values dropped', () => {
    expect(parseSearchQuery('kind:doc,Table kind:board|pdf status:Draft status:archived')).toEqual(
      ast({ kinds: ['doc', 'table', 'board', 'pdf'], statuses: ['draft', 'archived'] }),
    );
    expect(parseSearchQuery('kind:doc,nonsense')).toEqual(ast({ kinds: ['doc'] }));
    // All values unknown: the token is just text.
    expect(parseSearchQuery('kind:nonsense status:soon')).toEqual(ast({ words: ['kind:nonsense', 'status:soon'] }));
  });

  it('normalizes in: to a folder prefix ending with a slash; the root names no filter', () => {
    expect(parseSearchQuery('in:docs in:./notes/2026 in:/guide/ in:"My Folder/"')).toEqual(ast({ pathPrefixes: ['docs/', 'notes/2026/', 'guide/', 'My Folder/'] }));
    expect(parseSearchQuery('in:/ in:.')).toEqual(emptySearchQuery());
    expect(normalizePathPrefix('a\\b')).toBe('a/b/');
  });

  it('reads prop:key=value and prop:key, with quotes around a value or a key, and keeps = inside the value', () => {
    expect(parseSearchQuery('prop:author=Ada prop:draft prop:title="Hello World" prop:"my key"=x prop:url=a=b')).toEqual(
      ast({
        props: [
          { key: 'author', value: 'Ada' },
          { key: 'draft' },
          { key: 'title', value: 'Hello World' },
          { key: 'my key', value: 'x' },
          { key: 'url', value: 'a=b' },
        ],
      }),
    );
    expect(parseSearchQuery('prop:empty=')).toEqual(ast({ props: [{ key: 'empty' }] }));
  });

  it('treats an unknown name:value token as a plain word, and drops an operator with no value', () => {
    expect(parseSearchQuery('foo:bar http://x.io/a:b')).toEqual(ast({ words: ['foo:bar', 'http://x.io/a:b'] }));
    expect(parseSearchQuery('tag: kind: in: prop: status:')).toEqual(emptySearchQuery());
  });

  it('drops tokens that hold neither a letter nor a digit', () => {
    expect(parseSearchQuery('a & b … c')).toEqual(ast({ words: ['a', 'b', 'c'] }));
  });

  it('combines everything', () => {
    expect(parseSearchQuery('release notes "q4 plan" -wip tag:team/core kind:doc status:published in:docs/ prop:owner=Ada')).toEqual({
      words: ['release', 'notes'],
      phrases: ['q4 plan'],
      excluded: ['wip'],
      tags: ['team/core'],
      kinds: ['doc'],
      statuses: ['published'],
      pathPrefixes: ['docs/'],
      props: [{ key: 'owner', value: 'Ada' }],
    });
  });

  it('negating an operator excludes its text — it is not a negated filter', () => {
    expect(parseSearchQuery('-tag:x')).toEqual(ast({ excluded: ['tag:x'] }));
  });

  it('keeps the work bounded: long input is cut, term lists are capped', () => {
    const many = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    expect(parseSearchQuery(many).words.length).toBeLessThanOrEqual(24);
    expect(parseSearchQuery('x'.repeat(5000)).words[0].length).toBeLessThanOrEqual(1000);
  });
});

describe('normalizeSearchTag', () => {
  it('matches the page parser: lowercase, no #, no doubled or edge slashes', () => {
    expect(normalizeSearchTag('#Project//Alpha/')).toBe('project/alpha');
    expect(normalizeSearchTag('  ##x ')).toBe('x');
  });
});

describe('formatSearchQuery', () => {
  const queries = [
    'plain words only',
    '"exact phrase" more',
    'deploy -draft -"old plan"',
    'tag:project/alpha tag:ideas',
    'kind:doc,table status:draft,archived',
    'in:docs/ in:"My Folder/"',
    'prop:author=Ada prop:flag prop:title="Hello World" prop:"my key"=x prop:url=a=b',
    'kind:nonsense foo:bar',
    'release "q4 plan" -wip tag:team/core kind:doc status:published in:docs/ prop:owner=Ada',
    '-tag:x',
    'well-known',
  ];
  it.each(queries)('round-trips %j', (q) => {
    const parsed = parseSearchQuery(q);
    expect(parseSearchQuery(formatSearchQuery(parsed))).toEqual(parsed);
  });

  it('prints a canonical text', () => {
    expect(formatSearchQuery(parseSearchQuery('TAG:#A kind:Doc -x "p q" w in:docs'))).toBe('w "p q" -x tag:a kind:doc in:docs/');
  });
});
