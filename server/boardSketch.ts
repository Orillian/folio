/**
 * AI assistant (Cursor SDK) — board builder for the assistant's `create_board`
 * / `update_board` MCP tools (see server/mcp.ts). A "sketch" is a small,
 * model-friendly DSL — nodes with x/y/type/label + edges with from/to/label —
 * that this module turns into a real ExcalidrawScene using the SAME element
 * geometry/binding primitives server/confluenceWhiteboard.ts's Confluence
 * importer uses (baseEl/textEl/placeBoundText/elbowRoute/fixedPointOf,
 * exported from there for exactly this reuse). The result is rendered with
 * that module's own renderSceneSvg and MUST pass its own selfcheckWhiteboardSvg
 * — that self-check is this file's test, per the round's instructions, not a
 * separate hand-rolled assertion set.
 *
 * Unlike the Confluence importer (whose coordinates are Confluence's
 * CENTER-based `position`, see geom()'s doc comment there), a sketch's x/y is
 * the element's own TOP-LEFT corner — this is a fresh DSL the model authors
 * directly, so there is no reason to carry over Confluence's coordinate
 * convention.
 */
import {
  baseEl,
  boundTextMaxWidth,
  boundTextMaxHeight,
  elbowRoute,
  fixedPointOf,
  placeBoundText,
  textEl,
  textMetrics,
  type ExcalidrawElement,
  type ExcalidrawScene,
} from './confluenceWhiteboard.js';
import { z } from 'zod';

const DEFAULT_STROKE = '#1e1e1e';
const DEFAULT_LABEL_COLOR = '#1e1e1e';
const DEFAULT_EDGE_LABEL_COLOR = '#44546F';
const DEFAULT_FONT_SIZE = 16;

const DEFAULT_SIZES: Record<'rectangle' | 'ellipse' | 'diamond', { w: number; h: number }> = {
  rectangle: { w: 200, h: 80 },
  ellipse: { w: 160, h: 100 },
  diamond: { w: 180, h: 120 },
};

export const boardSketchNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['rectangle', 'ellipse', 'diamond', 'text', 'frame']),
  label: z.string().optional(),
  x: z.number(),
  y: z.number(),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
  color: z.string().optional(),
  background: z.string().optional(),
  fontSize: z.union([z.literal(16), z.literal(20), z.literal(28)]).optional(),
  /** id of a `type: 'frame'` node this node is a member of. */
  frame: z.string().optional(),
  /** A URL (or an app path) the element links to — excalidraw's own element link. */
  link: z.string().optional(),
  /** Label placement inside a shape: default center / middle. */
  align: z.enum(['left', 'center']).optional(),
  valign: z.enum(['top', 'middle']).optional(),
  /** A label too tall for its shape: 'grow' the shape (default) or 'clip' the label to the shape, ending in "…" (the shape keeps its size). */
  overflow: z.enum(['grow', 'clip']).optional(),
});
export type BoardSketchNode = z.infer<typeof boardSketchNodeSchema>;

export const boardSketchEdgeSchema = z.object({
  id: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().optional(),
  /** Orthogonal (right-angled) routing. Default true. */
  elbowed: z.boolean().optional(),
  start: z.literal('arrow').nullable().optional(),
  end: z.literal('arrow').nullable().optional(),
  color: z.string().optional(),
  /** The side the arrow leaves `from` / reaches `to` at; default: the facing sides of the two boxes. */
  fromSide: z.enum(['left', 'right', 'top', 'bottom']).optional(),
  toSide: z.enum(['left', 'right', 'top', 'bottom']).optional(),
});
export type BoardSketchEdge = z.infer<typeof boardSketchEdgeSchema>;

export const boardSketchSchema = z.object({
  background: z.string().optional(),
  nodes: z.array(boardSketchNodeSchema).min(1),
  edges: z.array(boardSketchEdgeSchema).default([]),
});
export type BoardSketch = z.infer<typeof boardSketchSchema>;

/**
 * An image node — not part of the MCP DSL (a model never hands over image
 * bytes): the canvas conversion (server/canvasToBoard.ts) passes the picture
 * itself through BuildSceneOptions.images, keyed by the node id.
 */
