/**
 * Graph view, the pure half: server answer (GraphResponse) + the viewer's
 * settings → what the canvas draws. No DOM, no React, so it is tested on its
 * own (graphModel.test.ts).
 *
 *  - Filters, like Obsidian's: a search query in the search grammar
 *    (shared/searchQuery.ts — words, "phrases", -exclusions, tag:, kind:,
 *    status:, in:; prop: and a front matter `status:todo` value are not known on
 *    the client and match everything)
 *    applied to PAGES; the toggles for tag, file and unresolved nodes; and
 *    orphans (nodes left without an edge after filtering). A tag, file or
 *    ghost node stays only while a page that is shown links to it.
 *  - Groups = colour by query: the custom groups first (first match wins),
 *    then the preset (by kind, by top folder, by tag), else the neutral colour.
 *  - Size: by degree (distinct neighbours among what is shown) or fixed.
 *  - Tree structure (`showTree`, on by default): the server's parent → child
 *    edges (`kind: 'tree'`) are drawn, dashed and thinner, so a hierarchical
 *    space is not a cloud of dots; off, they are left out (and do not count
 *    for degree or orphans).
 *  - A page of another space (an app link across spaces) is labelled
 *    "space / title" and has its own colour unless a custom group takes it.
 */
import type { GraphEdge, GraphNode, GraphNodeKind, GraphResponse } from '@shared/contracts';
import { parseSearchQuery } from '@shared/searchQuery';
import { folderDisplay, folderTitleMap } from '@shared/folderTitles';

export type ColorBy = 'none' | 'kind' | 'folder' | 'tag';

export interface GraphGroup {
  query: string;
  color: string;
}

export interface GraphSettings {
  search: string;
  showTags: boolean;
  showFiles: boolean;
  showUnresolved: boolean;
  showOrphans: boolean;
  colorBy: ColorBy;
  groups: GraphGroup[];
  arrows: boolean;
  /** Zoom level from which every label is drawn (hovered and the centre always are). */
  labelZoom: number;
  sizeByDegree: boolean;
  nodeSize: number;
  linkThickness: number;
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
  /** Parent → child edges of the page tree (and, in the local graph, tree neighbours). */
  showTree: boolean;
  /** The local graph (page panel and ?page= mode). */
  depth: number;
  direction: 'both' | 'in' | 'out';
}

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  search: '',
  showTags: false,
  showFiles: false,
  showUnresolved: false,
  showOrphans: true,
  colorBy: 'folder',
  groups: [],
  arrows: false,
  labelZoom: 1.1,
  sizeByDegree: true,
  nodeSize: 1,
  linkThickness: 1,
  centerForce: 0.3,
  repelForce: 8,
  linkForce: 0.6,
  linkDistance: 50,
  showTree: true,
  depth: 1,
  direction: 'both',
};

const clamp = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** Settings read back from localStorage: anything missing or malformed takes its default. */
export function sanitizeSettings(raw: unknown): GraphSettings {
  const d = DEFAULT_GRAPH_SETTINGS;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const groups = Array.isArray(r.groups)
    ? r.groups
        .filter((g): g is GraphGroup => !!g && typeof g === 'object' && typeof (g as GraphGroup).query === 'string' && COLOR_RE.test(String((g as GraphGroup).color)))
        .slice(0, 12)
        .map((g) => ({ query: g.query.slice(0, 300), color: g.color }))
    : [];
  return {
    search: typeof r.search === 'string' ? r.search.slice(0, 300) : d.search,
    showTags: bool(r.showTags, d.showTags),
    showFiles: bool(r.showFiles, d.showFiles),
    showUnresolved: bool(r.showUnresolved, d.showUnresolved),
    showOrphans: bool(r.showOrphans, d.showOrphans),
    colorBy: r.colorBy === 'none' || r.colorBy === 'kind' || r.colorBy === 'folder' || r.colorBy === 'tag' ? r.colorBy : d.colorBy,
    groups,
    arrows: bool(r.arrows, d.arrows),
    labelZoom: clamp(r.labelZoom, 0.2, 4, d.labelZoom),
    sizeByDegree: bool(r.sizeByDegree, d.sizeByDegree),
    nodeSize: clamp(r.nodeSize, 0.4, 3, d.nodeSize),
    linkThickness: clamp(r.linkThickness, 0.2, 4, d.linkThickness),
    centerForce: clamp(r.centerForce, 0, 1, d.centerForce),
    repelForce: clamp(r.repelForce, 0, 20, d.repelForce),
    linkForce: clamp(r.linkForce, 0, 1, d.linkForce),
    linkDistance: clamp(r.linkDistance, 10, 300, d.linkDistance),
    showTree: bool(r.showTree, d.showTree),
    depth: Math.round(clamp(r.depth, 1, 3, d.depth)),
    direction: r.direction === 'in' || r.direction === 'out' || r.direction === 'both' ? r.direction : d.direction,
  };
}

