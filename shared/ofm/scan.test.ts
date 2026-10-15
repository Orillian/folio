import { describe, expect, it } from 'vitest';
import { scanOfm, maskText, isEscapedAt, type OfmToken } from './scan.js';
import { findTags, normalizeTag } from './tags.js';
import { matchBlockIdAtEnd } from './blockId.js';
import { embedTargetKind, fragmentInfo, parseImageEmbedAlias, splitWikilinkInner, wikilinkParts } from './wikilink.js';
import { calloutKind, matchCalloutLine, matchCalloutMarker } from './callout.js';

const kinds = (tokens: OfmToken[]) => tokens.map((t) => t.kind);
const texts = (src: string, tokens: OfmToken[]) => tokens.map((t) => src.slice(t.from, t.to));

describe('scanOfm: wikilinks and embeds', () => {
  it('finds every wikilink form with its parts', () => {
    const src = 'a [[Note]] b [[Note|alias]] c [[Note#Heading]] d [[Note#^blk|x]] e ![[img.png|300]] f [[#Self]]';
    const tokens = scanOfm(src);
    expect(texts(src, tokens)).toEqual(['[[Note]]', '[[Note|alias]]', '[[Note#Heading]]', '[[Note#^blk|x]]', '![[img.png|300]]', '[[#Self]]']);
    expect(tokens.map((t) => (t.kind === 'wikilink' ? [t.embed, t.path, t.fragment, t.alias] : null))).toEqual([
      [false, 'Note', null, null],
      [false, 'Note', null, 'alias'],
      [false, 'Note', 'Heading', null],
      [false, 'Note', '^blk', 'x'],
      [true, 'img.png', null, '300'],
      [false, '', 'Self', null],
    ]);
  });

  it('reads the escaped pipe of a table cell as the alias separator', () => {
    const t = scanOfm('| [[Note\\|alias]] |')[0];
    expect(t).toMatchObject({ kind: 'wikilink', path: 'Note', alias: 'alias' });
  });

  it('is not a wikilink when escaped, when it is the text of a markdown link, or inside code', () => {
    expect(scanOfm('\\[[x]] and [[y]](url)')).toEqual([]);
    const src = 'a `[[x]]` b [[y]]';
    expect(texts(src, scanOfm(src, { exclude: [[2, 9]] }))).toEqual(['[[y]]']);
  });
});

describe('scanOfm: comments', () => {
  it('pairs %% inline and across lines, and leaves an unclosed one as text', () => {
    const src = 'a %% b %% c\n\n%%\nblock\n\nmore\n%%\nz %% open';
    expect(texts(src, scanOfm(src))).toEqual(['%% b %%', '%%\nblock\n\nmore\n%%']);
  });

  it('hides what it contains: a link or a tag inside a comment is no token of its own', () => {
    const src = '%% [[x]] #tag $y$ %%';
    expect(kinds(scanOfm(src))).toEqual(['comment']);
  });

  it('ignores %% in code and escaped %%', () => {
    const src = '`%%` x %% y';
    expect(scanOfm(src, { exclude: [[0, 4]] })).toEqual([]);
    expect(scanOfm('\\%% x %%')).toEqual([]);
  });
});

describe('scanOfm: tags', () => {
  it('follows the index rule: after whitespace or a line start, a letter inside, no colours, not in links', () => {
    const src = '#a/b x #123 #fff #tag1 #abc1 a#b url/#frag #Café';
    expect(scanOfm(src).map((t) => (t.kind === 'tag' ? t.tag : null))).toEqual(['a/b', 'tag1', 'café']);
  });

  it('keeps tags out of the ranges it is told are links', () => {
    const src = '[a #t](u) #z';
    const tokens = scanOfm(src, { noTags: [[0, 9]] });
    expect(texts(src, tokens)).toEqual(['#z']);
  });

  it('is the same rule the index uses', () => {
    expect(normalizeTag('#Foo/Bar/')).toBe('foo/bar');
    expect(normalizeTag('#123')).toBeNull();
    expect(normalizeTag('#fff')).toBeNull();
    expect(findTags('x #t', undefined).map((m) => m.tag)).toEqual(['t']);
    expect(findTags('#t', 'a')).toEqual([]);
    expect(findTags('#t', undefined).map((m) => m.tag)).toEqual(['t']);
  });
});

