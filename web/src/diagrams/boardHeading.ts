/**
 * "Make heading": Excalidraw has no bold or mixed formatting inside one text
 * element, so a heading is faked the only way the format allows - by splitting
 * the first line of a free text block into its own, larger text element and
 * keeping the rest as the body underneath.
 *
 * Everything that is plain data and geometry lives here and is unit-tested
 * without Excalidraw (`planHeadingSplit` takes the text measurer as an
 * argument). `applyMakeHeading` at the bottom is the one function that talks to
 * the package: it measures with the package's own converter, builds the heading
 * element and writes both through `updateScene` as a single undo step.
 *
 * Choices worth knowing:
 *  - The heading keeps the source's font family and only grows in size. A
 *    different family (Nunito, Lilita One) would have to be loaded before it
 *    can be measured, and Lilita One has no Cyrillic; same family, larger
 *    size, is the heaviest "bold" the format offers that always renders.
 *  - The BODY keeps the source element's id (so reactions, arrow bindings and
 *    links stay on it); the heading is new.
 *  - Text bound to a container (a sticky's label) is not offered: a container
 *    has exactly one label, so the heading would have to leave the container.
 */
import { CaptureUpdateAction, convertToExcalidrawElements, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement, ExcalidrawTextElement } from '@excalidraw/excalidraw/element/types';
import { selectionIsIdle, type ReactionSelectionState } from './reactionsModel';

/** Excalidraw's own S / M / L / XL font sizes. */
export const STANDARD_FONT_SIZES = [16, 20, 28, 36] as const;
/** How much bigger than the body the heading is. */
export const HEADING_SCALE = 1.4;
/** Gap between heading and body, as a fraction of the body font size. */
export const HEADING_GAP_RATIO = 0.4;

export interface HeadingSplit {
  /** Index of the heading line among the source's logical lines. */
  headingLineIndex: number;
  heading: string;
  /** Logical lines of the body, leading and trailing blank lines removed. */
  bodyLines: string[];
  /** Index (among the source's logical lines) of the first body line. */
  bodyStartIndex: number;
}

/**
 * Splits text at its first non-blank line. Null when there is no body (a single
 * line, or blank lines after it) - nothing to separate.
 */
export function splitHeadingText(originalText: string): HeadingSplit | null {
  const lines = originalText.split('\n');
  const headingLineIndex = lines.findIndex((l) => l.trim() !== '');
  if (headingLineIndex < 0) return null;
  let start = headingLineIndex + 1;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  if (start >= end) return null;
  return {
    headingLineIndex,
    heading: lines[headingLineIndex].trimEnd(),
    bodyLines: lines.slice(start, end),
    bodyStartIndex: start,
  };
}

/**
 * Heading size for a body size: x1.4 snapped to the nearest standard size that is
 * strictly bigger than the body; a non-standard (or already XL) body gets plain x1.4.
 */
export function headingFontSize(bodySize: number): number {
  const target = bodySize * HEADING_SCALE;
  if (!(STANDARD_FONT_SIZES as readonly number[]).includes(bodySize)) return Math.round(target);
  const bigger = STANDARD_FONT_SIZES.filter((s) => s > bodySize);
  if (bigger.length === 0) return Math.round(target);
  return bigger.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best));
}

export interface TextMetrics {
  width: number;
  height: number;
}

/** Measures `text` in the source's font family and line height at the given size. */
export type MeasureText = (text: string, fontSize: number) => TextMetrics;

/** Greedy word wrap to `maxWidth` (a word wider than that is broken by characters). */
export function wrapToWidth(text: string, maxWidth: number, widthOf: (s: string) => number): string {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (widthOf(paragraph) <= maxWidth) {
      out.push(paragraph);
      continue;
    }
    let line = '';
    const push = () => {
      if (line) out.push(line.trimEnd());
      line = '';
    };
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (widthOf(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      push();
      if (widthOf(word) <= maxWidth) {
        line = word;
        continue;
      }
      for (const ch of Array.from(word)) {
        if (line && widthOf(line + ch) > maxWidth) push();
        line += ch;
      }
    }
    push();
  }
  return out.join('\n');
}