export interface BoardSketchImageNode {
  id: string;
  type: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  frame?: string;
  link?: string;
}
export interface BoardSketchImage {
  mimeType: string;
  dataURL: string;
}
export interface BuildSceneOptions {
  /** The pictures of the sketch's image nodes, by node id. */
  images?: ReadonlyMap<string, BoardSketchImage>;
  /** Filled with the ids of the nodes whose label was clipped (`overflow: 'clip'`). */
  clipped?: string[];
}
/** A sketch that may hold image nodes (internal callers only). */
export type BoardSketchWithImages = Omit<BoardSketch, 'nodes'> & { nodes: Array<BoardSketchNode | BoardSketchImageNode> };

/**
 * Small deterministic-enough PRNG for `seed`/`versionNonce` — those two
 * fields only randomize excalidraw's hand-drawn roughness (0 here), so
 * unlike confluenceWhiteboard.ts's own makeSeeder (which must be
 * byte-identical run to run for import determinism), this one just needs to
 * produce plausible distinct integers.
 */
function makeSeeder(): () => number {
  let state = 0x2f6e2b1 >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % 0x7fffffff) + 1;
  };
}

/** Exported for server/boardOps.ts's arrow-rerouting (board_ops) — see baseEl's export note. */
export type Side = 'left' | 'right' | 'top' | 'bottom';

/** Exported for server/boardOps.ts — see baseEl's export note. */
export const SIDE_FRACTION: Record<Side, { left: number; top: number }> = {
  left: { left: 0, top: 0.5 },
  right: { left: 1, top: 0.5 },
  top: { left: 0.5, top: 0 },
  bottom: { left: 0.5, top: 1 },
};

