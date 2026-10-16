import { describe, expect, it } from 'vitest';
import * as yamlNS from 'js-yaml';
import { parseBaseConfig } from './parse';
import { runBase } from './engine';
import { makeBudget } from './evaluate';
import { serializeBaseConfig, updateBaseSource } from './writer';
import { fromFilterNode, parseStatement, printRule, toFilterNode } from './filterModel';
import { baseConfigFromSearch, searchToBaseFilters } from './fromSearch';
import { parseSearchQuery } from '../searchQuery';
import type { BaseRowData } from './values';
import type { BaseConfig } from './types';

const yaml = ((yamlNS as unknown as { default?: typeof yamlNS }).default ?? yamlNS) as typeof yamlNS;

/** The example of obsidian-help/en/Bases/Bases syntax.md, verbatim. */
const HELP_EXAMPLE = `filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
  formula.formatted_price:
    displayName: "Price"
  file.ext:
    displayName: Extension
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    filters:
      and:
        - 'status != "done"'
        - or:
            - "formula.ppu > 5"
            - "price > 2.1"
    order:
      - file.name
      - file.ext
      - note.age
      - formula.ppu
      - formula.formatted_price
    summaries:
      formula.ppu: Average
`;

/** What Obsidian's CSV importer writes (obsidian-importer/src/formats/csv.ts). */
const CSV_IMPORTER = `filters: file.folder == "Imports/books"
views:
  - type: table
    name: Table
    order:
      - file.name
      - author
      - year
`;

const KANBAN = `views:
  - type: kanban
    name: Projects
    groupBy:
      property: note.status
      direction: ASC
    groupOrder:
      - Planned
      - In progress
      - Done
`;

const NOW = Date.UTC(2026, 9, 16, 12);

function page(id: string, path: string, properties: Record<string, unknown>, tags: string[] = [], links: string[] = []): BaseRowData {
  return { id, path, title: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''), kind: 'doc', size: 100, mtime: NOW - 86_400_000, ctime: null, properties, tags, links };
}

const ROWS: BaseRowData[] = [
  page('a', 'books/A.md', { status: 'todo', price: 10, age: 1, owner: 'ann' }, ['book'], ['Textbook.md']),
  page('b', 'books/B.md', { status: 'done', price: 30, age: 3, owner: 'bob' }, ['book']),
  page('c', 'books/C.md', { status: 'doing', price: 2, age: 1, owner: 'ann' }, ['tag']),
  page('d', 'Required Reading/D.md', { status: 'todo', price: 50, age: 5 }, ['book']),
  page('e', 'misc/E.md', { status: 'todo', price: 8, age: 2 }, []),
];

function run(config: BaseConfig, view?: string, rows = ROWS) {
  return runBase({
    config,
    viewName: view,
    rows,
    env: { dateKeys: new Set(), thisRow: null, lookupFile: (t) => rows.find((r) => r.path === t) ?? null, nowMs: NOW, budget: makeBudget() },
    canEditRow: (r) => r.id !== 'b',
    resolveLink: () => null,
  });
}

