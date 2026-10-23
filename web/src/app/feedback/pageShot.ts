/**
 * "Capture page" for the report dialog: renders the visible viewport to a canvas, crops it, and turns it into an image
 * file small enough for the report's attachment limit. Everything happens in the browser; nothing leaves it until the
 * person presses Send.
 */

/** Elements carrying this attribute are left out of the capture (dialogs, toasts, the compare tray, assistant panels). */
export const REPORT_EXCLUDE_ATTR = 'data-report-exclude';

/** The smallest selection (CSS pixels, each side) that counts as a crop rather than a stray click. */
export const MIN_CROP_CSS_PX = 12;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Turns a selection drawn over the captured image (CSS pixels, relative to the image as displayed) into the rectangle to
 * cut from the canvas (canvas pixels, so device pixel ratio is accounted for). A selection dragged right-to-left or
 * bottom-to-top has negative width/height and is normalised; one that leaves the image is clamped to it; one that ends
 * up smaller than `minCssPx` on either side is not a selection and gives null.
 */
export function cropSourceRect(selection: Rect, view: Size, canvas: Size, minCssPx: number = MIN_CROP_CSS_PX): Rect | null {
  if (view.width <= 0 || view.height <= 0 || canvas.width <= 0 || canvas.height <= 0) return null;
  const left = Math.max(0, Math.min(selection.x, selection.x + selection.width));
  const top = Math.max(0, Math.min(selection.y, selection.y + selection.height));
  const right = Math.min(view.width, Math.max(selection.x, selection.x + selection.width));
  const bottom = Math.min(view.height, Math.max(selection.y, selection.y + selection.height));
  if (!(right - left >= minCssPx) || !(bottom - top >= minCssPx)) return null;
  const sx = canvas.width / view.width;
  const sy = canvas.height / view.height;
  const x = Math.min(canvas.width - 1, Math.floor(left * sx));
  const y = Math.min(canvas.height - 1, Math.floor(top * sy));
  const width = Math.max(1, Math.min(canvas.width - x, Math.ceil(right * sx) - x));
  const height = Math.max(1, Math.min(canvas.height - y, Math.ceil(bottom * sy) - y));
  return { x, y, width, height };
}

/** Whether a node of the page belongs in the capture. */
export function isCapturable(node: Node): boolean {
  return !(node as Element).hasAttribute?.(REPORT_EXCLUDE_ATTR);
}

function pageBackground(): string {
  for (const el of [document.body, document.documentElement]) {
    const color = getComputedStyle(el).backgroundColor;
    if (color && color !== 'transparent' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(color)) return color;
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? '#0a0a0a' : '#ffffff';
}

/**
 * Renders what the person currently sees (the viewport) to a canvas. The library is loaded on first use so it stays
 * out of the main bundle. Images or frames from other origins (artifacts, PDFs) may come out blank.
 */
export async function captureViewport(): Promise<HTMLCanvasElement> {
  const { domToCanvas } = await import('modern-screenshot');
  return domToCanvas(document.body, {
    scale: Math.min(2, window.devicePixelRatio || 1),
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: pageBackground(),
    filter: isCapturable,
    timeout: 20000,
  });
}

/** A copy of `source` limited to `rect` (canvas pixels). */
export function cropCanvas(source: HTMLCanvasElement, rect: Rect): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = rect.width;
  out.height = rect.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('canvas is not available');
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  return out;
}

function scaleCanvas(source: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(source.width * factor));
  out.height = Math.max(1, Math.round(source.height * factor));
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('canvas is not available');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, out.width, out.height);
  return out;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Encodes the canvas as an image file of at most `maxBytes`: a PNG when it fits (text stays sharp), else a JPEG at
 * falling quality, else the same again from a canvas scaled down by a quarter, a few times over.
 */
export async function canvasToImageFile(canvas: HTMLCanvasElement, maxBytes: number, baseName = 'page-screenshot'): Promise<File> {
  let work = canvas;
  for (let round = 0; round < 6; round++) {
    const png = await toBlob(work, 'image/png');
    if (png && png.size <= maxBytes) return new File([png], `${baseName}.png`, { type: 'image/png' });
    for (const quality of [0.9, 0.75, 0.6]) {
      const jpeg = await toBlob(work, 'image/jpeg', quality);
      if (jpeg && jpeg.size <= maxBytes) return new File([jpeg], `${baseName}.jpg`, { type: 'image/jpeg' });
    }
    work = scaleCanvas(work, 0.75);
  }
  throw new Error('the screenshot does not fit the size limit');
}
