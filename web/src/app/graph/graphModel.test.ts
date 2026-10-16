import { describe, expect, it } from 'vitest';
import type { GraphResponse } from '@shared/contracts';
import { buildGraphView, compileQuery, DEFAULT_GRAPH_SETTINGS, KIND_COLORS, NEUTRAL, neighbourhood, OTHER_SPACE_COLOR, PALETTE, sanitizeSettings, type GraphSettings } from './graphModel';

const page = (id: string, path: string, extra: Partial<GraphResponse['nodes'][number]> = {}) => ({
  id,
  title: extra.title ?? id.toUpperCase(),
  kind: 'doc' as const,
  path,
  tags: [] as string[],
  status: 'published' as const,
  degree: 0,
  ...extra,
});

/** hub → a, hub → b, a → b, c → a; lonely; hub → #team, a → #team/x; hub → file, hub → ghost. */
const DATA: Pick<GraphResponse, 'nodes' | 'edges'> = {
  nodes: [
    page('hub', 'hub.md', { tags: ['team'] }),
    page('a', 'docs/a.md', { tags: ['team/x'] }),
    page('b', 'docs/b.md', { kind: 'table', status: 'draft' }),
    page('c', 'notes/c.md'),
    page('lonely', 'lonely.md'),
    { id: 'tag:team', title: '#team', kind: 'tag', degree: 0 },
    { id: 'tag:team/x', title: '#team/x', kind: 'tag', degree: 0 },
    { id: 'file:assets/pic.png', title: 'pic.png', kind: 'file', path: 'assets/pic.png', degree: 0 },
    { id: 'ghost:Ghost.md', title: 'Ghost', kind: 'unresolved', path: 'Ghost.md', degree: 0 },
  ],
  edges: [
    { source: 'hub', target: 'a', count: 1 },
    { source: 'hub', target: 'b', count: 1 },
    { source: 'a', target: 'b', count: 2 },
    { source: 'c', target: 'a', count: 1 },
    { source: 'hub', target: 'tag:team', count: 1 },
    { source: 'a', target: 'tag:team/x', count: 1 },
    { source: 'hub', target: 'file:assets/pic.png', count: 1 },
    { source: 'hub', target: 'ghost:Ghost.md', count: 1 },
  ],
};

const view = (patch: Partial<GraphSettings> = {}, center?: string) => buildGraphView(DATA, { ...DEFAULT_GRAPH_SETTINGS, ...patch }, center);
const ids = (v: ReturnType<typeof view>) => v.nodes.map((n) => n.id).sort();

describe('graphModel: filters', () => {
  it('by default: pages only (tags, files, ghosts off), orphans kept, edges among them', () => {
    const v = view();
    expect(ids(v)).toEqual(['a', 'b', 'c', 'hub', 'lonely']);
    expect(v.links).toHaveLength(4);
    expect(v.nodes.find((n) => n.id === 'a')!.degree).toBe(3);
    expect(v.nodes.find((n) => n.id === 'lonely')!.degree).toBe(0);
  });

  it('toggles add tag, file and ghost nodes; orphans off drops unlinked pages', () => {
    expect(ids(view({ showTags: true, showFiles: true, showUnresolved: true, showOrphans: false }))).toEqual(
      ['a', 'b', 'c', 'file:assets/pic.png', 'ghost:Ghost.md', 'hub', 'tag:team', 'tag:team/x'].sort(),
    );
    expect(ids(view({ showTags: true }))).toContain('tag:team');
    expect(ids(view({ showUnresolved: true }))).not.toContain('tag:team');
  });

  it('the search query filters pages; non-page nodes follow the pages they hang on', () => {
    expect(ids(view({ search: 'in:docs/' }))).toEqual(['a', 'b']);
    expect(ids(view({ search: 'kind:table' }))).toEqual(['b']);
    expect(ids(view({ search: 'status:draft' }))).toEqual(['b']);
    expect(ids(view({ search: 'tag:team' }))).toEqual(['a', 'hub']); // the hierarchy: team matches team/x
    expect(ids(view({ search: 'tag:team/x' }))).toEqual(['a']);
    expect(ids(view({ search: 'hub', showTags: true, showFiles: true }))).toEqual(['file:assets/pic.png', 'hub', 'tag:team']);
    expect(ids(view({ search: '-docs' }))).toEqual(['c', 'hub', 'lonely']);
    expect(ids(view({ search: '"notes/c"' }))).toEqual(['c']);
    // An unknown operator is a word; prop: is not known on the client and filters nothing.
    expect(ids(view({ search: 'prop:owner=x' }))).toEqual(['a', 'b', 'c', 'hub', 'lonely']);
  });

  it('the centre of a local graph is always kept', () => {
    const v = view({ search: 'kind:table' }, 'lonely');
    expect(ids(v)).toEqual(['b', 'lonely']);
    // Orphans off: b links to nothing that is shown and goes; the centre stays.
    expect(ids(view({ search: 'kind:table', showOrphans: false }, 'lonely'))).toEqual(['lonely']);
    expect(v.nodes.find((n) => n.id === 'lonely')!.isCenter).toBe(true);
  });

  it('compileQuery: an empty query or a lone operator asks for nothing', () => {
    expect(compileQuery('')).toBeNull();
    expect(compileQuery('tag:')).toBeNull();
    expect(compileQuery('kind:doc')).not.toBeNull();
  });
});