describe('parse', () => {
  it('reads the help example', () => {
    const { config, error, warnings } = parseBaseConfig(HELP_EXAMPLE);
    expect(error).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(config!.formulas.ppu).toBe('(price / age).toFixed(2)');
    expect(config!.properties['formula.formatted_price'].displayName).toBe('Price');
    expect(config!.summaries.customAverage).toBe('values.mean().round(3)');
    const v = config!.views[0];
    expect(v).toMatchObject({ type: 'table', name: 'My table', limit: 10, groupBy: { property: 'note.age', direction: 'DESC' } });
    expect(v.order).toEqual(['file.name', 'file.ext', 'note.age', 'formula.ppu', 'formula.formatted_price']);
    expect(v.summaries).toEqual({ 'formula.ppu': 'Average' });
    expect(config!.filters).toEqual({
      or: ['file.hasTag("tag")', { and: ['file.hasTag("book")', 'file.hasLink("Textbook")'] }, { not: ['file.hasTag("book")', 'file.inFolder("Required Reading")'] }],
    });
  });

  it('reads a single-statement filter, a kanban view, an empty file', () => {
    expect(parseBaseConfig(CSV_IMPORTER).config!.filters).toBe('file.folder == "Imports/books"');
    const k = parseBaseConfig(KANBAN).config!.views[0];
    expect(k.type).toBe('kanban');
    expect(k.groupOrder).toEqual(['Planned', 'In progress', 'Done']);
    expect(parseBaseConfig('').config).toEqual({ formulas: {}, properties: {}, summaries: {}, views: [] });
  });

  it('reports a broken file with a line, and odd shapes as warnings', () => {
    const bad = parseBaseConfig('views:\n  - type: table\n   name: x\n');
    expect(bad.config).toBeNull();
    expect(bad.error?.message).toMatch(/not valid YAML/);
    expect(bad.error?.line).toBeGreaterThan(0);
    expect(parseBaseConfig('- a\n- b\n').error?.message).toMatch(/mapping/);
    const odd = parseBaseConfig('filters:\n  maybe: [x]\nviews:\n  - name: Only a name\n  - 42\n');
    expect(odd.config!.filters).toBeUndefined();
    expect(odd.config!.views).toHaveLength(1);
    expect(odd.config!.views[0].type).toBe('table');
    expect(odd.warnings.length).toBe(2);
  });
});