/** Which side of each box an edge should leave/arrive from, based on the boxes' relative centers — the "nearest sides" the round's spec calls for. Exported for server/boardOps.ts — see baseEl's export note. */
export function pickSides(a: ExcalidrawElement, b: ExcalidrawElement): [Side, Side] {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

/** Grows `container.height` (symmetrically, about its own center) until boundTextMaxHeight(container) can fit `textHeight` — the "if the text doesn't fit, grow the container" rule from the round's spec. Width never grows: boundTextMaxWidth only depends on container.width, so an over-wide label is a sketch-authoring mistake, not something this silently papers over. */
function growForText(container: ExcalidrawElement, textHeight: number): void {
  const limit = boundTextMaxHeight(container);
  if (textHeight <= limit) return;
  const delta = textHeight - limit;
  container.y -= delta / 2;
  container.height += delta;
}

/**
 * `m` cut to the lines that fit `maxHeight`, the last one ending in "…" (shortened until it fits `maxWidth`).
 * Null when everything fits already.
 */
function clipToHeight(m: ReturnType<typeof textMetrics>, fontSize: number, maxWidth: number, maxHeight: number): ReturnType<typeof textMetrics> | null {
  if (m.height <= maxHeight) return null;
  const lines = m.text.split('\n');
  const lineHeight = m.height / Math.max(1, lines.length);
  const keep = Math.max(1, Math.floor(maxHeight / lineHeight));
  const kept = lines.slice(0, keep);
  let last = kept[kept.length - 1] ?? '';
  while (last && textMetrics(`${last}…`, fontSize).width > maxWidth) last = Array.from(last).slice(0, -1).join('');
  kept[kept.length - 1] = `${last.replace(/\s+$/u, '')}…`;
  const text = kept.join('\n');
  const clipped = textMetrics(text, fontSize);
  return { text, width: Math.min(clipped.width, maxWidth), height: kept.length * lineHeight };
}

interface LabelLayout {
  align?: 'left' | 'center';
  valign?: 'top' | 'middle';
  overflow?: 'grow' | 'clip';
}

/** Returns true when the label was clipped (`overflow: 'clip'`). */
function attachContainerLabel(
  elements: ExcalidrawElement[],
  seed: () => number,
  container: ExcalidrawElement,
  label: string,
  fontSize: number,
  layout: LabelLayout = {},
): boolean {
  const maxW = boundTextMaxWidth(container, fontSize);
  let m = textMetrics(label, fontSize, maxW);
  let clipped = false;
  if (layout.overflow === 'clip') {
    const cut = clipToHeight(m, fontSize, maxW, boundTextMaxHeight(container));
    if (cut) {
      m = cut;
      clipped = true;
    }
  } else {
    growForText(container, m.height);
  }
  const tel = textEl(seed, `t-${container.id}`, m.text, 0, 0, Math.min(m.width, maxW), m.height, fontSize, DEFAULT_LABEL_COLOR, {
    align: layout.align ?? 'center',
    valign: layout.valign ?? 'middle',
    container: container.id,
    original: clipped ? m.text : label,
  });
  placeBoundText(container, tel);
  tel.frameId = container.frameId;
  container.boundElements = [...(container.boundElements ?? []), { id: tel.id, type: 'text' }];
  elements.push(tel);
  return clipped;
}

/**
 * sketch -> ExcalidrawScene. Pure, throws a plain Error (never a partial
 * scene) on a bad reference (unknown frame/edge endpoint, duplicate id,
 * missing frame size) so the MCP tool can turn it into a clear errorResult
 * instead of writing a broken board.
 */
export function buildSceneFromSketch(sketch: BoardSketch | BoardSketchWithImages, options: BuildSceneOptions = {}): ExcalidrawScene {
  const seed = makeSeeder();
  const files: Record<string, unknown> = {};
  const elements: ExcalidrawElement[] = [];
  const byId = new Map<string, ExcalidrawElement>();

  const allNodes: Array<BoardSketchNode | BoardSketchImageNode> = sketch.nodes;
  const frameNodes = allNodes.filter((n): n is BoardSketchNode => n.type === 'frame');
  const otherNodes = allNodes.filter((n) => n.type !== 'frame');

  for (const node of frameNodes) {
    if (byId.has(node.id)) throw new Error(`duplicate node id "${node.id}"`);
    if (node.w === undefined || node.h === undefined) throw new Error(`frame node "${node.id}" requires w and h`);
    const el = baseEl(seed, node.id, 'frame', node.x, node.y, node.w, node.h);
    el.strokeColor = node.color ?? DEFAULT_STROKE;
    el.backgroundColor = node.background ?? 'transparent';
    el.name = node.label ?? '';
    elements.push(el);
    byId.set(node.id, el);
  }

  for (const node of otherNodes) {
    if (byId.has(node.id)) throw new Error(`duplicate node id "${node.id}"`);
    let frameId: string | null = null;
    if (node.frame !== undefined) {
      const parent = byId.get(node.frame);
      if (!parent || parent.type !== 'frame') throw new Error(`node "${node.id}" references unknown frame "${node.frame}"`);
      frameId = parent.id;
    }
    if (node.type === 'image') {
      const picture = options.images?.get(node.id);
      if (!picture) throw new Error(`image node "${node.id}" has no picture`);
      const fileId = `f-${node.id}`;
      const el = baseEl(seed, node.id, 'image', node.x, node.y, node.w, node.h);
      el.strokeColor = 'transparent';
      el.fileId = fileId;
      el.status = 'saved';
      el.scale = [1, 1];
      el.crop = null;
      el.frameId = frameId;
      el.link = node.link ?? null;
      files[fileId] = { mimeType: picture.mimeType, id: fileId, dataURL: picture.dataURL, created: 1 };
      elements.push(el);
      byId.set(node.id, el);
      continue;
    }
    const color = node.color ?? DEFAULT_STROKE;
    const fontSize = node.fontSize ?? DEFAULT_FONT_SIZE;

    if (node.type === 'text') {
      const maxW = node.w;
      const m = textMetrics(node.label ?? '', fontSize, maxW ?? null);
      const width = maxW !== undefined ? Math.max(m.width, maxW) : m.width;
      const tel = textEl(seed, node.id, m.text, node.x, node.y, width, m.height, fontSize, color, {
        align: 'left',
        valign: 'top',
        original: node.label ?? '',
      });
      tel.autoResize = maxW === undefined;
      tel.frameId = frameId;
      tel.link = node.link ?? null;
      elements.push(tel);
      byId.set(node.id, tel);
      continue;
    }

    const fallback = DEFAULT_SIZES[node.type as 'rectangle' | 'ellipse' | 'diamond'];
    const w = node.w ?? fallback.w;
    const h = node.h ?? fallback.h;
    const el = baseEl(seed, node.id, node.type, node.x, node.y, w, h);
    el.strokeColor = color;
    el.backgroundColor = node.background ?? 'transparent';
    el.roundness = node.type === 'rectangle' ? { type: 3 } : null;
    el.frameId = frameId;
    el.link = node.link ?? null;
    elements.push(el);
    byId.set(node.id, el);

    if (node.label && attachContainerLabel(elements, seed, el, node.label, fontSize, { align: node.align, valign: node.valign, overflow: node.overflow })) {
      options.clipped?.push(node.id);
    }
  }

  sketch.edges.forEach((edge, index) => {
    const fromEl = byId.get(edge.from);
    const toEl = byId.get(edge.to);
    if (!fromEl) throw new Error(`edge references unknown node "${edge.from}"`);
    if (!toEl) throw new Error(`edge references unknown node "${edge.to}"`);
    const arrowId = edge.id ?? `e${index}`;
    if (byId.has(arrowId)) throw new Error(`edge id "${arrowId}" collides with a node id`);

    const elbowed = edge.elbowed !== false;
    const [autoFrom, autoTo] = pickSides(fromEl, toEl);
    const fromSide = edge.fromSide ?? autoFrom;
    const toSide = edge.toSide ?? autoTo;
    const fromFrac = SIDE_FRACTION[fromSide];
    const toFrac = SIDE_FRACTION[toSide];
    const sx = fromEl.x + fromEl.width * fromFrac.left;
    const sy = fromEl.y + fromEl.height * fromFrac.top;
    const ex = toEl.x + toEl.width * toFrac.left;
    const ey = toEl.y + toEl.height * toFrac.top;
    const abs: [number, number][] = elbowed ? elbowRoute([sx, sy], fromSide, [ex, ey], toSide) : [[sx, sy], [ex, ey]];
    const pts: [number, number][] = abs.map(([px, py]) => [px - sx, py - sy]);
    const bw = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
    const bh = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));

    const el = baseEl(seed, arrowId, 'arrow', sx, sy, bw, bh);
    el.points = pts;
    el.lastCommittedPoint = null;
    el.startArrowhead = edge.start === 'arrow' ? 'arrow' : null;
    el.endArrowhead = edge.end === null ? null : 'arrow';
    el.strokeColor = edge.color ?? DEFAULT_STROKE;
    el.elbowed = elbowed;
    el.startBinding = null;
    el.endBinding = null;
    if (elbowed) {
      el.fixedSegments = [];
      el.startIsSpecial = false;
      el.endIsSpecial = false;
    }

    // Frames and free text are not good binding anchors (same rule
    // confluenceWhiteboard.ts's converter uses) — the arrow still visually
    // terminates at the right point, it just isn't a live excalidraw binding.
    const bindable = (e: ExcalidrawElement) => e.type !== 'frame' && e.type !== 'text' && e.type !== 'image';
    if (bindable(fromEl)) {
      el.startBinding = { elementId: fromEl.id, focus: 0, gap: 4, ...fixedPointOf(elbowed, fromFrac) };
      fromEl.boundElements = [...(fromEl.boundElements ?? []), { id: el.id, type: 'arrow' }];
    }
    if (bindable(toEl)) {
      el.endBinding = { elementId: toEl.id, focus: 0, gap: 4, ...fixedPointOf(elbowed, toFrac) };
      toEl.boundElements = [...(toEl.boundElements ?? []), { id: el.id, type: 'arrow' }];
    }
    elements.push(el);

    if (edge.label) {
      const fontSize = DEFAULT_FONT_SIZE;
      const maxW = boundTextMaxWidth(el, fontSize);
      const m = textMetrics(edge.label, fontSize, maxW);
      const tel = textEl(seed, `t-${arrowId}`, m.text, 0, 0, Math.min(m.width, maxW), m.height, fontSize, edge.color ?? DEFAULT_EDGE_LABEL_COLOR, {
        align: 'center',
        valign: 'middle',
        container: el.id,
        original: edge.label,
      });
      placeBoundText(el, tel);
      el.boundElements = [...(el.boundElements ?? []), { id: tel.id, type: 'text' }];
      elements.push(tel);
    }
  });

  const bg = sketch.background ?? '#ffffff';
  const visible = elements.filter((e) => !e.containerId);
  let appState: Record<string, unknown>;
  if (visible.length) {
    const minx = Math.min(...visible.map((e) => e.x));
    const miny = Math.min(...visible.map((e) => e.y));
    const maxx = Math.max(...visible.map((e) => e.x + e.width));
    const maxy = Math.max(...visible.map((e) => e.y + e.height));
    const w = maxx - minx;
    const h = maxy - miny;
    const zoom = Math.max(0.05, Math.min(1, 1500 / Math.max(w, 1), 850 / Math.max(h, 1)));
    appState = { viewBackgroundColor: bg, gridSize: null, scrollX: -minx + 40, scrollY: -miny + 40, zoom: { value: Math.round(zoom * 1000) / 1000 } };
  } else {
    appState = { viewBackgroundColor: bg, gridSize: null };
  }

  return { type: 'excalidraw', version: 2, source: 'folio-ai-board', elements, appState, files };
}
