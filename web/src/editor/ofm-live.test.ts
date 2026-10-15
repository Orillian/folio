/**
 * Obsidian constructs in the live editor (ofm-live.ts): what is decorated, where
 * its ranges are, and that nothing is ever folded. The grammar itself —
 * which text IS a comment, a wikilink, a tag, a formula — is tested where it
 * lives, in shared/ofm/scan.test.ts; these tests pin the editor's side: the
 * zones it hands the scanner from the Lezer tree and the ranges it decorates.
 */
import { Text } from '@codemirror/state';
import { GFM, parser } from '@lezer/markdown';
import { describe, expect, it } from 'vitest';
import { FolioHighlight } from './highlight-syntax';
import { computeInlineSpecs, type InlineSpec, type Span } from './live-decorations';
import { computeOfmSpecs, ofmClaims, ofmContains, ofmOwned, ofmOwns } from './ofm-live';
import { FolioUnderline } from './underline-syntax';

const md = parser.configure([GFM, FolioHighlight, FolioUnderline]);

/** Build the (doc, tree) snapshot the decoration computation works from. */
function snapshot(source: string, ranges?: Span[]) {
  const doc = Text.of(source.split('\n'));
  return {
    doc,
    tree: md.parse(source),
    selection: [{ from: 0, to: 0 }],
    ranges: ranges ?? [{ from: 0, to: doc.length }],
  };
}

const inline = (source: string, live = true, ranges?: Span[]): InlineSpec[] =>
  computeInlineSpecs({ ...snapshot(source, ranges), live });

/** Only what ofm-live.ts adds. */
const ofm = (source: string, ranges?: Span[]) => computeOfmSpecs({ ...snapshot(source, ranges), live: true });

type Mark = Extract<InlineSpec, { kind: 'mark' }>;

/** [class, covered text] of every mark ofm-live adds, in position order. */
const marks = (source: string, ranges?: Span[]): [string, string][] =>
  (ofm(source, ranges).specs.filter((spec): spec is Mark => spec.kind === 'mark') as Mark[])
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((spec) => [spec.cls, source.slice(spec.from, spec.to)]);

const ofmClasses = /cm-md-(comment|wikilink|embed|tag|math|blockid)/;

/** The text covered by marks of class `cls` (an exact match). */
const covered = (source: string, cls: string): string[] => marks(source).filter(([c]) => c === cls).map(([, text]) => text);

const hiddenOf = (specs: InlineSpec[], source: string) =>
  specs.filter((s) => s.kind === 'hide').map((s) => source.slice(s.from, s.to));

describe('comments', () => {
  it('marks an inline %% comment, delimiters included', () => {
    expect(marks('a %% hidden *x* %% b')).toEqual([['cm-md-comment', '%% hidden *x* %%']]);
  });

  it('marks a block comment as ONE range across lines and blank lines', () => {
    const src = 'before\n\n%%\nfirst\n\nsecond\n%%\n\nafter';
    expect(marks(src)).toEqual([['cm-md-comment', '%%\nfirst\n\nsecond\n%%']]);
  });

  it('leaves an unclosed %% as text and ignores %% in code', () => {
    expect(marks('a %% never closed')).toEqual([]);
    expect(marks('a `%% x %%` b')).toEqual([]);
    expect(marks('```\n%% x %%\n```')).toEqual([]);
    expect(marks('\\%% x %%')).toEqual([]);
  });

  it('swallows a link, a tag and a formula inside it: one mark, no inner ones', () => {
    expect(marks('%% see [[Note]] #tag $x$ ^id %%')).toEqual([['cm-md-comment', '%% see [[Note]] #tag $x$ ^id %%']]);
  });

  it('is drawn in source mode too', () => {
    const src = 'a %% c %% b';
    expect(inline(src, false).some((s) => s.kind === 'mark' && s.cls === 'cm-md-comment')).toBe(true);
  });
});

