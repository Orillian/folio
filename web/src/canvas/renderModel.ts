/**
 * What the canvas renderer draws, as plain data — pure, no DOM, so the colours,
 * the edge curves and the first view are unit-tested (renderModel.test.ts).
 * CanvasView.tsx only turns this into elements and handles the pointer.
 */
import type { CanvasDocument, CanvasEdge, CanvasGroupNode, CanvasNode } from '@shared/contracts';
import {
  boundsOf,
  drawOrder,
  edgeGeometry,
  fitView,
  intersects,
  resolveCanvasColor,
  type CanvasColorScheme,
  type CanvasView,
  type Point,
  type Rect,
} from '@shared/canvas/index';

export type { CanvasView, Point, Rect };

/** A card's colours: the border, its fill (the colour, faint) and the group label's pill. Undefined = the theme's defaults (CSS). */
export interface CardColors {
  border?: string;
  fill?: string;
  /** The label pill of a coloured group. */
  labelFill?: string;
}

/** `#rgb` / `#rrggbb` / `#rrggbbaa` -> `rgba(r, g, b, alpha)`; anything else unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3,8})$/i.exec(color);
  if (!m) return color;
  let hex = m[1];
  if (hex.length === 3 || hex.length === 4) hex = hex.slice(0, 3).replace(/(.)/g, '$1$1');
  if (hex.length !== 6 && hex.length !== 8) return color;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Obsidian's look: a coloured card has the colour as its border and a faint wash of it as its fill (stronger in the dark). */
export function cardColors(color: string | undefined, scheme: CanvasColorScheme, kind: CanvasNode['type'] = 'text'): CardColors {
  const c = resolveCanvasColor(color, scheme);
  if (!c) return {};
  const fill = withAlpha(c, kind === 'group' ? (scheme === 'dark' ? 0.1 : 0.06) : scheme === 'dark' ? 0.16 : 0.08);
  return { border: c, fill, labelFill: withAlpha(c, scheme === 'dark' ? 0.3 : 0.2) };
}

export interface EdgeModel {
  id: string;
  path: string;
  /** Undefined = the theme's default line colour. */
  color?: string;
  /** SVG `points` of the arrowhead triangles. */
  startArrow: string | null;
  endArrow: string | null;
  label?: string;
  labelAt: Point;
}

const pointsAttr = (pts: readonly Point[]) => pts.map((p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`).join(' ');

/** Every edge of the canvas whose two cards are on it, in file order. */
export function edgeModels(doc: CanvasDocument, scheme: CanvasColorScheme): EdgeModel[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const out: EdgeModel[] = [];
  for (const edge of doc.edges) {
    const from = byId.get(edge.fromNode);
    const to = byId.get(edge.toNode);
    if (!from || !to) continue;
    out.push(edgeModel(edge, from, to, scheme));
  }
  return out;
}

export function edgeModel(edge: CanvasEdge, from: Rect, to: Rect, scheme: CanvasColorScheme): EdgeModel {
  const g = edgeGeometry(edge, from, to);
  return {
    id: edge.id,
    path: g.path,
    color: resolveCanvasColor(edge.color, scheme),
    startArrow: g.startArrow ? pointsAttr(g.startArrow) : null,
    endArrow: g.endArrow ? pointsAttr(g.endArrow) : null,
    ...(edge.label ? { label: edge.label } : {}),
    labelAt: g.mid,
  };
}

/** The bounds of every card and group (null for an empty canvas). */
export function canvasBounds(doc: CanvasDocument): Rect | null {
  return boundsOf(doc.nodes);
}

/**
 * The first view of a canvas: everything in sight, zoom 10%..100% — never a
 * zoom computed from a container that has no size yet (then null: wait for the
 * next resize).
 */
export function initialView(doc: CanvasDocument, width: number, height: number): CanvasView | null {
  return fitView(canvasBounds(doc), width, height);
}

/** Cards in drawing order (groups first, larger under smaller), split for the layers. */
export function layers(doc: CanvasDocument): { groups: CanvasGroupNode[]; cards: CanvasNode[] } {
  const ordered = drawOrder(doc);
  return { groups: ordered.filter((n): n is CanvasGroupNode => n.type === 'group'), cards: ordered.filter((n) => n.type !== 'group') };
}

/** The cards worth mounting for this viewport: those intersecting it, with a margin of half a screen around. */
export function visibleCards(cards: readonly CanvasNode[], view: CanvasView, width: number, height: number): CanvasNode[] {
  const margin = 0.5;
  const world: Rect = {
    x: (-view.x - width * margin) / view.zoom,
    y: (-view.y - height * margin) / view.zoom,
    width: (width * (1 + 2 * margin)) / view.zoom,
    height: (height * (1 + 2 * margin)) / view.zoom,
  };
  return cards.filter((c) => intersects(c, world));
}

/** Below this zoom a card shows a light preview (no Markdown rendering): the words would be unreadable anyway. */
export const LITE_ZOOM = 0.3;

/** `https://www.example.com/a/b?c` -> `example.com`; a string that is not a URL -> itself. */
export function urlDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

/** Only http(s) and mailto links are opened from a link card; anything else (javascript:, data:) is shown but not clickable. */
export function safeExternalUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.href : null;
  } catch {
    return null;
  }
}

/** `/files/<space>/<path>` with each segment encoded (+ `?share=` for a share guest). */
export function spaceFileUrl(space: string, relPath: string, shareToken?: string): string {
  const base = `/files/${encodeURIComponent(space)}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
  return shareToken ? `${base}?share=${encodeURIComponent(shareToken)}` : base;
}

/** The first line of a text card, Markdown markers stripped — the lite preview. */
export function previewLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)/, '')
    .replace(/^\[![^\]]*\][+-]?\s*/, '')
    .replace(/[*_`~=]+/g, '')
    .replace(/!?\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_m, target: string, alias: string) => alias || target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}
