/**
 * Padding around a selection, and pairs the parser refuses to read.
 *
 * The owner, 13.10.2026 ("Goals Q4 2026", Live edit): an item ended with
 * `*this is after we pick them *` — a star after a space. CommonMark does not
 * read that as emphasis, so Live showed both stars raw, while the I button was
 * lit (the old pairing took stars two by two and never asked whether the
 * parser would). Every inline button now keeps blanks outside its markers,
 * does nothing on a selection of blanks, reports "active" only for a pair the
 * parser accepts, and mends a broken pair instead of wrapping it again.
 */
import { describe, expect, it } from 'vitest';
import {
  INLINE_MARKS,
  applyFormatEdit,
  brokenRunsOf,
  formatActiveIn,
  highlightColorEdit,
  inlineFormatEdit,
  linkEdit,
  runsOf,
  type InlineFormat,
} from './format';

const FORMATS: InlineFormat[] = ['bold', 'italic', 'underline', 'strike', 'code', 'highlight'];

/** Apply an edit and mark the resulting selection with «…». */
function run(text: string, from: number, to: number, format: InlineFormat): string {
  const edit = inlineFormatEdit(text, from, to, format);
  const out = applyFormatEdit(text, edit);
  return `${out.slice(0, edit.selection.from)}«${out.slice(edit.selection.from, edit.selection.to)}»${out.slice(edit.selection.to)}`;
}

/** Select `[start, end)` of `text` by quoting the selected part: `a [word ]b`. */
function pick(marked: string): { text: string; from: number; to: number } {
  const from = marked.indexOf('[');
  const to = marked.indexOf(']') - 1;
  return { text: marked.replace('[', '').replace(']', ''), from, to };
}

describe('selection padding stays outside the markers (every inline button)', () => {
  for (const format of FORMATS) {
    const { open, close } = INLINE_MARKS[format];
    describe(format, () => {
      it('trailing blank', () => {
        const { text, from, to } = pick('a [word ]b');
        expect(run(text, from, to, format)).toBe(`a ${open}«word»${close} b`);
      });
      it('leading blank', () => {
        const { text, from, to } = pick('a[ word] b');
        expect(run(text, from, to, format)).toBe(`a ${open}«word»${close} b`);
      });
      it('blanks on both sides, several, and at the end of the line', () => {
        const { text, from, to } = pick('a[   two words  ]');
        expect(run(text, from, to, format)).toBe(`a   ${open}«two words»${close}  `);
      });
      it('tabs and no-break spaces count as blanks too', () => {
        const { text, from, to } = pick('a[\t word \t]b');
        expect(run(text, from, to, format)).toBe(`a\t ${open}«word»${close} \tb`);
      });
      it('does nothing when the selection is only blanks', () => {
        const text = 'a    b';
        const edit = inlineFormatEdit(text, 1, 4, format);
        expect(edit.changes).toEqual([]);
        expect(edit.selection).toEqual({ from: 1, to: 4 });
      });
    });
  }

  it('highlight colour keeps the padding outside, and ignores a blank selection', () => {
    const { text, from, to } = pick('a [word ]b');
    expect(applyFormatEdit(text, highlightColorEdit(text, from, to, 'green'))).toBe('a ==word=={.green} b');
    const blank = highlightColorEdit('a   b', 1, 4, 'green');
    expect(blank.changes).toEqual([]);
    expect(blank.selection).toEqual({ from: 1, to: 4 });
  });

  it('link keeps the padding outside the brackets, and ignores a blank selection', () => {
    const { text, from, to } = pick('a [word ]b');
    expect(applyFormatEdit(text, linkEdit(text, from, to))).toBe('a [word](url) b');
    const blank = linkEdit('a   b', 1, 4);
    expect(blank.changes).toEqual([]);
    expect(blank.selection).toEqual({ from: 1, to: 4 });
  });

  it('a caret still opens an empty pair', () => {
    expect(run('ab', 1, 1, 'italic')).toBe('a*«»*b');
  });
});

