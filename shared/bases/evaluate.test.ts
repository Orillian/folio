import { describe, expect, it } from 'vitest';
import { parseExpr, ExprSyntaxError, propertyRef } from './expr';
import { BaseEvalError, BaseUnsupportedError, isSafeRegex, makeBudget, rowEvaluator, unsupportedFunctionIn, type EvalEnv } from './evaluate';
import { BDate, BLink, dateIso, formatDate, parseDuration, type BaseRowData, type Value } from './values';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0); // 2026-10-16T12:00:00Z

function row(over: Partial<BaseRowData> = {}): BaseRowData {
  return {
    id: 'p1',
    path: 'projects/alpha.md',
    title: 'Alpha',
    kind: 'doc',
    size: 1234,
    mtime: Date.UTC(2026, 9, 10),
    ctime: Date.UTC(2026, 0, 1),
    properties: {
      status: 'in progress',
      price: 12.5,
      age: 5,
      due: '2026-10-20T00:00:00.000Z',
      tags: ['work', 'book/fiction'],
      author: '[[Ada Lovelace]]',
      done: false,
      first_name: 'Ada',
      last_name: 'Lovelace',
    },
    tags: ['work', 'book/fiction'],
    links: ['people/Ada Lovelace.md', 'Textbook.md'],
    ...over,
  };
}

const pages: BaseRowData[] = [
  row(),
  row({ id: 'ada', path: 'people/Ada Lovelace.md', title: 'Ada Lovelace', properties: { born: 1815 }, tags: [], links: [] }),
];

function env(over: Partial<EvalEnv> = {}): EvalEnv {
  return {
    formulas: {},
    dateKeys: new Set(['due']),
    thisRow: null,
    lookupFile: (t) => pages.find((p) => p.path === t || p.path.replace(/\.md$/, '').endsWith(t.replace(/\.md$/, ''))) ?? null,
    nowMs: NOW,
    budget: makeBudget(),
    ...over,
  };
}

function ev(src: string, r: BaseRowData = row(), e: Partial<EvalEnv> = {}): Value {
  return rowEvaluator(r, env(e)).eval(src);
}

describe('expression parser', () => {
  it('parses the Obsidian help examples', () => {
    for (const src of [
      'file.hasTag("tag")',
      'file.hasLink("Textbook")',
      'file.inFolder("Required Reading")',
      'if(price, price.toFixed(2) + " dollars")',
      '(price / age).toFixed(2)',
      'values.mean().round(3)',
      'status != "done"',
      'formula.ppu > 5',
      'price > 2.1',
      'start_date + "2w"',
      'if(due_date < now() && status != "Done", "Overdue", "")',
      '(impact * urgency) / effort',
      'tasks.length',
      'file.mtime > now() - "1 week"',
      'date("2024-12-01") + "1M" + "4h" + "3m"',
      '[1,2,3,4].filter(value > 2)',
      '"a:b:c:d".replace(/:/g, "-")',
      'note["my prop"] == 3',
      '!completed',
      'file.name + " - " + description',
      '{"a": 1}.keys()',
      '(-5).abs()',
      '5.isEmpty()',
    ]) {
      expect(() => parseExpr(src), src).not.toThrow();
    }
  });

  it('reports syntax errors with a position', () => {
    expect(() => parseExpr('status == ')).toThrow(ExprSyntaxError);
    expect(() => parseExpr('"unterminated')).toThrow(ExprSyntaxError);
    expect(() => parseExpr('a b')).toThrow(ExprSyntaxError);
  });

  it('writes property references', () => {
    expect(propertyRef('status')).toBe('status');
    expect(propertyRef('note.my prop')).toBe('note["my prop"]');
    expect(propertyRef('file.name')).toBe('file.name');
    expect(propertyRef('formula.ppu')).toBe('formula.ppu');
    expect(propertyRef('file')).toBe('note["file"]');
  });
});