describe('graphModel: groups and sizes', () => {
  it('colour by kind, folder or tag; custom groups win, first match first', () => {
    let v = view({ colorBy: 'kind' });
    expect(v.nodes.find((n) => n.id === 'b')!.color).toBe(KIND_COLORS.table);
    expect(v.legend.map((l) => [l.label, l.count, l.query])).toEqual([
      ['doc', 4, 'kind:doc'],
      ['table', 1, 'kind:table'],
    ]);

    v = view({ colorBy: 'folder' });
    expect(v.nodes.find((n) => n.id === 'a')!.color).toBe(v.nodes.find((n) => n.id === 'b')!.color);
    expect(v.legend[0]).toMatchObject({ label: '/', count: 2 }); // hub.md, lonely.md are in the root
    expect(v.legend.find((l) => l.label === 'docs/')).toMatchObject({ count: 2, query: 'in:"docs/"' });

    v = view({ colorBy: 'tag', showTags: true });
    expect(v.nodes.find((n) => n.id === 'hub')!.color).toBe(v.nodes.find((n) => n.id === 'tag:team')!.color);
    expect(v.nodes.find((n) => n.id === 'c')!.color).toBe(NEUTRAL);

    v = view({ colorBy: 'none', groups: [{ query: 'in:docs/', color: '#123456' }, { query: 'kind:doc', color: '#abcdef' }] });
    expect(v.nodes.find((n) => n.id === 'a')!.color).toBe('#123456');
    expect(v.nodes.find((n) => n.id === 'hub')!.color).toBe('#abcdef');
    expect(v.legend.map((l) => [l.label, l.count])).toEqual([
      ['in:docs/', 2],
      ['kind:doc', 3],
    ]);
    // A group with an empty query is ignored.
    expect(view({ colorBy: 'none', groups: [{ query: '', color: '#123456' }] }).nodes.every((n) => n.color === NEUTRAL)).toBe(true);
  });

  it('node size grows with the degree, or stays fixed', () => {
    const v = view();
    const r = (id: string) => v.nodes.find((n) => n.id === id)!.radius;
    expect(r('a')).toBeGreaterThan(r('c'));
    expect(r('c')).toBeGreaterThan(r('lonely'));
    const fixed = view({ sizeByDegree: false });
    expect(new Set(fixed.nodes.map((n) => n.radius)).size).toBe(1);
  });

  it('neighbourhood: the node and its direct neighbours, both directions', () => {
    expect([...neighbourhood('a', view().links)].sort()).toEqual(['a', 'b', 'c', 'hub']);
  });
});

describe('graphModel: settings from storage', () => {
  it('fills missing values, clamps numbers, drops malformed groups', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_GRAPH_SETTINGS);
    const s = sanitizeSettings({ repelForce: 999, depth: 2.6, direction: 'up', colorBy: 'rainbow', showTags: 'yes', groups: [{ query: 'tag:x', color: '#ff0000' }, { query: 1, color: '#ff0000' }, { query: 'a', color: 'red' }] });
    expect(s.repelForce).toBe(20);
    expect(s.depth).toBe(3);
    expect(s.direction).toBe('both');
    expect(s.colorBy).toBe(DEFAULT_GRAPH_SETTINGS.colorBy);
    expect(s.showTags).toBe(false);
    expect(s.groups).toEqual([{ query: 'tag:x', color: '#ff0000' }]);
    expect(PALETTE.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
  });
});