describe('engine', () => {
  it('runs the help example: global OR filter, view filter, group DESC, formulas, summary', () => {
    const r = run(parseBaseConfig(HELP_EXAMPLE).config!);
    // Global: tag "tag", or (book and links Textbook), or not(book or in Required Reading) → c, a, e. View: status != done, (ppu > 5 or price > 2.1).
    expect(r.rows.map((x) => x.id).sort()).toEqual(['a', 'e']);
    expect(r.groups!.map((g) => g.key)).toEqual([
      { t: 'number', v: 2 },
      { t: 'number', v: 1 },
    ]);
    expect(r.columns.map((c) => c.label)).toEqual(['file.name', 'Extension', 'age', 'formula.ppu', 'Price']);
    const a = r.rows.find((x) => x.id === 'a')!;
    expect(a.cells['formula.ppu']).toEqual({ t: 'text', v: '10.00' });
    expect(a.cells['formula.formatted_price']).toEqual({ t: 'text', v: '10.00 dollars' });
    expect(a.cells['file.name']).toMatchObject({ t: 'link', pageId: 'a' });
    expect(a.canEdit).toBe(true);
    expect(r.columns.find((c) => c.id === 'formula.ppu')!.summary!.name).toBe('Average');
  });

  it('sorts, limits, groups with groupOrder and null groups, and summarizes per group', () => {
    const config: BaseConfig = {
      formulas: { double: 'price * 2' },
      properties: {},
      summaries: { top: 'values.max()' },
      views: [
        {
          type: 'table',
          name: 'T',
          order: ['file.name', 'price', 'formula.double', 'owner'],
          sort: [{ property: 'price', direction: 'DESC' }],
          groupBy: { property: 'owner', direction: 'ASC' },
          summaries: { price: 'Sum', 'formula.double': 'top', owner: 'Unique' },
        },
      ],
    };
    const r = run(config);
    expect(r.groups!.map((g) => g.key)).toEqual([{ t: 'text', v: 'ann' }, { t: 'text', v: 'bob' }, null]);
    expect(r.rows.map((x) => x.id)).toEqual(['a', 'c', 'b', 'd', 'e']);
    expect(r.groups![0].summaries!.price).toEqual({ t: 'number', v: 12 });
    expect(r.columns.find((c) => c.id === 'price')!.summary!.value).toEqual({ t: 'number', v: 100 });
    expect(r.columns.find((c) => c.id === 'formula.double')!.summary!.value).toEqual({ t: 'number', v: 100 });
    expect(r.columns.find((c) => c.id === 'owner')!.summary!.value).toEqual({ t: 'number', v: 2 });

    const ordered = run({ ...config, views: [{ ...config.views[0], groupOrder: ['bob', null] }] });
    expect(ordered.rows.map((x) => x.id)).toEqual(['b', 'd', 'e']);
    const limited = run({ ...config, views: [{ type: 'table', name: 'L', sort: [{ property: 'price', direction: 'ASC' }], limit: 2 }] });
    expect(limited.rows.map((x) => x.id)).toEqual(['c', 'e']);
    expect(limited.total).toBe(2);
  });

  it('pages the rows', () => {
    const r = runBase({
      config: { formulas: {}, properties: {}, summaries: {}, views: [] },
      rows: ROWS,
      env: { dateKeys: new Set(), thisRow: null, lookupFile: () => null, nowMs: NOW },
      canEditRow: () => true,
      resolveLink: () => null,
      offset: 2,
      limit: 2,
    });
    expect(r.view).toBeNull();
    expect(r.total).toBe(5);
    expect(r.rows.map((x) => x.id)).toEqual(['c', 'd']);
  });

  it('ignores unsupported filter statements with a warning, marks unsupported formulas, falls back from kanban', () => {
    const config = parseBaseConfig(`filters:
  and:
    - file.hasTag("book")
    - 'html("x") != ""'
formulas:
  pretty: 'icon("star")'
  bad: 'price.frobnicate()'
views:
  - type: kanban
    name: K
    order: [file.name, formula.pretty, formula.bad]
`).config!;
    const r = run(config);
    expect(r.rows.map((x) => x.id).sort()).toEqual(['a', 'b', 'd']);
    expect(r.layout).toBe('table');
    expect(r.unsupportedType).toBe('kanban');
    expect(r.warnings.some((w) => w.includes('html()'))).toBe(true);
    expect(r.warnings[0]).toMatch(/kanban/);
    expect(r.columns[1].unsupported).toMatch(/icon/);
    expect(r.rows[0].cells['formula.pretty']).toEqual({ t: 'unsupported', v: 'icon()' });
    expect(r.rows[0].cells['formula.bad']).toEqual({ t: 'unsupported', v: '.frobnicate()' });
  });

  it('evaluates a not group as "none of"', () => {
    const r = run({ formulas: {}, properties: {}, summaries: {}, filters: { not: ['file.hasTag("book")', 'file.inFolder("misc")'] }, views: [] });
    expect(r.rows.map((x) => x.id)).toEqual(['c']);
  });
});