describe('evaluator: properties and file fields', () => {
  it('reads note properties with and without the prefix', () => {
    expect(ev('status')).toBe('in progress');
    expect(ev('note.status')).toBe('in progress');
    expect(ev('note["status"]')).toBe('in progress');
    expect(ev('missing')).toBeNull();
  });

  it('reads file fields', () => {
    expect(ev('file.name')).toBe('alpha.md');
    expect(ev('file.basename')).toBe('alpha');
    expect(ev('file.ext')).toBe('md');
    expect(ev('file.folder')).toBe('projects');
    expect(ev('file.folder', row({ path: 'root.md' }))).toBe('/');
    expect(ev('file.size')).toBe(1234);
    expect(ev('file.tags')).toEqual(['work', 'book/fiction']);
  });

  it('file predicates', () => {
    expect(ev('file.hasTag("book")')).toBe(true); // nested tag
    expect(ev('file.hasTag("#Work")')).toBe(true);
    expect(ev('file.hasTag("nope", "work")')).toBe(true);
    expect(ev('file.hasTag("boo")')).toBe(false);
    expect(ev('file.inFolder("projects")')).toBe(true);
    expect(ev('file.inFolder("proj")')).toBe(false);
    expect(ev('file.inFolder("/")')).toBe(true);
    expect(ev('file.hasLink("Textbook")')).toBe(true);
    expect(ev('file.hasLink("[[Ada Lovelace]]")')).toBe(true);
    expect(ev('file.hasProperty("price")')).toBe(true);
    expect(ev('file.hasProperty("nope")')).toBe(false);
    expect(ev('taggedWith(file.file, "work")')).toBe(true);
    expect(ev('inFolder(file.file, "projects")')).toBe(true);
  });
});

describe('evaluator: operators', () => {
  it('arithmetic and precedence', () => {
    expect(ev('(price / age).toFixed(2)')).toBe('2.50');
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('7 % 3')).toBe(1);
    expect(ev('1 / 0')).toBeNull();
    expect(ev('missing + 1')).toBeNull();
    expect(ev('first_name + " " + last_name')).toBe('Ada Lovelace');
  });

  it('comparison and logic', () => {
    expect(ev('price > 2.1')).toBe(true);
    expect(ev('status != "done"')).toBe(true);
    expect(ev('status == "in progress" && price > 10')).toBe(true);
    expect(ev('done || age > 10')).toBe(false);
    expect(ev('!done')).toBe(true);
    expect(ev('missing > 3')).toBe(false);
    expect(ev('missing == null')).toBe(true);
  });

  it('links compare by target', () => {
    expect(ev('author')).toBeInstanceOf(BLink);
    expect(ev('author == "Ada Lovelace"')).toBe(true);
    expect(ev('author == link("people/Ada Lovelace")')).toBe(true);
    expect(ev('author.asFile().born')).toBe(1815);
    expect(ev('author.contains("Ada")')).toBe(true);
  });
});

describe('evaluator: dates', () => {
  it('reads index timestamps as dates', () => {
    const d = ev('due') as BDate;
    expect(d).toBeInstanceOf(BDate);
    expect(dateIso(d)).toBe('2026-10-20');
  });

  it('date arithmetic', () => {
    expect(dateIso(ev('date("2024-12-01") + "1M" + "4h" + "3m"') as BDate)).toBe('2025-01-01T04:03:00');
    expect(ev('(now() + "1d") - now()')).toBe(86_400_000);
    expect(ev('file.mtime > now() - "1 week"')).toBe(true);
    expect(ev('due < now()')).toBe(false);
    expect(ev('due > today()')).toBe(true);
    expect(dateIso(ev('today()') as BDate)).toBe('2026-10-16');
    expect(ev('due.format("YYYY-MM-DD")')).toBe('2026-10-20');
    expect(ev('due.year')).toBe(2026);
    expect(ev('due.month')).toBe(10);
    expect(ev('now().time()')).toBe('12:00:00');
    expect(ev('due.relative()')).toBe('in 4 days');
    expect(ev('if(due < now() && status != "Done", "Overdue", "")')).toBe('');
    expect(ev('if(due > now(), "Upcoming", "")')).toBe('Upcoming');
    expect(ev('due == "2026-10-20"')).toBe(true);
    expect(ev('due > "2026-10-01"')).toBe(true);
  });

  it('durations', () => {
    expect(parseDuration('1d')?.ms).toBe(86_400_000);
    expect(parseDuration('2 weeks')?.ms).toBe(14 * 86_400_000);
    expect(parseDuration('1M')?.months).toBe(1);
    expect(parseDuration('3m')?.ms).toBe(180_000);
    expect(parseDuration('nonsense')).toBeNull();
    expect(dateIso(ev('date("2024-01-31") + duration("1d") * 2') as BDate)).toBe('2024-02-02');
  });

  it('formats with moment tokens', () => {
    const d = new BDate(Date.UTC(2025, 4, 27, 14, 5, 9), true);
    expect(formatDate(d, 'YYYY-MM-DD HH:mm:ss')).toBe('2025-05-27 14:05:09');
    expect(formatDate(d, 'MMM D, YYYY [at] h:mm A')).toBe('May 27, 2025 at 2:05 PM');
    expect(formatDate(d, 'dddd Do')).toBe('Tuesday 27th');
  });
});