const stripWs = (s: string) => s.replace(/\s/g, '');

/**
 * The source's already-wrapped lines (`text`) grouped by logical line (`originalText`),
 * or null when they do not line up. Wrapping never joins logical lines and only drops
 * whitespace, so comparing without whitespace recovers the grouping exactly.
 */
function groupVisualLines(originalText: string, wrappedText: string): string[][] | null {
  const logical = originalText.split('\n');
  const visual = wrappedText.split('\n');
  const groups: string[][] = [];
  let v = 0;
  for (const line of logical) {
    const target = stripWs(line);
    if (target === '') {
      if (v >= visual.length || stripWs(visual[v]) !== '') return null;
      groups.push([visual[v++]]);
      continue;
    }
    const group: string[] = [];
    let acc = '';
    while (v < visual.length && acc.length < target.length) {
      acc += stripWs(visual[v]);
      group.push(visual[v++]);
    }
    if (acc !== target) return null;
    groups.push(group);
  }
  return v === visual.length ? groups : null;
}

/** The slice of a text element the split depends on. */
export interface HeadingSource {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  text: string;
  originalText: string;
  fontSize: number;
  textAlign: string;
  autoResize: boolean;
}

export interface PlannedText {
  /** Displayed (wrapped) text. */
  text: string;
  originalText: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  fontSize: number;
}

export interface HeadingPlan {
  heading: PlannedText;
  body: PlannedText;
}

/**
 * Lays out the heading and the body. Both keep the source's angle; in the source's own
 * (unrotated) frame the heading sits at the source's top, aligned by `textAlign`, and
 * the body below it, then both centres are rotated about the source's centre so the pair
 * moves rigidly with the rotation. A fixed-width source (`autoResize: false`) keeps its
 * width for both parts; an auto-sized one lets each part take its own measured width.
 */
export function planHeadingSplit(source: HeadingSource, measure: MeasureText): HeadingPlan | null {
  const split = splitHeadingText(source.originalText);
  if (!split) return null;

  const headingSize = headingFontSize(source.fontSize);
  const fixedWidth = !source.autoResize;

  const headingText = fixedWidth
    ? wrapToWidth(split.heading, source.width, (s) => measure(s, headingSize).width)
    : split.heading;
  const headingMetrics = measure(headingText, headingSize);

  const groups = groupVisualLines(source.originalText, source.text);
  let bodyText: string;
  if (fixedWidth && groups) {
    // Reuse the wrapping the board already shows, so the body does not reflow.
    bodyText = groups
      .slice(split.bodyStartIndex, split.bodyStartIndex + split.bodyLines.length)
      .flat()
      .join('\n');
  } else if (fixedWidth) {
    bodyText = wrapToWidth(split.bodyLines.join('\n'), source.width, (s) => measure(s, source.fontSize).width);
  } else {
    bodyText = split.bodyLines.join('\n');
  }
  const bodyMetrics = measure(bodyText, source.fontSize);

  const headingWidth = fixedWidth ? source.width : headingMetrics.width;
  const bodyWidth = fixedWidth ? source.width : bodyMetrics.width;
  const gap = Math.round(source.fontSize * HEADING_GAP_RATIO);

  const alignedX = (w: number) =>
    source.textAlign === 'center'
      ? source.x + (source.width - w) / 2
      : source.textAlign === 'right'
        ? source.x + source.width - w
        : source.x;

  const cx = source.x + source.width / 2;
  const cy = source.y + source.height / 2;
  const cos = Math.cos(source.angle);
  const sin = Math.sin(source.angle);
  const place = (
    box: { x: number; y: number; width: number; height: number },
    text: string,
    originalText: string,
    fontSize: number,
  ): PlannedText => {
    const dx = box.x + box.width / 2 - cx;
    const dy = box.y + box.height / 2 - cy;
    const rcx = cx + dx * cos - dy * sin;
    const rcy = cy + dx * sin + dy * cos;
    return {
      text,
      originalText,
      x: rcx - box.width / 2,
      y: rcy - box.height / 2,
      width: box.width,
      height: box.height,
      angle: source.angle,
      fontSize,
    };
  };

  return {
    heading: place(
      { x: alignedX(headingWidth), y: source.y, width: headingWidth, height: headingMetrics.height },
      headingText,
      split.heading,
      headingSize,
    ),
    body: place(
      { x: alignedX(bodyWidth), y: source.y + headingMetrics.height + gap, width: bodyWidth, height: bodyMetrics.height },
      bodyText,
      split.bodyLines.join('\n'),
      source.fontSize,
    ),
  };
}