describe('wikilinks and embeds', () => {
  it('dims the brackets and colours the whole target of a plain link', () => {
    expect(marks('go [[Note]] now')).toEqual([
      ['cm-md-marker', '[['],
      ['cm-md-wikilink', 'Note'],
      ['cm-md-marker', ']]'],
    ]);
  });

  it('shows the alias as the link and dims the target and the bar', () => {
    expect(marks('[[Note|the alias]]')).toEqual([
      ['cm-md-marker', '[['],
      ['cm-md-marker', 'Note|'],
      ['cm-md-wikilink', 'the alias'],
      ['cm-md-marker', ']]'],
    ]);
  });

  it('trims the blanks around the label', () => {
    expect(covered('[[ Note | alias ]]', 'cm-md-wikilink')).toEqual(['alias']);
    expect(covered('[[  Note  ]]', 'cm-md-wikilink')).toEqual(['Note']);
  });

  it('keeps a heading or block fragment in the visible label when there is no alias', () => {
    expect(covered('[[Note#Heading]]', 'cm-md-wikilink')).toEqual(['Note#Heading']);
    expect(covered('[[Note#^blk]]', 'cm-md-wikilink')).toEqual(['Note#^blk']);
    expect(covered('[[#Self]]', 'cm-md-wikilink')).toEqual(['#Self']);
    expect(marks('[[Note#^blk|x]]')).toEqual([
      ['cm-md-marker', '[['],
      ['cm-md-marker', 'Note#^blk|'],
      ['cm-md-wikilink', 'x'],
      ['cm-md-marker', ']]'],
    ]);
  });

  it('reads the escaped pipe of a table cell as the alias bar', () => {
    const src = '| a | [[Note\\|alias]] |\n|---|---|\n| 1 | 2 |';
    expect(marks(src)).toEqual([
      ['cm-md-marker', '[['],
      ['cm-md-marker', 'Note\\|'],
      ['cm-md-wikilink', 'alias'],
      ['cm-md-marker', ']]'],
    ]);
  });

  it('treats an empty alias like no alias', () => {
    expect(covered('[[Note|]]', 'cm-md-wikilink')).toEqual(['Note|']);
  });

  it('marks an embed with `![[` as the opening marker and the target as the embed', () => {
    expect(marks('see ![[Other note]] here')).toEqual([
      ['cm-md-marker', '![['],
      ['cm-md-wikilink cm-md-embed', 'Other note'],
      ['cm-md-marker', ']]'],
    ]);
  });

  it('dims the size / alt part of an embed instead of presenting it as the label', () => {
    expect(marks('![[img.png|300]]')).toEqual([
      ['cm-md-marker', '![['],
      ['cm-md-wikilink cm-md-embed', 'img.png'],
      ['cm-md-marker', '|300'],
      ['cm-md-marker', ']]'],
    ]);
    expect(covered('![[Note#Heading]]', 'cm-md-wikilink cm-md-embed')).toEqual(['Note#Heading']);
  });

  it('is no wikilink when escaped, when it is the text of a markdown link, or in code', () => {
    expect(marks('\\[[x]] and [[y]](https://example.com)')).toEqual([]);
    expect(marks('`[[x]]`')).toEqual([]);
    expect(marks('```\n[[x]]\n```')).toEqual([]);
    expect(marks('<div>\n[[x]]\n</div>')).toEqual([]);
  });

  it('finds a wikilink inside emphasis, a heading, a list and a quote', () => {
    for (const src of ['**[[Note]]**', '# Title [[Note]]', '- [[Note]]', '> [[Note]]', '- [ ] [[Note]]']) {
      expect(covered(src, 'cm-md-wikilink'), src).toEqual(['Note']);
    }
  });
});

