/**
 * Initial framing of a board ("fit to screen on open"), as plain geometry with no
 * dependency on Excalidraw — so it can be tested without a canvas.
 *
 * Why this is ours and not `api.scrollToContent(..., { fitToViewport: true })`
 * (prod, 16.10.2026: a shared board opened at 3000% for everyone and at 10% for the
 * owner): with `fitToViewport` the library applies NO upper cap at all (the 100% cap of
 * `zoomValueToFitBoundsOnViewport` belongs to the other branch), and with no
 * `minZoom`/`maxZoom` the only limits left are its global 0.1..30. So
 *   - a scene whose non-deleted elements span a zero-size box (one empty text, two
 *     zero-size rectangles, everything at one point) divides by zero, gets Infinity and
 *     lands on the global maximum, 3000%;
 *   - a scene wider than ~10x the canvas lands on the global minimum, 10%, and the
 *     library floors the result to a 10% step first, so a board that fits at 17% opens
 *     at 10%.
 * Here the zoom is the exact fit, never above 100% (opening a board must not magnify
 * it) and never below the library's own 10%, and a viewport that cannot be computed
 * from finite numbers is `null` — the caller then leaves the canvas as it is.
 */

export const FIT_MIN_ZOOM = 0.1;
/** A board opens at most at 100%: framing is for seeing everything, not for magnifying. */
export const FIT_MAX_ZOOM = 1;
/** Share of the canvas the content may take — a margin so the outermost shapes do not touch the edges. */
export const FIT_FILL = 0.92;
/** A canvas smaller than this (either side) has not been laid out yet (hidden tab, collapsed container) — nothing sensible can be fitted to it. */
export const FIT_MIN_CANVAS_PX = 64;

export interface SceneBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export interface FitViewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

interface BoundsElement {
  isDeleted?: boolean;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Bounding box of the live (non-deleted) elements with finite geometry; null when there is none. Rotation is ignored — the margin in FIT_FILL covers it. */
export function sceneBounds(elements: readonly BoundsElement[]): SceneBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    if (el.isDeleted) continue;
    if (!finite(el.x) || !finite(el.y) || !finite(el.width) || !finite(el.height)) continue;
    // A negative width/height (an element drawn right-to-left, not yet normalized) is still a valid box.
    const x2 = el.x + el.width;
    const y2 = el.y + el.height;
    minX = Math.min(minX, el.x, x2);
    maxX = Math.max(maxX, el.x, x2);
    minY = Math.min(minY, el.y, y2);
    maxY = Math.max(maxY, el.y, y2);
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  return { minX, minY, maxX, maxY };
}

export function isCanvasMeasured(size: CanvasSize | null | undefined): size is CanvasSize {
  return !!size && finite(size.width) && finite(size.height) && size.width >= FIT_MIN_CANVAS_PX && size.height >= FIT_MIN_CANVAS_PX;
}

/**
 * The viewport that shows `bounds` entirely in a canvas of `size`, centred. Null when the
 * canvas is not measured yet or the result is not a finite number.
 */
export function computeFitViewport(bounds: SceneBounds | null, size: CanvasSize | null | undefined): FitViewport | null {
  if (!bounds || !isCanvasMeasured(size)) return null;
  // A zero-width/-height box (a single line, one point) must not produce an infinite zoom:
  // 1 scene unit is the smallest extent that takes part in the division.
  const contentWidth = Math.max(bounds.maxX - bounds.minX, 1);
  const contentHeight = Math.max(bounds.maxY - bounds.minY, 1);
  const exact = Math.min((size.width * FIT_FILL) / contentWidth, (size.height * FIT_FILL) / contentHeight);
  if (!Number.isFinite(exact)) return null;
  const zoom = Math.min(Math.max(exact, FIT_MIN_ZOOM), FIT_MAX_ZOOM);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const scrollX = size.width / 2 / zoom - centerX;
  const scrollY = size.height / 2 / zoom - centerY;
  if (![scrollX, scrollY, zoom].every(Number.isFinite)) return null;
  return { scrollX, scrollY, zoom };
}

/**
 * True when the canvas, at this saved pan/zoom, shows at least part of the content. A saved
 * viewport that looks at empty space (the board was rearranged or emptied since, or it was
 * saved from a different window size) frames nothing — better to fit afresh than to open on
 * a blank canvas.
 */
export function viewportShowsContent(viewport: FitViewport, bounds: SceneBounds | null, size: CanvasSize): boolean {
  if (!bounds) return true; // nothing to look at, nothing to contradict
  if (!(viewport.zoom > 0)) return false;
  // Excalidraw: screenX = (sceneX + scrollX) * zoom, so the visible scene rect is [-scrollX, -scrollX + size/zoom].
  const left = -viewport.scrollX;
  const top = -viewport.scrollY;
  const right = left + size.width / viewport.zoom;
  const bottom = top + size.height / viewport.zoom;
  return bounds.maxX >= left && bounds.minX <= right && bounds.maxY >= top && bounds.minY <= bottom;
}
