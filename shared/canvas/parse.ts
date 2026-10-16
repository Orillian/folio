/**
 * JSON Canvas 1.0 reader (jsoncanvas.org/spec/1.0, Obsidian's `.canvas`) —
 * pure, shared by the server (index, read model, MCP outline, conversion) and
 * the web renderer's tests.
 *
 * Tolerant by design: the format promises forward compatibility ("arbitrary
 * keys", obsidian-api/canvas.d.ts), and a canvas written by another app or an
 * older plugin must still open. So:
 *  - unknown keys are ignored (never an error);
 *  - a node without a usable id / type / position / size, a node of an unknown
 *    type, a duplicate id, an edge to a node that is not there — skipped, with
 *    a warning the page shows;
 *  - a missing edge id gets one (`edge-<n>`), a bad side or end is dropped to
 *    the spec's default (`fromEnd` none, `toEnd` arrow), a colour that is
 *    neither a preset "1".."6" nor a hex colour is dropped;
 *  - an empty file is an empty canvas (Obsidian writes `{}` for a new one);
 *  - only text that is not JSON at all (or not an object at the top) fails,
 *    with a readable message — the page then shows that message, not a blank
 *    canvas.
 * Size caps (CANVAS_MAX_NODES / CANVAS_MAX_EDGES) keep one huge file from
 * stalling the scan or the browser: what is over the cap is cut, with a
 * warning. Coordinates are kept as numbers (the spec says integers; fractional
 * ones are accepted as they are).
 */
import type { CanvasBackgroundStyle, CanvasDocument, CanvasEdge, CanvasEnd, CanvasGroupNode, CanvasNode, CanvasSide } from '../contracts.js';

/** Bytes of a `.canvas` file Folio reads at all; a larger file is shown as an error page. */
export const CANVAS_MAX_BYTES = 8 * 1024 * 1024;
export const CANVAS_MAX_NODES = 5000;
export const CANVAS_MAX_EDGES = 10000;
/** At most this many warnings are kept (one bad generator can produce thousands of the same). */
const MAX_WARNINGS = 20;

export interface ParsedCanvas {
  document: CanvasDocument;
  warnings: string[];
}

export type CanvasParseResult = ({ ok: true } & ParsedCanvas) | { ok: false; error: string };

const SIDES = new Set<CanvasSide>(['top', 'right', 'bottom', 'left']);
const BACKGROUND_STYLES = new Set<CanvasBackgroundStyle>(['cover', 'ratio', 'repeat']);
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const PRESET_RE = /^[1-6]$/;

/** A preset ("1".."6") or a hex colour as written; anything else is undefined. */
export function validCanvasColor(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) value = String(value);
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return PRESET_RE.test(v) || HEX_COLOR_RE.test(v) ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

class Warnings {
  readonly list: string[] = [];
  private dropped = 0;
  add(message: string): void {
    if (this.list.length < MAX_WARNINGS) this.list.push(message);
    else this.dropped++;
  }
  done(): string[] {
    return this.dropped > 0 ? [...this.list, `…and ${this.dropped} more`] : this.list;
  }
}

function readNode(raw: unknown, index: number, warn: Warnings): CanvasNode | null {
  const at = `node ${index + 1}`;
  if (!isRecord(raw)) {
    warn.add(`${at}: not an object — skipped`);
    return null;
  }
  const id = typeof raw.id === 'string' ? raw.id : typeof raw.id === 'number' ? String(raw.id) : '';
  if (!id) {
    warn.add(`${at}: no id — skipped`);
    return null;
  }
  const x = finite(raw.x);
  const y = finite(raw.y);
  const width = finite(raw.width);
  const height = finite(raw.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    warn.add(`node "${id}": no position or size — skipped`);
    return null;
  }
  const base = { id, x, y, width: Math.max(1, width), height: Math.max(1, height) };
  const color = validCanvasColor(raw.color);
  const withColor = color ? { ...base, color } : base;
  switch (raw.type) {
    case 'text':
      return { ...withColor, type: 'text', text: typeof raw.text === 'string' ? raw.text : '' };
    case 'file': {
      const file = optionalString(raw.file)?.trim();
      if (!file) {
        warn.add(`node "${id}": a file card without a file — skipped`);
        return null;
      }
      const subpath = optionalString(raw.subpath)?.trim();
      return subpath && subpath.startsWith('#') && subpath.length > 1 ? { ...withColor, type: 'file', file, subpath } : { ...withColor, type: 'file', file };
    }
    case 'link': {
      const url = optionalString(raw.url)?.trim();
      if (!url) {
        warn.add(`node "${id}": a link card without a URL — skipped`);
        return null;
      }
      return { ...withColor, type: 'link', url };
    }
    case 'group': {
      const node: CanvasGroupNode = { ...withColor, type: 'group' };
      const label = optionalString(raw.label);
      if (label) node.label = label;
      const background = optionalString(raw.background)?.trim();
      if (background) node.background = background;
      const style = optionalString(raw.backgroundStyle) as CanvasBackgroundStyle | undefined;
      if (style && BACKGROUND_STYLES.has(style)) node.backgroundStyle = style;
      return node;
    }
    default:
      warn.add(`node "${id}": unknown type ${JSON.stringify(raw.type ?? null)} — skipped`);
      return null;
  }
}