describe('graphModel: tree structure and pages of other spaces (16.10.2026)', () => {
  const TREE: Pick<GraphResponse, 'nodes' | 'edges'> = {
    nodes: [
      page('home', 'index.md'),
      page('guide', 'guide.md'),
      page('setup', 'guide/setup.md'),
      page('lonely', 'lonely.md'),
      page('x1', 'runbook.md', { title: 'Runbook', space: 'ops', spaceName: 'Operations' }),
    ],
    edges: [
      { source: 'home', target: 'guide', count: 1, kind: 'tree' },
      { source: 'home', target: 'lonely', count: 1, kind: 'tree' },
      { source: 'guide', target: 'setup', count: 1, kind: 'tree' },
      { source: 'guide', target: 'setup', count: 2 },
      { source: 'guide', target: 'x1', count: 1 },
    ],
  };
  const view = (patch: Partial<GraphSettings> = {}) => buildGraphView(TREE, { ...DEFAULT_GRAPH_SETTINGS, ...patch }, undefined, { kind: (k) => k, rootFolder: '/', otherSpace: 'Other spaces' });

  it('tree edges are on by default, marked as tree links, and count for degree and orphans; off, they are gone', () => {
    expect(DEFAULT_GRAPH_SETTINGS.showTree).toBe(true);
    const on = view({ showOrphans: false });
    expect(on.links.filter((l) => l.tree).map((l) => `${l.source}>${l.target}`)).toEqual(['home>guide', 'home>lonely', 'guide>setup']);
    expect(on.links.filter((l) => !l.tree)).toHaveLength(2);
    expect(on.nodes.map((n) => n.id)).toContain('lonely');
    const off = view({ showTree: false, showOrphans: false });
    expect(off.links.some((l) => l.tree)).toBe(false);
    expect(off.nodes.map((n) => n.id).sort()).toEqual(['guide', 'setup', 'x1']);
    expect(sanitizeSettings({ showTree: false }).showTree).toBe(false);
    expect(sanitizeSettings({ showTree: 'no' }).showTree).toBe(true);
  });

  it('a page of another space is labelled "space / title", keeps its space, has its own colour and legend entry; a custom group still wins', () => {
    const v = view();
    const x = v.nodes.find((n) => n.id === 'x1')!;
    expect(x).toMatchObject({ title: 'Operations / Runbook', space: 'ops', color: OTHER_SPACE_COLOR });
    expect(v.legend.find((e) => e.label === 'Other spaces')).toMatchObject({ color: OTHER_SPACE_COLOR, count: 1 });
    // the folder preset describes this space only
    expect(v.legend.some((e) => e.count === 5)).toBe(false);
    const grouped = view({ groups: [{ query: 'runbook', color: '#123456' }] });
    expect(grouped.nodes.find((n) => n.id === 'x1')!.color).toBe('#123456');
    expect(grouped.legend.some((e) => e.label === 'Other spaces')).toBe(false);
  });
});

describe('graphModel: the legend names folders by their page titles', () => {
  const data: Pick<GraphResponse, 'nodes' | 'edges'> = {
    nodes: [
      page('t', 'ai-sdlc-technologia/index.md', { title: 'AI SDLC: technology' }),
      page('p', 'ai-sdlc-technologia/prompts/a.md'),
      page('c', 'checklists.md', { title: 'Checklists' }),
      page('c1', 'checklists/one.md'),
      page('n', 'nopage/x.md'),
    ],
    edges: [],
  };
  const v = buildGraphView(data, { ...DEFAULT_GRAPH_SETTINGS, colorBy: 'folder' });

  it('a folder with a page shows its title, the slug stays in the filter query', () => {
    expect(v.legend.find((l) => l.query === 'in:"ai-sdlc-technologia/"')?.label).toBe('AI SDLC: technology');
    expect(v.legend.find((l) => l.query === 'in:"checklists/"')?.label).toBe('Checklists');
  });

  it('a folder without a page keeps its slug', () => {
    expect(v.legend.find((l) => l.query === 'in:"nopage/"')?.label).toBe('nopage/');
  });
});
