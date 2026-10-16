/**
 * Which node labels the graph draws (pure, tested in graphLabels.test.ts). Like Obsidian, text fades in with the
 * zoom instead of all of it being drawn at once:
 *
 *  - The focus (hovered / selected node) and the centre of a local graph are ALWAYS labelled; the focus's
 *    neighbours come right after them, at full strength, at any zoom (but, like any label, not over another).
 *  - A small graph (up to SMALL_GRAPH nodes): every label, fading in at `labelZoom` ("Text fade threshold").
 *  - A big one: at a low zoom only the top hubs (highest degree, MIN_HUBS..MAX_HUBS of them) are labelled; the
 *    rest come in by degree as the zoom approaches the reveal zoom (to the 5th power: slowly at first), all of
 *    them from it. The reveal zoom is `labelZoom`, or twice the zoom that fits the whole graph when that is
 *    more — so the fitted overview of a big graph is hubs only, whatever the window size.
 *  - Whatever the zoom, nodes are visited in degree order and a label whose box overlaps one already placed is
 *    skipped, so the text never piles up into an unreadable mass.
 */

export interface LabelCandidate {
  id: string;
  /** Screen position of the node's centre (CSS px) and its radius on screen. */
  sx: number;
  sy: number;
  radiusPx: number;
  degree: number;
  text: string;
  isCenter: boolean;
}

export interface PlannedLabel {
  id: string;
  text: string;
  sx: number;
  /** Top of the text box, screen px. */
  top: number;
  alpha: number;
  /** The focus, a neighbour of it, or the centre: drawn at full strength whatever the zoom. */
  important: boolean;
}

export interface LabelPlanInput {
  /** Nodes in view, in any order. */
  candidates: readonly LabelCandidate[];
  /** All nodes of the graph (not only those in view): the size class decides how the zoom reveals labels. */
  total: number;
  k: number;
  labelZoom: number;
  /** The zoom that fits the whole graph in view (0 when unknown). */
  fitK?: number;
  /** Canvas size, px² (a phone shows fewer hubs). */
  area?: number;
  /** The hovered / selected node, or null. */
  focusId?: string | null;
  /** Its neighbourhood (itself included), or null. */
  hot: ReadonlySet<string> | null;
  /** Text width on screen, px. */
  measure: (text: string) => number;
  fontPx: number;
  /** Most labels besides the important ones. */
  maxLabels: number;
}

/** Up to this many nodes every label fades in at `labelZoom`; above it the hubs lead. */
export const SMALL_GRAPH = 40;
export const MIN_HUBS = 10;
export const MAX_HUBS = 15;

const FADE_BAND = 0.35;
const PAD = 3;
const CELL = 64;

/** A canvas of this many px² (about a desktop window) has room for the full count of hubs; a phone gets fewer. */
const FULL_AREA = 600_000;

/** How many hubs a graph of `total` nodes shows at a low zoom, on a canvas of `area` px² (unknown = full size). */
export function hubCount(total: number, area = FULL_AREA): number {
  const base = Math.min(MAX_HUBS, Math.max(MIN_HUBS, Math.round(total * 0.12)));
  return Math.max(3, Math.round(base * Math.max(0.25, Math.min(1, area / FULL_AREA))));
}

/** Label strength of the node at `rank` (0 = the biggest hub among those in view) — 0..1, ignoring collisions. */
export function labelStrength(rank: number, inView: number, total: number, k: number, labelZoom: number, fitK = 0, area = FULL_AREA): number {
  if (total <= SMALL_GRAPH) return Math.max(0, Math.min(1, (k - labelZoom) / FADE_BAND + 1));
  const hubs = hubCount(total, area);
  const t = Math.max(0, Math.min(1, k / Math.max(labelZoom, 2 * fitK)));
  const budget = hubs + Math.max(0, inView - hubs) * t ** 5;
  return Math.max(0, Math.min(1, budget - rank));
}

class BoxGrid {
  private cells = new Map<number, Array<[number, number, number, number]>>();
  private key(cx: number, cy: number): number {
    return cx * 100003 + cy;
  }
  overlaps(x0: number, y0: number, x1: number, y1: number): boolean {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const list = this.cells.get(this.key(cx, cy));
        if (!list) continue;
        for (const b of list) if (x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]) return true;
      }
    }
    return false;
  }
  add(x0: number, y0: number, x1: number, y1: number): void {
    const box: [number, number, number, number] = [x0, y0, x1, y1];
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const key = this.key(cx, cy);
        const list = this.cells.get(key);
        if (list) list.push(box);
        else this.cells.set(key, [box]);
      }
    }
  }
}

/** The labels to draw, in drawing order (the important ones first, then by degree). */
export function planLabels(input: LabelPlanInput): PlannedLabel[] {
  const { candidates, total, k, labelZoom, fitK = 0, area = FULL_AREA, focusId = null, hot, measure, fontPx, maxLabels } = input;
  const isForced = (c: LabelCandidate) => c.isCenter || c.id === focusId;
  const isImportant = (c: LabelCandidate) => isForced(c) || !!hot?.has(c.id);
  const byDegree = (a: LabelCandidate, b: LabelCandidate) => b.degree - a.degree || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const important = candidates.filter(isImportant).sort(byDegree);
  const others = candidates.filter((c) => !isImportant(c)).sort(byDegree);

  const grid = new BoxGrid();
  const out: PlannedLabel[] = [];
  const place = (c: LabelCandidate, alpha: number, important: boolean, force: boolean): boolean => {
    const w = measure(c.text);
    const top = c.sy + c.radiusPx + 2;
    const x0 = c.sx - w / 2 - PAD;
    const x1 = c.sx + w / 2 + PAD;
    const y0 = top - 1;
    const y1 = top + fontPx + 1;
    if (!force && grid.overlaps(x0, y0, x1, y1)) return false;
    grid.add(x0, y0, x1, y1);
    out.push({ id: c.id, text: c.text, sx: c.sx, top, alpha, important });
    return true;
  };

  // The focus and the centre first (never skipped), then its neighbours, then the rest by degree.
  for (const c of important) if (isForced(c)) place(c, 1, true, true);
  for (const c of important) if (!isForced(c)) place(c, 1, true, false);
  // While something is in focus the other labels step back.
  const dim = hot ? 0.25 : 1;
  let drawn = 0;
  for (let rank = 0; rank < others.length && drawn < maxLabels; rank++) {
    const strength = labelStrength(rank, others.length, total, k, labelZoom, fitK, area);
    if (strength <= 0.02) break; // ranks only get weaker from here
    if (place(others[rank], strength * dim, false, false)) drawn++;
  }
  return out;
}
