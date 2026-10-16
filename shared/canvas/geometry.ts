/**
 * Canvas geometry — pure, shared by the web renderer (edges, fit, zoom) and
 * the board conversion (sides, group membership).
 *
 * Edges are drawn the way Obsidian draws them: a cubic Bézier from an anchor at
 * the middle of one side of the source card to an anchor on a side of the
 * target, each control point pushed out along its side's outward normal, so a
 * connection always leaves and enters a card at a right angle. A side the file
 * does not name is picked from the cards' relative position (the nearest
 * facing sides). Arrowheads are explicit triangles (not SVG markers) so they
 * take the edge's own colour everywhere and the maths is testable.
 */
import type { CanvasDocument, CanvasEdge, CanvasNode, CanvasSide } from '../contracts.js';

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The view transform: screen = world * zoom + (x, y). */
export interface CanvasView {
  x: number;
  y: number;
  zoom: number;
}

/** The fit (and the first view of a canvas) never zooms out past 10% nor in past 100%. */
export const FIT_MIN_ZOOM = 0.1;
export const FIT_MAX_ZOOM = 1;
/** What the reader can zoom to by hand. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
/** A container smaller than this (not laid out yet, hidden, collapsed) gets no fit at all — fitting it would produce a nonsense zoom. */
export const MIN_FIT_VIEWPORT = 48;
const FIT_PADDING = 40;

const NORMALS: Record<CanvasSide, Point> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

export function clampZoom(zoom: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(max, Math.max(min, zoom));
}

/** The bounding box of `rects`; null for none. */
export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The view that shows all of `bounds` centred in a `width` × `height`
 * viewport, zoom clamped to FIT_MIN_ZOOM..FIT_MAX_ZOOM. Null when the viewport
 * has no real size yet (below MIN_FIT_VIEWPORT either way) — the caller waits
 * for a resize instead of fitting into nothing.
 */
export function fitView(bounds: Rect | null, width: number, height: number, padding = FIT_PADDING): CanvasView | null {
  if (!(width >= MIN_FIT_VIEWPORT) || !(height >= MIN_FIT_VIEWPORT)) return null;
  if (!bounds) return { x: width / 2, y: height / 2, zoom: 1 };
  const pad = Math.min(padding, width / 4, height / 4);
  const zx = (width - 2 * pad) / Math.max(1, bounds.width);
  const zy = (height - 2 * pad) / Math.max(1, bounds.height);
  const zoom = clampZoom(Math.min(zx, zy), FIT_MIN_ZOOM, FIT_MAX_ZOOM);
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  return { x: width / 2 - cx * zoom, y: height / 2 - cy * zoom, zoom };
}

/** `view` zoomed by `factor` about the screen point `at` (the point under the cursor stays put). */
export function zoomAround(view: CanvasView, factor: number, at: Point): CanvasView {
  const zoom = clampZoom(view.zoom * factor);
  const k = zoom / view.zoom;
  return { zoom, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k };
}

export function screenToWorld(view: CanvasView, p: Point): Point {
  return { x: (p.x - view.x) / view.zoom, y: (p.y - view.y) / view.zoom };
}