describe('writer', () => {
  it('a fresh file is Obsidian-shaped YAML that parses back to the same config', () => {
    const config = parseBaseConfig(HELP_EXAMPLE).config!;
    const text = serializeBaseConfig(config);
    expect(text).toMatch(/^filters:\n {2}or:\n {4}- file\.hasTag\("tag"\)/);
    expect(text).toContain('views:\n  - type: table\n    name: My table\n');
    expect(parseBaseConfig(text).config).toEqual(config);
  });

  it('an unchanged config keeps the file byte for byte, comments included', () => {
    const original = `# My projects\n${HELP_EXAMPLE.replace('formulas:', '# money\nformulas:')}custom_key: keep me # really\n`;
    const config = parseBaseConfig(original).config!;
    expect(updateBaseSource(original, config)).toBe(original);
  });

  it('a changed view rewrites only that view; other blocks, views and unknown keys stay', () => {
    const original = `# header comment
filters:
  and:
    - file.inFolder("books") # only books
formulas:
  ppu: "(price / age).toFixed(2)"
pluginSettings:
  foo: 1
views:
  # the main one
  - type: table
    name: Main
    order: [file.name, price]
    rowHeight: tall
  - type: cards
    name: Gallery # cards
    image: note.cover
`;
    const config = parseBaseConfig(original).config!;
    config.views[0] = { ...config.views[0], sort: [{ property: 'price', direction: 'DESC' }] };
    const next = updateBaseSource(original, config);
    expect(next).toContain('# header comment\nfilters:\n  and:\n    - file.inFolder("books") # only books\n');
    expect(next).toContain('formulas:\n  ppu: "(price / age).toFixed(2)"\n');
    expect(next).toContain('pluginSettings:\n  foo: 1\n');
    expect(next).toContain('  - type: cards\n    name: Gallery # cards\n    image: note.cover\n');
    expect(next).toContain('rowHeight: tall');
    expect(next).toContain('sort:\n      - property: price\n        direction: DESC');
    const reparsed = parseBaseConfig(next).config!;
    expect(reparsed.views[0].sort).toEqual([{ property: 'price', direction: 'DESC' }]);
    expect(reparsed.views[0].rowHeight).toBe('tall');
    expect((yaml.load(next) as Record<string, unknown>).pluginSettings).toEqual({ foo: 1 });
  });

  it('adds, removes and reorders top-level sections', () => {
    const original = 'views:\n  - type: table\n    name: T\n';
    const config = parseBaseConfig(original).config!;
    config.filters = { and: ['status != "done"'] };
    config.formulas = { x: 'price * 2' };
    let next = updateBaseSource(original, config);
    expect(parseBaseConfig(next).config).toEqual(config);
    config.formulas = {};
    config.filters = undefined;
    next = updateBaseSource(next, config);
    expect(next).toBe(original);
    // Views added and removed.
    config.views.push({ type: 'list', name: 'L' });
    next = updateBaseSource(original, config);
    expect(next).toBe('views:\n  - type: table\n    name: T\n  - type: list\n    name: L\n');
  });

  it('quotes what needs quoting (a negated statement, a leading quote)', () => {
    const config: BaseConfig = { filters: { and: ['!done', '"x" == status'] }, formulas: {}, properties: {}, summaries: {}, views: [] };
    const text = serializeBaseConfig(config);
    expect(parseBaseConfig(text).config!.filters).toEqual({ and: ['!done', '"x" == status'] });
  });
});

describe('filter model', () => {
  it('reads the statements the editor can draw', () => {
    expect(parseStatement('status != "done"')).toEqual({ kind: 'rule', rule: { property: 'status', op: 'isNot', value: 'done', valueType: 'text' } });
    expect(parseStatement('price > 2.1')).toEqual({ kind: 'rule', rule: { property: 'price', op: 'gt', value: '2.1', valueType: 'number' } });
    expect(parseStatement('due < date("2026-01-01")')).toEqual({ kind: 'rule', rule: { property: 'due', op: 'lt', value: '2026-01-01', valueType: 'date' } });
    expect(parseStatement('file.hasTag("book")')).toMatchObject({ rule: { op: 'hasTag', value: 'book' } });
    expect(parseStatement('!file.inFolder("Archive")')).toMatchObject({ rule: { op: 'notInFolder', value: 'Archive' } });
    expect(parseStatement('note["my prop"].contains("x")')).toMatchObject({ rule: { property: 'note.my prop', op: 'contains' } });
    expect(parseStatement('!owner.isEmpty()')).toMatchObject({ rule: { property: 'owner', op: 'isNotEmpty' } });
    expect(parseStatement('file.hasProperty("due")')).toMatchObject({ rule: { property: 'due', op: 'hasProperty' } });
    expect(parseStatement('formula.ppu > 5')).toMatchObject({ rule: { property: 'formula.ppu', op: 'gt' } });
    expect(parseStatement('(price / age) > 5')).toEqual({ kind: 'raw', text: '(price / age) > 5' });
    expect(parseStatement('file.hasTag("a", "b")')).toEqual({ kind: 'raw', text: 'file.hasTag("a", "b")' });
  });

  it('prints rules back to the same statements', () => {
    for (const src of [
      'status != "done"',
      'price > 2.1',
      'due < date("2026-01-01")',
      'file.hasTag("book")',
      '!file.inFolder("Archive")',
      'note["my prop"].contains("x")',
      '!owner.isEmpty()',
      'file.hasProperty("due")',
      'done == true',
    ]) {
      const node = parseStatement(src);
      expect(node.kind).toBe('rule');
      if (node.kind === 'rule') expect(printRule(node.rule)).toBe(src);
    }
  });

  it('round-trips a filter tree', () => {
    const f = parseBaseConfig(HELP_EXAMPLE).config!.filters;
    expect(fromFilterNode(toFilterNode(f))).toEqual(f);
    expect(fromFilterNode(toFilterNode('status == "x"'))).toEqual({ and: ['status == "x"'] });
    expect(fromFilterNode({ kind: 'group', op: 'and', items: [] })).toBeUndefined();
  });
});