describe('evaluator: functions', () => {
  it('strings', () => {
    expect(ev('"hello".contains("ell")')).toBe(true);
    expect(ev('"hello".containsAll("h", "e")')).toBe(true);
    expect(ev('"hello".containsAny("x", "y", "e")')).toBe(true);
    expect(ev('"hello".endsWith("lo")')).toBe(true);
    expect(ev('"hello".startsWith("he")')).toBe(true);
    expect(ev('"".isEmpty()')).toBe(true);
    expect(ev('"Hello world".isEmpty()')).toBe(false);
    expect(ev('"ABC".lower()')).toBe('abc');
    expect(ev('"a:b:c:d".replace(/:/, "-")')).toBe('a-b:c:d');
    expect(ev('"a:b:c:d".replace(/:/g, "-")')).toBe('a-b-c-d');
    expect(ev('"John Smith".replace(/(\\w+) (\\w+)/, "$2, $1")')).toBe('Smith, John');
    expect(ev('"a:b:c".replace(":", "-")')).toBe('a-b-c');
    expect(ev('"123".repeat(2)')).toBe('123123');
    expect(ev('"hello".reverse()')).toBe('olleh');
    expect(ev('"hello".slice(1, 4)')).toBe('ell');
    expect(ev('"a,b,c,d".split(",", 3)')).toEqual(['a', 'b', 'c']);
    expect(ev('"hello world".title()')).toBe('Hello World');
    expect(ev('"  hi  ".trim()')).toBe('hi');
    expect(ev('"hello".length')).toBe(5);
  });

  it('numbers', () => {
    expect(ev('(-5).abs()')).toBe(5);
    expect(ev('(2.1).ceil()')).toBe(3);
    expect(ev('(2.9).floor()')).toBe(2);
    expect(ev('(2.5).round()')).toBe(3);
    expect(ev('(2.3333).round(2)')).toBe(2.33);
    expect(ev('(3.14159).toFixed(2)')).toBe('3.14');
    expect(ev('5.isEmpty()')).toBe(false);
    expect(ev('number("3.4")')).toBe(3.4);
    expect(ev('number(true)')).toBe(1);
    expect(ev('max(1, 5, 3)')).toBe(5);
    expect(ev('min(1, 5, 3)')).toBe(1);
  });

  it('lists', () => {
    expect(ev('[1,2,3].contains(2)')).toBe(true);
    expect(ev('[1,2,3].containsAll(2,3)')).toBe(true);
    expect(ev('[1,2,3].containsAny(3,4)')).toBe(true);
    expect(ev('[1,2,3,4].filter(value > 2)')).toEqual([3, 4]);
    expect(ev('[1,2,3,4].map(value + 1)')).toEqual([2, 3, 4, 5]);
    expect(ev('[1,2,3].reduce(acc + value, 0)')).toBe(6);
    expect(ev('[1,[2,3]].flat()')).toEqual([1, 2, 3]);
    expect(ev('[1,2,3].isEmpty()')).toBe(false);
    expect(ev('[1,2,3].join(",")')).toBe('1,2,3');
    expect(ev('[1,2,3].reverse()')).toEqual([3, 2, 1]);
    expect(ev('[1,2,3,4].slice(1,3)')).toEqual([2, 3]);
    expect(ev('[3, 1, 2].sort()')).toEqual([1, 2, 3]);
    expect(ev('["c", "a", "b"].sort()')).toEqual(['a', 'b', 'c']);
    expect(ev('[1,2,2,3].unique()')).toEqual([1, 2, 3]);
    expect(ev('tags.contains("work")')).toBe(true);
    expect(ev('tags.length')).toBe(2);
    expect(ev('list("value")')).toEqual(['value']);
    expect(ev('[1,2,3,4].mean()')).toBe(2.5);
    expect(ev('[1,2,3,4].median()')).toBe(2.5);
    expect(ev('property[0]', row({ properties: { property: ['x', 'y'] } }))).toBe('x');
    expect(ev('values.filter(value.isType("number")).reduce(if(acc == null || value > acc, value, acc), null)', row(), {})).toBeNull();
  });

  it('objects, regexps, any', () => {
    expect(ev('{"a": 1, "b": 2}.keys()')).toEqual(['a', 'b']);
    expect(ev('{}.isEmpty()')).toBe(true);
    expect(ev('/abc/.matches("abcde")')).toBe(true);
    expect(ev('1.isTruthy()')).toBe(true);
    expect(ev('"example".isType("string")')).toBe(true);
    expect(ev('true.isType("boolean")')).toBe(true);
    expect(ev('123.toString()')).toBe('123');
    expect(ev('missing.isEmpty()')).toBe(true);
    expect(ev('missing.contains("x")')).toBe(false);
    expect(ev('escapeHTML("<b>")')).toBe('&lt;b&gt;');
  });

  it('formulas reference formulas, cycles are errors', () => {
    const e = { formulas: { ppu: '(price / age).toFixed(2)', formatted_price: 'if(price, price.toFixed(2) + " dollars")', a: 'formula.b', b: 'formula.a', twice: 'formula.base * 2', base: 'age + 1' } };
    expect(ev('formula.ppu', row(), e)).toBe('2.50');
    expect(ev('formula.formatted_price', row(), e)).toBe('12.50 dollars');
    expect(ev('formula.twice', row(), e)).toBe(12);
    expect(() => ev('formula.a', row(), e)).toThrow(BaseEvalError);
    expect(ev('formula.nope', row(), e)).toBeNull();
  });

  it('this', () => {
    const thisRow = row({ id: 'base', path: 'projects/Projects.base', title: 'Projects', properties: { owner: 'me' } });
    expect(ev('this.file.folder', row(), { thisRow })).toBe('projects');
    expect(ev('file.inFolder(this.file.folder)', row(), { thisRow })).toBe(true);
    expect(ev('this.owner', row(), { thisRow })).toBe('me');
  });

  it('unsupported functions and type errors', () => {
    expect(unsupportedFunctionIn(parseExpr('html("<b>x</b>")'))).toBe('html()');
    expect(unsupportedFunctionIn(parseExpr('x.frobnicate()'))).toBe('.frobnicate()');
    expect(unsupportedFunctionIn(parseExpr('file.hasTag("x") && price.round(1) > 2'))).toBeNull();
    expect(() => ev('icon("x")')).toThrow(BaseUnsupportedError);
    expect(() => ev('done.toFixed(2)')).toThrow(BaseEvalError);
    expect(() => ev('date("not a date")')).toThrow(BaseEvalError);
  });

  it('refuses catastrophic regular expressions and stops at the budget', () => {
    expect(isSafeRegex('(a+)+$')).toBe(false);
    expect(isSafeRegex('(\\w+\\s?)*$')).toBe(false);
    expect(isSafeRegex('(a)\\1')).toBe(false);
    expect(isSafeRegex('^[a-z]+\\d{2}$')).toBe(true);
    expect(() => ev('/(a+)+$/.matches("aaaa")')).toThrow(BaseEvalError);
    expect(() => rowEvaluator(row(), env({ budget: { left: 50 } })).eval('[1,2,3,4,5,6,7,8,9,10].map(value * 2).map(value + 1).map(value)')).toThrow(/too expensive/);
  });
});