/** The world rectangle a `width` × `height` viewport shows. */
export function visibleWorldRect(view: CanvasView, width: number, height: number): Rect {
  return { x: -view.x / view.zoom, y: -view.y / view.zoom, width: width / view.zoom, height: height / view.zoom };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The middle of `side` of `rect`. */
export function sideAnchor(rect: Rect, side: CanvasSide): Point {
  switch (side) {
    case 'top':
      return { x: rect.x + rect.width / 2, y: rect.y };
    case 'bottom':
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
    case 'left':
      return { x: rect.x, y: rect.y + rect.height / 2 };
    case 'right':
      return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
  }
}

/** The facing sides of two cards, by their centres (the larger axis wins). */
export function facingSides(a: Rect, b: Rect): [CanvasSide, CanvasSide] {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

/** The sides an edge uses: as written, else the facing ones (one written side keeps, the other is picked). */
export function edgeSides(edge: Pick<CanvasEdge, 'fromSide' | 'toSide'>, from: Rect, to: Rect): [CanvasSide, CanvasSide] {
  const [autoFrom, autoTo] = facingSides(from, to);
  return [edge.fromSide ?? autoFrom, edge.toSide ?? autoTo];
}

export interface EdgeGeometry {
  start: Point;
  end: Point;
  c1: Point;
  c2: Point;
  /** SVG path `d`. */
  path: string;
  /** Where the label sits: the curve's point at t = 0.5. */
  mid: Point;
  /** Arrowhead triangles (three points each) at the start / end, when that end is an arrow. */
  startArrow: [Point, Point, Point] | null;
  endArrow: [Point, Point, Point] | null;
}

const ARROW_LENGTH = 14;
const ARROW_HALF_WIDTH = 6;

/** How far the control points sit from their anchors: half the distance, 40..250 px — a gentle S, like Obsidian's. */
export function controlOffset(start: Point, end: Point): number {
  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  return Math.min(250, Math.max(40, dist / 2));
}

function bezierAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** A triangle with its tip at `tip`, pointing along `dir` (normalized here; a zero vector falls back to `fallback`). */
export function arrowHead(tip: Point, dir: Point, fallback: Point): [Point, Point, Point] {
  let len = Math.hypot(dir.x, dir.y);
  let d = dir;
  if (len < 1e-6) {
    d = fallback;
    len = Math.hypot(d.x, d.y) || 1;
  }
  const ux = d.x / len;
  const uy = d.y / len;
  const bx = tip.x - ux * ARROW_LENGTH;
  const by = tip.y - uy * ARROW_LENGTH;
  return [
    { x: tip.x, y: tip.y },
    { x: bx - uy * ARROW_HALF_WIDTH, y: by + ux * ARROW_HALF_WIDTH },
    { x: bx + uy * ARROW_HALF_WIDTH, y: by - ux * ARROW_HALF_WIDTH },
  ];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The curve of one edge between two cards. */
export function edgeGeometry(edge: Pick<CanvasEdge, 'fromSide' | 'toSide' | 'fromEnd' | 'toEnd'>, from: Rect, to: Rect): EdgeGeometry {
  const [fromSide, toSide] = edgeSides(edge, from, to);
  const start = sideAnchor(from, fromSide);
  const end = sideAnchor(to, toSide);
  const off = controlOffset(start, end);
  const n1 = NORMALS[fromSide];
  const n2 = NORMALS[toSide];
  const c1 = { x: start.x + n1.x * off, y: start.y + n1.y * off };
  const c2 = { x: end.x + n2.x * off, y: end.y + n2.y * off };
  const path = `M ${r1(start.x)} ${r1(start.y)} C ${r1(c1.x)} ${r1(c1.y)}, ${r1(c2.x)} ${r1(c2.y)}, ${r1(end.x)} ${r1(end.y)}`;
  // The tangent at an end points from its control point to the anchor — into the card. An arrow there points along it.
  const endArrow = edge.toEnd === 'arrow' ? arrowHead(end, { x: end.x - c2.x, y: end.y - c2.y }, { x: -n2.x, y: -n2.y }) : null;
  const startArrow = edge.fromEnd === 'arrow' ? arrowHead(start, { x: start.x - c1.x, y: start.y - c1.y }, { x: -n1.x, y: -n1.y }) : null;
  return { start, end, c1, c2, path, mid: bezierAt(start, c1, c2, end, 0.5), startArrow, endArrow };
}

/** True when `inner` lies entirely inside `outer`. */
export function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

/**
 * The group each card belongs to: the SMALLEST group that contains it whole.
 * JSON Canvas has no membership list — "in a group" is geometry only (the spec,
 * and Obsidian moves what lies inside a group with it). A group can belong to
 * a larger group the same way. Cards partly outside every group belong to none.
 */
export function groupMembership(doc: CanvasDocument): Map<string, string> {
  const groups = doc.nodes.filter((n) => n.type === 'group');
  const out = new Map<string, string>();
  for (const node of doc.nodes) {
    let best: CanvasNode | null = null;
    for (const g of groups) {
      if (g.id === node.id) continue;
      if (!contains(g, node)) continue;
      // Two groups of the same box: the earlier one (lower in z) is the parent of the later one, never both ways.
      if (node.type === 'group' && g.width * g.height === node.width * node.height && doc.nodes.indexOf(g) > doc.nodes.indexOf(node)) continue;
      if (!best || g.width * g.height < best.width * best.height) best = g;
    }
    if (best) out.set(node.id, best.id);
  }
  return out;
}

/**
 * Drawing order: groups first (always under the cards, whatever their place in
 * the file — Obsidian draws them that way), larger groups under smaller ones,
 * then every other card in file order (the spec's z-order).
 */
export function drawOrder(doc: CanvasDocument): CanvasNode[] {
  const groups = doc.nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n.type === 'group')
    .sort((a, b) => b.n.width * b.n.height - a.n.width * a.n.height || a.i - b.i)
    .map(({ n }) => n);
  return [...groups, ...doc.nodes.filter((n) => n.type !== 'group')];
}