describe('save a search as a base', () => {
  it('turns the filters into statements and drops the words', () => {
    const ast = parseSearchQuery('roadmap tag:work kind:doc,table status:draft in:projects/ prop:owner=ann prop:due "big plan"');
    const { filters, dropped } = searchToBaseFilters(ast);
    expect(dropped).toEqual(['roadmap', '"big plan"']);
    expect(filters).toEqual({
      and: [
        'file.hasTag("work")',
        { or: ['file.ext == "md" && !file.name.endsWith(".table.md") && !file.name.endsWith(".form.md")', 'file.name.endsWith(".table.md")'] },
        'status == "draft"',
        'file.inFolder("projects")',
        'owner == "ann"',
        'file.hasProperty("due")',
      ],
    });
    const { config } = baseConfigFromSearch(ast, 'Results');
    expect(config.views[0].order).toEqual(['file.name', 'owner', 'due', 'file.mtime']);
    const r = run(config);
    expect(r.warnings).toEqual([]);
  });
});

describe('file.folder shown as the folder page title', () => {
  const config = { filters: undefined, formulas: {}, properties: {}, summaries: {}, views: [{ type: 'table', name: 'T', order: ['file.name', 'file.folder'], sort: [{ property: 'file.folder', direction: 'ASC' as const }], groupBy: { property: 'file.folder', direction: 'ASC' as const } }] } as BaseConfig;
  const rows = [page('a', 'books/A.md', {}), page('b', 'root.md', {}), page('c', 'books/deep/C.md', {})];
  const titles: Record<string, string> = { books: 'Books', 'books/deep': 'Deep shelf' };
  const labelled = () =>
    runBase({
      config,
      rows,
      env: { dateKeys: new Set(), thisRow: null, lookupFile: () => null, nowMs: NOW, budget: makeBudget() },
      canEditRow: () => false,
      resolveLink: () => null,
      folderLabel: (dir) => (dir === '/' ? null : dir.split('/').map((_, i, all) => titles[all.slice(0, i + 1).join('/')] ?? all[i]).join(' / ')),
    });

  it('cells and group headers show the label; the root and a missing page keep the path', () => {
    const r = labelled();
    const cell = (id: string) => r.rows.find((x) => x.id === id)!.cells['file.folder'];
    expect(cell('a')).toEqual({ t: 'text', v: 'Books' });
    expect(cell('c')).toEqual({ t: 'text', v: 'Books / Deep shelf' });
    expect(cell('b')).toEqual({ t: 'text', v: '/' });
    expect(r.groups!.map((g) => (g.key as { v: string }).v).sort()).toEqual(['/', 'Books', 'Books / Deep shelf']);
  });

  it('sorting and grouping still compare the path; without folderLabel nothing changes', () => {
    const r = labelled();
    // by path: "/" < "books" < "books/deep"
    expect(r.rows.map((x) => x.id)).toEqual(['b', 'a', 'c']);
    const plain = run(config, undefined, rows);
    expect(plain.rows.find((x) => x.id === 'a')!.cells['file.folder']).toEqual({ t: 'text', v: 'books' });
  });
});
