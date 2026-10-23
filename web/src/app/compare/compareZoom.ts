/** Zoom of the compare view's columns: one value for all of them, in percent, stepped (not free-form). */
export const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125] as const;
export const DEFAULT_ZOOM = 100;
export const ZOOM_STORAGE_KEY = 'folio:compare-zoom';

/**
 * Kinds whose column manages its own viewport: Excalidraw (board) sizes its canvas and maps pointer coordinates from
 * CSS px, so under CSS `zoom` it covers only zoom x the area and clicks land off; a canvas, a sandboxed artifact frame
 * and the pdf / office viewers are canvases or iframes with their own scale. They always render at 100%.
 */
const SELF_ZOOMING_KINDS: ReadonlySet<string> = new Set(['board', 'canvas', 'artifact', 'pdf', 'office']);

/** Whether the shared CSS zoom applies to a column of this page kind (unknown kind - not loaded yet - counts as a document). */
export function zoomAppliesToKind(kind: string | undefined): boolean {
  return kind === undefined || !SELF_ZOOMING_KINDS.has(kind);
}

const MIN = ZOOM_STEPS[0];
const MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** Any number to a value the view can show: rounded, within the range; garbage becomes the default. */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ZOOM;
  return Math.min(MAX, Math.max(MIN, Math.round(value)));
}

/** The next step up (`1`) or down (`-1`) from `current`; from a value between steps, the nearest step in that direction. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const value = clampZoom(current);
  if (direction === 1) return ZOOM_STEPS.find((step) => step > value) ?? MAX;
  return [...ZOOM_STEPS].reverse().find((step) => step < value) ?? MIN;
}

export function readStoredZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
    return raw === null ? DEFAULT_ZOOM : clampZoom(Number(raw));
  } catch {
    return DEFAULT_ZOOM;
  }
}

export function writeStoredZoom(zoom: number): void {
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(zoom));
  } catch {
    // A private window or blocked storage: the zoom just lasts until the page is closed.
  }
}

/** What Ctrl/Cmd + a key does to the zoom, or null when the key is not ours (`=` and `+` are the same key). */
export function zoomKeyAction(key: string): 'in' | 'out' | 'reset' | null {
  if (key === '=' || key === '+') return 'in';
  if (key === '-' || key === '_') return 'out';
  if (key === '0') return 'reset';
  return null;
}