describe('wikilinks next to the generic link rule', () => {
  it('produces no fold and no link styling for `[[Note]]` (Lezer reads `[Note]` as a link)', () => {
    for (const live of [true, false]) {
      const specs = inline('go [[Note]] now', live);
      expect(specs.some((s) => s.kind === 'hide'), `live=${live}`).toBe(false);
      expect(specs.some((s) => s.kind === 'mark' && s.cls === 'cm-md-link'), `live=${live}`).toBe(false);
    }
  });

  it('does the same for aliases, embeds and links in a table cell', () => {
    for (const src of ['[[Note|alias]]', '![[img.png]]', '![[img.png|300]]', '[[Note#Heading]]', '| [[Note\\|a]] | b |\n|---|---|\n| 1 | 2 |']) {
      const specs = inline(src);
      expect(specs.some((s) => s.kind === 'hide'), src).toBe(false);
      expect(specs.some((s) => s.kind === 'mark' && s.cls === 'cm-md-link'), src).toBe(false);
    }
  });

  it('still folds an ordinary markdown link, also next to a wikilink', () => {
    const src = '[a](https://example.com) and [[Note]]';
    const specs = inline(src);
    expect(hiddenOf(specs, src)).toEqual(['[', '](https://example.com)']);
    expect(specs).toContainEqual({ kind: 'mark', from: 1, to: 2, cls: 'cm-md-link' });
  });

  it('decorates a wikilink in the text of a markdown link', () => {
    // Lezer reads the inner `[Note]` as the link and the outer brackets as text, so nothing folds.
    const src = '[see [[Note]] here](https://example.com)';
    expect(covered(src, 'cm-md-wikilink')).toEqual(['Note']);
    expect(hiddenOf(inline(src), src)).toEqual([]);
  });

  it('keeps the `[[x]](url)` form a markdown link', () => {
    const src = '[[x]](https://example.com)';
    expect(marks(src)).toEqual([]);
    expect(inline(src).some((s) => s.kind === 'hide')).toBe(true);
  });
});

describe('tags', () => {
  it('marks #tag and nested tags', () => {
    expect(marks('a #tag b #area/topic c')).toEqual([
      ['cm-md-tag', '#tag'],
      ['cm-md-tag', '#area/topic'],
    ]);
  });

  it('follows the index rule: a letter inside, no colours, a boundary before', () => {
    expect(covered('#123 #fff #a1b2c3 #tag1 a#b url/#frag', 'cm-md-tag')).toEqual(['#tag1']);
    expect(covered('#abc1 #Café #x_y-z', 'cm-md-tag')).toEqual(['#Café', '#x_y-z']);
  });

  it('is a tag at the start of a line and after the heading marker text', () => {
    expect(covered('#tag at the start', 'cm-md-tag')).toEqual(['#tag']);
    expect(covered('## Title #tag', 'cm-md-tag')).toEqual(['#tag']);
    // `# ` is a heading marker, `#Title` without the space is a tag.
    expect(covered('#Title', 'cm-md-tag')).toEqual(['#Title']);
  });

  it('is no tag in code, in a link, an image, an autolink or a reference', () => {
    const none = [
      '`#tag`',
      '```\n#tag\n```',
      '    #tag',
      '[a #tag b](https://example.com)',
      '![alt #tag](https://example.com/x.png)',
      '<https://example.com/#frag>',
      '<https://example.com/a#frag>',
      '[ref #tag]: https://example.com',
    ];
    for (const src of none) expect(covered(src, 'cm-md-tag'), src).toEqual([]);
    // Prose next to the link is still prose.
    expect(covered('[a](u) #tag', 'cm-md-tag')).toEqual(['#tag']);
  });

  it('is no tag inside the target of a wikilink', () => {
    expect(covered('[[Note #tag]]', 'cm-md-tag')).toEqual([]);
  });

  it('is no tag inside a raw HTML block', () => {
    expect(covered('<div>\n#tag\n</div>', 'cm-md-tag')).toEqual([]);
  });
});

describe('formulas', () => {
  it('marks an inline formula, delimiters included', () => {
    expect(marks('so $x^2 + y$ holds')).toEqual([['cm-md-math', '$x^2 + y$']]);
  });

  it('marks a display formula, across lines', () => {
    const src = 'a\n\n$$\n\\sum_i x_i\n$$\n\nb';
    expect(marks(src)).toEqual([['cm-md-math cm-md-math-display', '$$\n\\sum_i x_i\n$$']]);
    expect(marks('$$ x $$')).toEqual([['cm-md-math cm-md-math-display', '$$ x $$']]);
  });

  it('leaves prose with dollar signs alone', () => {
    expect(marks('it costs $5 and $6 today')).toEqual([]);
    expect(marks('a $ b $ c')).toEqual([]);
    expect(marks('\\$x\\$')).toEqual([]);
    expect(marks('one $ lonely')).toEqual([]);
  });

  it('ignores formulas in code', () => {
    expect(marks('`$x$`')).toEqual([]);
    expect(marks('```\n$x$\n```')).toEqual([]);
  });
});