const PAGE_KINDS = new Set<GraphNodeKind>(['doc', 'board', 'folder', 'table', 'pdf', 'office', 'form', 'canvas', 'base', 'artifact']);
export const isPageNode = (n: Pick<GraphNode, 'kind'>): boolean => PAGE_KINDS.has(n.kind);

/** A node matcher for a search-grammar query, or null when the query asks for nothing. */
export function compileQuery(q: string): ((n: GraphNode) => boolean) | null {
  const ast = parseSearchQuery(q);
  const words = [...ast.words, ...ast.phrases].map((w) => w.toLowerCase());
  const excluded = ast.excluded.map((w) => w.toLowerCase());
  if (!words.length && !excluded.length && !ast.tags.length && !ast.kinds.length && !ast.statuses.length && !ast.pathPrefixes.length) return null;
  return (n) => {
    const hay = `${n.title}\n${n.path ?? ''}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return false;
    if (excluded.some((w) => hay.includes(w))) return false;
    if (ast.tags.length) {
      const tags = nodeTags(n);
      if (!ast.tags.every((t) => tags.some((x) => x === t || x.startsWith(`${t}/`)))) return false;
    }
    if (ast.kinds.length && !(ast.kinds as string[]).includes(n.kind)) return false;
    // `status:draft,todo`: the `todo` half is front matter the graph does not have, so the operator cannot exclude anything.
    if (ast.statuses.length && !ast.statusValues?.length && !(n.status && ast.statuses.includes(n.status))) return false;
    if (ast.pathPrefixes.length && !ast.pathPrefixes.some((p) => (n.path ?? '').startsWith(p))) return false;
    return true;
  };
}

/** A page's tags; a tag node carries its own tag, so `tag:x` matches (and colours) it too. */
function nodeTags(n: GraphNode): string[] {
  if (n.kind === 'tag') return [n.id.slice('tag:'.length)];
  return n.tags ?? [];
}

/** Colours that read on white and on near-black alike (Tailwind 500s). */
export const PALETTE = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#8b5cf6', '#f97316', '#14b8a6'];
export const NEUTRAL = '#94a3b8';
/** A page of another space (sky 500: apart from the palette's first colours, readable in both themes). */
export const OTHER_SPACE_COLOR = '#0ea5e9';

export const KIND_COLORS: Record<GraphNodeKind, string> = {
  doc: '#6366f1',
  board: '#f59e0b',
  table: '#10b981',
  form: '#ec4899',
  pdf: '#ef4444',
  office: '#06b6d4',
  canvas: '#84cc16',
  base: '#8b5cf6',
  artifact: '#f43f5e',
  folder: NEUTRAL,
  tag: '#65a30d',
  file: '#a855f7',
  unresolved: '#a3a3a3',
};

export interface ViewNode {
  id: string;
  title: string;
  kind: GraphNodeKind;
  path?: string;
  color: string;
  radius: number;
  degree: number;
  isCenter: boolean;
  /** Set on a page of another space: its slug (where a click goes). */
  space?: string;
}

export interface ViewLink {
  source: string;
  target: string;
  count: number;
  /** A parent → child edge of the page tree, not a link. */
  tree?: boolean;
}

export interface LegendEntry {
  label: string;
  color: string;
  count: number;
  /** A query that selects this entry (to turn a preset entry into a custom group, or to filter by it). */
  query?: string;
}

export interface GraphView {
  nodes: ViewNode[];
  links: ViewLink[];
  legend: LegendEntry[];
}

function topFolder(n: GraphNode): string {
  const p = n.path ?? '';
  const i = p.indexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** The `max` most frequent values, most frequent first (ties by name). */
function topValues(values: string[], max: number): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([v]) => v);
}

export function nodeRadius(degree: number, settings: Pick<GraphSettings, 'sizeByDegree' | 'nodeSize'>, kind: GraphNodeKind): number {
  const base = settings.sizeByDegree ? 3 + Math.min(16, Math.sqrt(degree) * 1.5) : 4.5;
  const k = kind === 'tag' || kind === 'unresolved' || kind === 'file' ? 0.8 : 1;
  return base * settings.nodeSize * k;
}

/** Labels for the legend's preset entries; the caller passes translated strings. */
export interface LegendLabels {
  kind: (kind: GraphNodeKind) => string;
  rootFolder: string;
  /** The legend entry of pages of other spaces. */
  otherSpace?: string;
}

const DEFAULT_LABELS: LegendLabels = { kind: (k) => k, rootFolder: '/', otherSpace: 'Other spaces' };

/** What a node is called on the canvas: a page of another space carries its space's name. */
export function nodeLabel(n: Pick<GraphNode, 'title' | 'space' | 'spaceName'>): string {
  return n.space ? `${n.spaceName ?? n.space} / ${n.title}` : n.title;
}

/**
 * GraphResponse + settings → the nodes and links to draw, with colours and sizes, and the legend.
 * `centerId` (the local graph) is always kept, whatever the filters say.
 */
export function buildGraphView(data: Pick<GraphResponse, 'nodes' | 'edges'>, settings: GraphSettings, centerId?: string, labels: LegendLabels = DEFAULT_LABELS): GraphView {
  const match = compileQuery(settings.search);
  const kindAllowed = (n: GraphNode) =>
    (n.kind !== 'tag' || settings.showTags) && (n.kind !== 'file' || settings.showFiles) && (n.kind !== 'unresolved' || settings.showUnresolved);

  // 1. Pages through the query; the other kinds through their toggles, and only next to a kept page.
  const keptPages = new Set<string>();
  for (const n of data.nodes) if (isPageNode(n) && (n.id === centerId || !match || match(n))) keptPages.add(n.id);
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const keptOthers = new Set<string>();
  for (const e of data.edges) {
    for (const [page, other] of [
      [e.source, e.target],
      [e.target, e.source],
    ]) {
      if (!keptPages.has(page)) continue;
      const o = byId.get(other);
      if (o && !isPageNode(o) && kindAllowed(o)) keptOthers.add(other);
    }
  }
  const kept = (id: string) => keptPages.has(id) || keptOthers.has(id);
  let edges: GraphEdge[] = data.edges.filter((e) => kept(e.source) && kept(e.target) && (settings.showTree || e.kind !== 'tree'));

  // 2. Degree among what is shown; orphans out when asked (the centre stays).
  const degree = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let s = degree.get(a);
    if (!s) degree.set(a, (s = new Set()));
    s.add(b);
  };
  for (const e of edges) {
    add(e.source, e.target);
    add(e.target, e.source);
  }
  let nodes = data.nodes.filter((n) => kept(n.id));
  if (!settings.showOrphans) {
    nodes = nodes.filter((n) => n.id === centerId || (degree.get(n.id)?.size ?? 0) > 0);
    const ids = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  }

  // 3. Colours: custom groups, then the preset.
  const groups = settings.groups.map((g) => ({ ...g, match: compileQuery(g.query) })).filter((g) => g.match !== null);
  const legend: LegendEntry[] = [];
  const presetColor = new Map<string, string>();
  let presetOf: (n: GraphNode) => string | undefined = () => undefined;
  // Pages of other spaces have their own colour: the presets describe this space.
  const pages = nodes.filter((n) => isPageNode(n) && !n.space);
  if (settings.colorBy === 'kind') {
    presetOf = (n) => n.kind;
    for (const k of topValues(nodes.map((n) => n.kind), 12)) presetColor.set(k, KIND_COLORS[k as GraphNodeKind] ?? NEUTRAL);
  } else if (settings.colorBy === 'folder') {
    presetOf = (n) => (isPageNode(n) && !n.space ? topFolder(n) : undefined);
    topValues(pages.map(topFolder), PALETTE.length).forEach((f, i) => presetColor.set(f, PALETTE[i]));
  } else if (settings.colorBy === 'tag') {
    const top = topValues(pages.flatMap((n) => n.tags ?? []), PALETTE.length);
    top.forEach((t, i) => presetColor.set(t, PALETTE[i]));
    presetOf = (n) => {
      if (n.kind === 'tag') return n.id.slice(4);
      return top.find((t) => (n.tags ?? []).includes(t));
    };
  }
  const counts = new Map<string, number>();
  const groupCounts = groups.map(() => 0);
  let otherSpaceCount = 0;
  const colorOf = (n: GraphNode): string => {
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].match!(n)) {
        groupCounts[i]++;
        return groups[i].color;
      }
    }
    if (n.space) {
      otherSpaceCount++;
      return OTHER_SPACE_COLOR;
    }
    const key = presetOf(n);
    if (key !== undefined && presetColor.has(key)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return presetColor.get(key)!;
    }
    // Tags, files and ghosts keep their own colour unless a group took them.
    return isPageNode(n) ? NEUTRAL : KIND_COLORS[n.kind];
  };

  const viewNodes: ViewNode[] = nodes.map((n) => {
    const d = degree.get(n.id)?.size ?? 0;
    return {
      id: n.id,
      title: nodeLabel(n),
      kind: n.kind,
      path: n.path,
      color: colorOf(n),
      radius: nodeRadius(d, settings, n.kind),
      degree: d,
      isCenter: n.id === centerId,
      ...(n.space ? { space: n.space } : {}),
    };
  });

  const folderTitles = settings.colorBy === 'folder' ? folderTitleMap(data.nodes.filter((n) => isPageNode(n) && !n.space && n.path).map((n) => ({ path: n.path!, title: n.title }))) : new Map<string, string>();
  groups.forEach((g, i) => legend.push({ label: g.query, color: g.color, count: groupCounts[i], query: g.query }));
  for (const [key, color] of presetColor) {
    const count = counts.get(key) ?? 0;
    if (count === 0) continue;
    if (settings.colorBy === 'kind') legend.push({ label: labels.kind(key as GraphNodeKind), color, count, query: isPageNode({ kind: key as GraphNodeKind }) ? `kind:${key}` : undefined });
    else if (settings.colorBy === 'folder') {
      // A folder is usually a page with a title: the legend shows it, the slug stays in the query.
      legend.push({ label: key === '' ? labels.rootFolder : (folderTitles.has(key) ? folderDisplay(key, folderTitles)! : `${key}/`), color, count, query: key === '' ? undefined : `in:"${key}/"` });
    } 
    else legend.push({ label: `#${key}`, color, count, query: `tag:${key}` });
  }
  if (otherSpaceCount > 0) legend.push({ label: labels.otherSpace ?? DEFAULT_LABELS.otherSpace!, color: OTHER_SPACE_COLOR, count: otherSpaceCount });

  return { nodes: viewNodes, links: edges.map((e) => ({ source: e.source, target: e.target, count: e.count, ...(e.kind === 'tree' ? { tree: true } : {}) })), legend };
}

/** Ids of a node and its direct neighbours among `links` — what hover highlights. */
export function neighbourhood(id: string, links: ViewLink[]): Set<string> {
  const out = new Set([id]);
  for (const l of links) {
    if (l.source === id) out.add(l.target);
    else if (l.target === id) out.add(l.source);
  }
  return out;
}