/**
 * The text element the "Make heading" button belongs to, or null. Exactly one free
 * text element is selected (not bound to a container), nothing is mid-gesture, and
 * its text has a heading line plus a body.
 */
export function headingTarget(
  elements: readonly ExcalidrawElement[],
  appState: ReactionSelectionState,
): ExcalidrawTextElement | null {
  if (!selectionIsIdle(appState)) return null;
  const selected = Object.keys(appState.selectedElementIds).filter((id) => appState.selectedElementIds[id]);
  if (selected.length !== 1) return null;
  const el = elements.find((e) => e.id === selected[0]);
  if (!el || el.isDeleted || el.type !== 'text') return null;
  const text = el as ExcalidrawTextElement;
  if (text.containerId) return null;
  return splitHeadingText(text.originalText) ? text : null;
}

/** Text size through the package's own converter, so the numbers match what the board will draw. */
function packageMeasurer(source: ExcalidrawTextElement): MeasureText {
  const cache = new Map<string, TextMetrics>();
  return (text, fontSize) => {
    const key = `${fontSize}\u0000${text}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const [el] = convertToExcalidrawElements([
      { type: 'text', x: 0, y: 0, text, fontSize, fontFamily: source.fontFamily, lineHeight: source.lineHeight },
    ]);
    const metrics = { width: el.width, height: el.height };
    cache.set(key, metrics);
    return metrics;
  };
}

function newGroupId(): string {
  return `heading-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface MakeHeadingResult {
  headingId: string;
  bodyId: string;
  groupId: string;
}

/**
 * Splits the text element `sourceId` into heading + body (grouped), as ONE scene update
 * and ONE undo step, and selects the pair. Returns null when there is nothing to split.
 */
export function applyMakeHeading(api: ExcalidrawImperativeAPI, sourceId: string): MakeHeadingResult | null {
  const all = api.getSceneElementsIncludingDeleted();
  const source = all.find((e) => e.id === sourceId);
  if (!source || source.isDeleted || source.type !== 'text' || source.containerId) return null;
  const plan = planHeadingSplit(source, packageMeasurer(source));
  if (!plan) return null;

  const groupId = newGroupId();
  // A fresh element from the converter supplies id, seed and nonces; the style comes from the source.
  const [template] = convertToExcalidrawElements([{ type: 'text', x: 0, y: 0, text: plan.heading.text }]);
  const heading = {
    ...template,
    strokeColor: source.strokeColor,
    backgroundColor: source.backgroundColor,
    fillStyle: source.fillStyle,
    strokeWidth: source.strokeWidth,
    strokeStyle: source.strokeStyle,
    roughness: source.roughness,
    opacity: source.opacity,
    roundness: source.roundness,
    frameId: source.frameId,
    fontFamily: source.fontFamily,
    textAlign: source.textAlign,
    verticalAlign: source.verticalAlign,
    lineHeight: source.lineHeight,
    autoResize: source.autoResize,
    containerId: null,
    ...plan.heading,
    groupIds: [groupId, ...source.groupIds],
  } as ExcalidrawTextElement;
  const body = newElementWith(source, { ...plan.body, groupIds: [groupId, ...source.groupIds] });

  const next: ExcalidrawElement[] = [];
  for (const el of all) {
    if (el.id === sourceId) {
      next.push(heading, body);
    } else {
      next.push(el);
    }
  }
  api.updateScene({
    elements: next,
    appState: {
      selectedElementIds: { [heading.id]: true, [body.id]: true },
      selectedGroupIds: { [groupId]: true },
      editingGroupId: null,
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  return { headingId: heading.id, bodyId: body.id, groupId };
}