describe('scanOfm: math', () => {
  it('finds inline and display formulas, TeX as written', () => {
    const src = 'a $x_i^2$ b\n\n$$\n\\frac{a}{b}\n$$';
    const math = scanOfm(src).filter((t) => t.kind === 'math');
    expect(math.map((t) => (t.kind === 'math' ? [t.tex, t.display] : null))).toEqual([
      ['x_i^2', false],
      ['\\frac{a}{b}', true],
    ]);
  });

  it('leaves dollar amounts alone', () => {
    expect(scanOfm('it costs $5 and $6, or $5-$10 in total')).toEqual([]);
    expect(texts('price $5 and $6 and $x$', scanOfm('price $5 and $6 and $x$'))).toEqual(['$x$']);
  });

  it('does not take an escaped dollar, an empty pair or a blank-line spanning formula', () => {
    expect(scanOfm('a \\$x\\$ b')).toEqual([]);
    expect(scanOfm('$ x $')).toEqual([]);
    expect(scanOfm('$$\na\n\nb\n$$')).toEqual([]);
  });
});

describe('scanOfm: overlaps and helpers', () => {
  it('lets the construct that starts first win', () => {
    const src = '$a #b$ and [[c #d]]';
    expect(kinds(scanOfm(src))).toEqual(['math', 'wikilink']);
  });

  it('masks ranges and counts backslashes', () => {
    expect(maskText('ab\ncd', [[1, 4]])).toBe('a\u0001\n\u0001d');
    expect(isEscapedAt('\\$', 1)).toBe(true);
    expect(isEscapedAt('\\\\$', 2)).toBe(false);
  });
});

describe('wikilink grammar', () => {
  it('splits the inside of a link', () => {
    expect(splitWikilinkInner('a#b|c')).toEqual({ pathRaw: 'a', fragmentPart: '#b', aliasPart: '|c' });
    expect(splitWikilinkInner('a\\|c')).toEqual({ pathRaw: 'a', fragmentPart: '', aliasPart: '\\|c' });
    expect(wikilinkParts(' Note #Head | al ')).toEqual({ path: 'Note', fragment: 'Head', alias: 'al' });
  });

  it('knows fragments, embed targets and image sizes', () => {
    expect(fragmentInfo('^Blk')).toEqual({ fragment: '^Blk', kind: 'block', key: 'blk' });
    expect(fragmentInfo('My Heading')).toEqual({ fragment: 'My Heading', kind: 'heading', key: 'my-heading' });
    expect(fragmentInfo('A#B C')).toMatchObject({ key: 'b-c' });
    expect(fragmentInfo(' ')).toBeNull();
    expect(embedTargetKind('a/img.PNG')).toBe('image');
    expect(embedTargetKind('doc.pdf')).toBe('file');
    expect(embedTargetKind('Note')).toBe('note');
    expect(embedTargetKind('Note.md')).toBe('note');
    expect(parseImageEmbedAlias('300')).toEqual({ alt: '', width: 300 });
    expect(parseImageEmbedAlias('300x200')).toEqual({ alt: '', width: 300, height: 200 });
    expect(parseImageEmbedAlias('my alt|120')).toEqual({ alt: 'my alt', width: 120 });
    expect(parseImageEmbedAlias('just alt')).toEqual({ alt: 'just alt' });
  });
});

describe('callout grammar', () => {
  it('reads any type, any case, the fold sign and the title', () => {
    expect(matchCalloutMarker('[!Info]- x')).toEqual({ type: 'info', fold: '-', length: 8 });
    expect(matchCalloutMarker('[!NOTE]\nbody')).toEqual({ type: 'note', fold: null, length: 7 });
    expect(matchCalloutMarker('[!my-custom]+')).toEqual({ type: 'my-custom', fold: '+', length: 13 });
    expect(matchCalloutMarker('[!note]x')).toBeNull();
    expect(matchCalloutMarker('[!]')).toBeNull();
    expect(matchCalloutLine('[!tip]+  A title  ')).toMatchObject({ type: 'tip', fold: '+', title: 'A title', titleFrom: 9 });
  });

  it('folds Obsidian types onto the five looks; unknown is a note', () => {
    expect(calloutKind('INFO')).toBe('note');
    expect(calloutKind('hint')).toBe('tip');
    expect(calloutKind('important')).toBe('important');
    expect(calloutKind('Caution')).toBe('caution');
    expect(calloutKind('danger')).toBe('caution');
    expect(calloutKind('whatever')).toBe('note');
  });
});

describe('block id grammar', () => {
  it('finds the id at the end of a paragraph', () => {
    expect(matchBlockIdAtEnd('text ^abc-1')).toEqual({ id: 'abc-1', index: 5 });
    expect(matchBlockIdAtEnd('^only')).toEqual({ id: 'only', index: 0 });
    expect(matchBlockIdAtEnd('![[x]]^id')).toMatchObject({ id: 'id' });
    expect(matchBlockIdAtEnd('a^b')).toBeNull();
    expect(matchBlockIdAtEnd('^abc more')).toBeNull();
  });
});