function readSide(v: unknown): CanvasSide | undefined {
  return typeof v === 'string' && SIDES.has(v as CanvasSide) ? (v as CanvasSide) : undefined;
}

function readEnd(v: unknown, fallback: CanvasEnd): CanvasEnd {
  return v === 'arrow' || v === 'none' ? v : fallback;
}

function readEdge(raw: unknown, index: number, nodeIds: ReadonlySet<string>, usedIds: Set<string>, warn: Warnings): CanvasEdge | null {
  const at = `edge ${index + 1}`;
  if (!isRecord(raw)) {
    warn.add(`${at}: not an object — skipped`);
    return null;
  }
  const fromNode = typeof raw.fromNode === 'string' ? raw.fromNode : '';
  const toNode = typeof raw.toNode === 'string' ? raw.toNode : '';
  if (!nodeIds.has(fromNode) || !nodeIds.has(toNode)) {
    warn.add(`${typeof raw.id === 'string' ? `edge "${raw.id}"` : at}: connects a card that is not on the canvas — skipped`);
    return null;
  }
  let id = typeof raw.id === 'string' && raw.id ? raw.id : `edge-${index + 1}`;
  if (usedIds.has(id)) {
    let n = 2;
    while (usedIds.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  usedIds.add(id);
  const edge: CanvasEdge = { id, fromNode, fromEnd: readEnd(raw.fromEnd, 'none'), toNode, toEnd: readEnd(raw.toEnd, 'arrow') };
  const fromSide = readSide(raw.fromSide);
  if (fromSide) edge.fromSide = fromSide;
  const toSide = readSide(raw.toSide);
  if (toSide) edge.toSide = toSide;
  const color = validCanvasColor(raw.color);
  if (color) edge.color = color;
  const label = optionalString(raw.label);
  if (label && label.trim()) edge.label = label;
  return edge;
}

/** Reads already-parsed JSON (an object with `nodes` / `edges`). */
export function readCanvasJson(data: unknown): CanvasParseResult {
  if (!isRecord(data)) return { ok: false, error: 'The file is not a JSON Canvas: its top level is not an object.' };
  const warn = new Warnings();
  const rawNodes = data.nodes === undefined || data.nodes === null ? [] : data.nodes;
  const rawEdges = data.edges === undefined || data.edges === null ? [] : data.edges;
  if (!Array.isArray(rawNodes)) warn.add('"nodes" is not a list — no cards read');
  if (!Array.isArray(rawEdges)) warn.add('"edges" is not a list — no connections read');
  const nodeList = Array.isArray(rawNodes) ? rawNodes : [];
  const edgeList = Array.isArray(rawEdges) ? rawEdges : [];

  const nodes: CanvasNode[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < nodeList.length; i++) {
    if (nodes.length >= CANVAS_MAX_NODES) {
      warn.add(`only the first ${CANVAS_MAX_NODES} cards are shown (the file has ${nodeList.length})`);
      break;
    }
    const node = readNode(nodeList[i], i, warn);
    if (!node) continue;
    if (ids.has(node.id)) {
      warn.add(`node "${node.id}": the id is used twice — the second card is skipped`);
      continue;
    }
    ids.add(node.id);
    nodes.push(node);
  }

  const edges: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  for (let i = 0; i < edgeList.length; i++) {
    if (edges.length >= CANVAS_MAX_EDGES) {
      warn.add(`only the first ${CANVAS_MAX_EDGES} connections are shown (the file has ${edgeList.length})`);
      break;
    }
    const edge = readEdge(edgeList[i], i, ids, edgeIds, warn);
    if (edge) edges.push(edge);
  }
  return { ok: true, document: { nodes, edges }, warnings: warn.done() };
}

/** Reads the text of a `.canvas` file. */
export function parseJsonCanvas(text: string): CanvasParseResult {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (!trimmed) return { ok: true, document: { nodes: [], edges: [] }, warnings: [] };
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `The file is not valid JSON (${detail}).` };
  }
  return readCanvasJson(data);
}