describe('a pair with a blank just inside a marker is not a run', () => {
  const TEXT = '- for 1-2 widgets we pick - *this is after we pick them *';

  it('is not reported as a run, so the button is not lit', () => {
    expect(runsOf(TEXT, 'italic')).toEqual([]);
    for (const at of [TEXT.indexOf('this') + 2, TEXT.length - 2, TEXT.length]) {
      expect(formatActiveIn(TEXT, at, at, 'italic')).toBe(false);
    }
    expect(formatActiveIn(TEXT, TEXT.indexOf('this'), TEXT.length, 'italic')).toBe(false);
  });

  it('is found as a broken pair', () => {
    const [broken] = brokenRunsOf(TEXT, 'italic');
    expect(TEXT.slice(broken.outerFrom, broken.outerTo)).toBe('*this is after we pick them *');
  });

  it('pressing the button with a caret inside mends it: *text* then the blank', () => {
    const at = TEXT.indexOf('after');
    const edit = inlineFormatEdit(TEXT, at, at, 'italic');
    const out = applyFormatEdit(TEXT, edit);
    expect(out).toBe('- for 1-2 widgets we pick - *this is after we pick them* ');
    expect(edit.selection).toEqual({ from: at, to: at });
    expect(formatActiveIn(out, at, at, 'italic')).toBe(true);
  });

  it('pressing it with the phrase (and its trailing blank) selected mends it too', () => {
    const from = TEXT.indexOf('this');
    const out = run(TEXT, from, TEXT.length, 'italic');
    expect(out).toBe('- for 1-2 widgets we pick - *«this is after we pick them»* ');
  });

  it('a second press takes the repaired italic off', () => {
    const fixed = '- a *this is after* ';
    const from = fixed.indexOf('this');
    expect(applyFormatEdit(fixed, inlineFormatEdit(fixed, from, from + 13, 'italic'))).toBe('- a this is after ');
  });

  it('works for a blank after the opening marker as well', () => {
    expect(run('a * word* b', 4, 8, 'italic')).toBe('a  *«word»* b');
  });

  for (const format of ['bold', 'strike', 'highlight', 'underline'] as const) {
    const { open, close } = INLINE_MARKS[format];
    it(`${format}: ${open}word ${close} is mended to ${open}word${close} `, () => {
      const text = `x ${open}word ${close}y`;
      expect(runsOf(text, format)).toEqual([]);
      expect(formatActiveIn(text, 5, 5, format)).toBe(false);
      const out = applyFormatEdit(text, inlineFormatEdit(text, 5, 5, format));
      expect(out).toBe(`x ${open}word${close} y`);
      expect(formatActiveIn(out, 5, 5, format)).toBe(true);
    });
  }

  it('keeps a highlight colour on the closer when it mends', () => {
    const text = 'x ==word =={.green}y';
    expect(applyFormatEdit(text, inlineFormatEdit(text, 5, 5, 'highlight'))).toBe('x ==word=={.green} y');
  });

  it('code has no such rule: a padded code span is a run', () => {
    expect(runsOf('a ` x ` b', 'code')).toHaveLength(1);
    expect(brokenRunsOf('a ` x ` b', 'code')).toEqual([]);
  });

  it('does not take a list bullet for a marker', () => {
    expect(brokenRunsOf('* item', 'italic')).toEqual([]);
    expect(brokenRunsOf('* 2 * 3', 'italic')).toEqual([]);
    expect(run('* item', 2, 6, 'italic')).toBe('* *«item»*');
  });

  it('a stray star before a real italic no longer swallows it', () => {
    const text = 'a * b *c* d';
    expect(runsOf(text, 'italic')).toHaveLength(1);
    expect(formatActiveIn(text, 7, 8, 'italic')).toBe(true);
    expect(formatActiveIn(text, 2, 2, 'italic')).toBe(false);
  });

  it('a valid pair still wins over everything: no repair on a real run', () => {
    const text = 'a *word* b';
    expect(brokenRunsOf(text, 'italic')).toEqual([]);
    expect(applyFormatEdit(text, inlineFormatEdit(text, 3, 7, 'italic'))).toBe('a word b');
  });
});