describe('verbatim text: no fold inside a formula or a comment', () => {
  it('keeps the `*` of a formula and a comment visible in live mode', () => {
    const src = 'a $x*y*z$ and %% *c* %% b';
    const specs = inline(src);
    expect(hiddenOf(specs, src)).toEqual([]);
    expect(specs.some((s) => s.kind === 'mark' && s.cls === 'cm-md-marker')).toBe(false);
  });

  it('keeps folding emphasis that merely encloses a formula', () => {
    const src = '**bold $x$ bold**';
    expect(hiddenOf(inline(src), src)).toEqual(['**', '**']);
  });

  it('keeps the quote prefixes of a callout folded around a comment that spans its lines', () => {
    const src = '> [!note]\n> %%\n> hidden\n> %%\n> shown\n';
    expect(hiddenOf(inline(src), src)).toEqual(['> ', '> ', '> ', '> ', '> ']);
  });

  it('exposes the ranges the caret guards use', () => {
    const src = '[[Note]] $a$ %% b %% x';
    const { doc, tree } = snapshot(src);
    const owned = ofmOwned(doc, tree);
    expect(owned.wikilinks).toEqual([{ from: 0, to: 8 }]);
    expect(owned.opaque).toEqual([
      { from: 9, to: 12 },
      { from: 13, to: 20 },
    ]);
    expect(ofmOwns(owned, 1, 7)).toBe(true); // the `[Note]` Lezer sees inside the wikilink
    expect(ofmOwns(owned, 10, 11)).toBe(true); // inside the formula
    expect(ofmOwns(owned, 20, 22)).toBe(false);
  });
});

describe('block ids', () => {
  it('marks the ^id that ends a paragraph', () => {
    expect(marks('A paragraph of text. ^para-1')).toEqual([['cm-md-blockid', '^para-1']]);
  });

  it('marks it on a list item, a task and a quoted paragraph', () => {
    expect(covered('- item ^li', 'cm-md-blockid')).toEqual(['^li']);
    expect(covered('1. item ^ol', 'cm-md-blockid')).toEqual(['^ol']);
    expect(covered('- [ ] todo ^task', 'cm-md-blockid')).toEqual(['^task']);
    expect(covered('> quoted\n> text ^q', 'cm-md-blockid')).toEqual(['^q']);
    expect(covered('> text\n>^q', 'cm-md-blockid')).toEqual(['^q']);
  });

  it('marks an id that stands alone below a block, and one right after an embed', () => {
    expect(covered('| a | b |\n|---|---|\n| 1 | 2 |\n\n^table', 'cm-md-blockid')).toEqual(['^table']);
    expect(covered('![[img.png]]^img', 'cm-md-blockid')).toEqual(['^img']);
    expect(covered('line\n\n^only', 'cm-md-blockid')).toEqual(['^only']);
  });

  it('only counts the id at the END of the paragraph', () => {
    expect(covered('first ^a\nsecond line', 'cm-md-blockid')).toEqual([]);
    expect(covered('text ^id trailing', 'cm-md-blockid')).toEqual([]);
    expect(covered('word^id', 'cm-md-blockid')).toEqual([]);
    expect(covered('text ^bad_id', 'cm-md-blockid')).toEqual([]);
  });

  it('marks the id of the LAST line of a multi-line paragraph', () => {
    expect(covered('first line\nlast line ^end', 'cm-md-blockid')).toEqual(['^end']);
  });

  it('ignores code and an id that belongs to a comment', () => {
    expect(covered('```\ntext ^id\n```', 'cm-md-blockid')).toEqual([]);
    expect(covered('`text ^id`', 'cm-md-blockid')).toEqual([]);
    expect(covered('%%\ntext ^id\n\nmore\n%%', 'cm-md-blockid')).toEqual([]);
  });
});

