import { describe, expect, it } from 'vitest';
import { inlineMarkdownToPlainText as plain } from './inlineText.js';

describe('inlineMarkdownToPlainText', () => {
  it('returns a title with no markup untouched (trimmed)', () => {
    expect(plain('  Goals Q4 2026 ')).toBe('Goals Q4 2026');
    expect(plain('Goals: Q4 2026')).toBe('Goals: Q4 2026');
    expect(plain('C++ and C++')).toBe('C++ and C++');
    expect(plain('1. Intro')).toBe('1. Intro');
    expect(plain('a == b == c')).toBe('a == b == c');
    expect(plain('List<T> guide')).toBe('List<T> guide');
  });

  it('resolves highlights, with and without a colour', () => {
    expect(plain('==SELECTED=={.green} Growth team in Ongoing')).toBe('SELECTED Growth team in Ongoing');
    expect(plain('==plain== text')).toBe('plain text');
    expect(plain('==a **b** c=={.red}')).toBe('a b c');
    expect(plain('**==x==** y')).toBe('x y');
  });

  it('resolves emphasis, strike, underline and code', () => {
    expect(plain('**bold** and *it* and _it_ and ~~gone~~ and ++under++')).toBe('bold and it and it and gone and under');
    expect(plain('use `npm run build` here')).toBe('use npm run build here');
  });

  it('resolves links to their text', () => {
    expect(plain('see [the guide](https://example.com/g) now')).toBe('see the guide now');
  });

  it('resolves status tags to their label', () => {
    expect(plain(':status[Ongoing]{color=green} Growth')).toBe('Ongoing Growth');
    expect(plain('Growth :status[Done]{color=blue}')).toBe('Growth Done');
    expect(plain(':status[**Go**]{color=red}')).toBe('Go');
  });

  it('resolves the legacy tags: <ins>, <u>, <mark>', () => {
    expect(plain('<ins>a</ins> <u>b</u> <mark>c</mark>')).toBe('a b c');
  });

  it('resolves escapes and character references', () => {
    expect(plain('\\*literal\\* and \\_under\\_')).toBe('*literal* and _under_');
    expect(plain('Tom &amp; Jerry')).toBe('Tom & Jerry');
  });

  it('takes an image as its alt text', () => {
    expect(plain('![logo](x.png) Title')).toBe('logo Title');
  });

  it('leaves a half-typed marker as the literal text it is', () => {
    expect(plain('**Bo')).toBe('**Bo');
    expect(plain('==open')).toBe('==open');
    expect(plain(':status[]{color=red}')).toBe(':status[]{color=red}');
  });
});