describe('modes and visible ranges', () => {
  const src = 'See [[Note|alias]] ![[img.png|2]] #tag %% c %% $x$ ^id';

  it('decorates the same in live and source mode, and never hides', () => {
    const live = inline(src, true).filter((s) => s.kind === 'mark' && ofmClasses.test(s.cls));
    const source = inline(src, false).filter((s) => s.kind === 'mark' && ofmClasses.test(s.cls));
    expect(live.length).toBeGreaterThan(5);
    expect(source).toEqual(live);
    expect(inline(src, true).some((s) => s.kind === 'hide')).toBe(false);
    expect(inline(src, false).some((s) => s.kind === 'hide')).toBe(false);
    expect(ofm(src).specs.every((s) => s.kind === 'mark')).toBe(true);
  });

  it('emits a mark only for tokens in the visible ranges, but pairs %% over the whole document', () => {
    const doc = 'a %% first %%\n\nmiddle #mid\n\nz %% second %% #last';
    const tail = doc.indexOf('z %%');
    const visibleTail = marks(doc, [{ from: tail, to: doc.length }]);
    expect(visibleTail).toEqual([
      ['cm-md-comment', '%% second %%'],
      ['cm-md-tag', '#last'],
    ]);
    // An odd %% above the viewport flips the pairing below it — the scan has to see it.
    const flipped = '%% open\n\nmiddle\n\nx %% close %% y';
    const second = flipped.indexOf('x %%');
    expect(marks(flipped, [{ from: second, to: flipped.length }])).toEqual([['cm-md-comment', '%% open\n\nmiddle\n\nx %%']]);
  });

  it('emits a token that straddles the edge of a visible range once', () => {
    const doc = 'x %% a\nb %% y';
    expect(marks(doc, [{ from: 0, to: 5 }, { from: 7, to: doc.length }])).toEqual([['cm-md-comment', '%% a\nb %%']]);
  });

  it('does nothing for a document without any trigger character', () => {
    expect(ofm('plain text\n\nmore text').specs).toEqual([]);
    expect(ofm('').specs).toEqual([]);
  });

  it('gives the same answer from the per-tree cache', () => {
    const snap = snapshot(src);
    const first = computeOfmSpecs({ ...snap, live: true });
    const again = computeOfmSpecs({ ...snap, live: false });
    expect(again.specs).toEqual(first.specs);
  });

  it('never emits an empty or negative mark (CodeMirror would throw)', () => {
    const odd = ['[[ ]]', '[[|]]', '![[ |x]]', '%%%%', '$$ $$', '[[a|  ]]', '[[a\\|]]'];
    for (const source of odd) {
      for (const spec of ofm(source).specs) {
        if (spec.kind === 'mark') expect(spec.to, source).toBeGreaterThan(spec.from);
      }
    }
  });
});

describe('range helpers', () => {
  const spans = [
    { from: 2, to: 6 },
    { from: 10, to: 14 },
    { from: 20, to: 22 },
  ];

  it('ofmContains: wholly inside one span', () => {
    expect(ofmContains(spans, 3, 5)).toBe(true);
    expect(ofmContains(spans, 2, 6)).toBe(true);
    expect(ofmContains(spans, 5, 7)).toBe(false);
    expect(ofmContains(spans, 7, 9)).toBe(false);
    expect(ofmContains([], 0, 1)).toBe(false);
  });

  it('ofmClaims: any overlap except from an enclosing range', () => {
    expect(ofmClaims(spans, 3, 5)).toBe(true); // inside
    expect(ofmClaims(spans, 5, 8)).toBe(true); // partial
    expect(ofmClaims(spans, 1, 3)).toBe(true); // partial
    expect(ofmClaims(spans, 0, 20)).toBe(false); // encloses the first two spans and only touches the third
  });

  it('ofmClaims: a range enclosing a span on both sides is a bigger construct, not a claim', () => {
    expect(ofmClaims([{ from: 5, to: 9 }], 3, 12)).toBe(false);
    expect(ofmClaims([{ from: 5, to: 9 }], 5, 12)).toBe(true); // shares the start: it is the token itself
    expect(ofmClaims([{ from: 5, to: 9 }], 9, 12)).toBe(false); // only touches
    expect(ofmClaims(spans, 7, 9)).toBe(false);
  });
});
