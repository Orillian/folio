/**
 * "Convert to Folio board" (owner, 16.10.2026: a canvas is shown as it is and
 * can be converted into our board). Makes a NEW `.excalidraw.svg` board from a
 * canvas page; the canvas itself is never touched (always kept).
 *
 * The canvas is translated into the board-sketch DSL (server/boardSketch.ts)
 * and built by the same buildSceneFromSketch + selfcheck the AI assistant's
 * boards go through, so the result is an ordinary, editable, collaborative
 * board:
 *  - geometry kept as it is (x, y, width, height);
 *  - a group -> a frame with the group's label (members: the cards lying
 *    inside it, by geometry — shared/canvas/geometry.ts groupMembership; a
 *    group inside a group becomes a frame of its own: frames do not nest);
 *  - a text card -> a rectangle holding its text as PLAIN text (Markdown
 *    flattened: headings, lists, links, wikilinks become their words, list
 *    markers stay) aligned top-left; text too long for the card is cut with
 *    "…" so the card keeps its size;
 *  - a note card -> a rectangle with the note's title and a link to the page
 *    (`#heading` / `#^block` kept); the note's content is not copied;
 *  - another page (board, canvas, PDF, …) -> the same, title + link;
 *  - an image -> an image element when the picture is small enough to carry
 *    inside the board (IMAGE_MAX_BYTES each, IMAGES_MAX_BYTES together), else a
 *    rectangle naming it with a link to the file;
 *  - audio / video / any other file -> a rectangle naming it, linked;
 *  - a web page card -> a rectangle with the URL, linked (no preview);
 *  - a card the converter may not open -> a "no access" rectangle, no link;
 *    a card whose file is gone -> a rectangle naming the missing path;
 *  - an edge -> an arrow between the same sides, with its label, colour and
 *    arrowheads; Obsidian's curves become right-angled routes;
 *  - colours: presets as Obsidian's light palette (shared/canvas/colors.ts),
 *    hex as written; a coloured card gets a light tint of its colour.
 * What is lost is counted in a CanvasConversionReport (the dialog shows it
 * before and after).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Code, List, ListItem, Nodes, PhrasingContent, Root, Table } from 'mdast';
import type { CanvasConversionLoss, CanvasConversionReport, CanvasDocument, CanvasFileTarget, CanvasNode } from '../shared/contracts.js';
import { groupMembership, normalizeHex, resolveCanvasColor, tintHex } from '../shared/canvas/index.js';
import { phrasingToPlainText } from '../shared/inlineText.js';
import { stripOfmComments } from '../shared/ofm/plainText.js';
import { parseMarkdownAst } from './markdownAst.js';
import {
  buildSceneFromSketch,
  type BoardSketchEdge,
  type BoardSketchImage,
  type BoardSketchImageNode,
  type BoardSketchNode,
  type BoardSketchWithImages,
} from './boardSketch.js';
import { renderSceneSvg, selfcheckWhiteboardSvg, type ExcalidrawScene } from './confluenceWhiteboard.js';
import { badRequest } from './errors.js';
import * as storage from './storage.js';
import type { PageIndexEntry } from './storage.js';
import * as gitSync from './gitSync.js';
import type { GitIdentity } from './git.js';
import { resolveCanvasFiles, type CanvasReader } from './canvasView.js';
import type { CanvasConvertBody, CanvasConvertResult } from '../shared/contracts.js';
import { parseJsonCanvas } from '../shared/canvas/index.js';

/** One picture larger than this stays a linked card (it would be carried twice in the board file: scene + preview). */
export const IMAGE_MAX_BYTES = 1_500_000;
/** All pictures of one conversion together. */
export const IMAGES_MAX_BYTES = 4_000_000;

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

const DEFAULT_STROKE = '#1e1e1e';
const MUTED_STROKE = '#868e96';

// ---------------------------------------------------------------------------
// Markdown -> plain text
// ---------------------------------------------------------------------------

const WIKILINK_RE = /(!?)\[\[([^\]|]*?)(?:\|([^\]]*))?\]\]/g;

/** `[[Note#Part|alias]]` -> `alias`, `[[folder/Note.md]]` -> `Note`, `![[img.png]]` -> `[img.png]`. */
function flattenWikilinks(text: string): string {
  return text.replace(WIKILINK_RE, (_whole, bang: string, target: string, alias: string | undefined) => {
    if (alias && alias.trim() && !bang) return alias.trim();
    const name = target.split('#')[0].split('/').pop()?.trim() ?? '';
    const shown = name.replace(/\.md$/i, '') || target.trim();
    return bang ? `[${shown}]` : shown;
  });
}

function inline(nodes: readonly PhrasingContent[]): string {
  return flattenWikilinks(phrasingToPlainText(nodes, { breakText: '\n', collapse: false }).replace(/[ \t]+/g, ' ').trim());
}

function blockLines(node: Nodes, out: string[], indent: string): void {
  switch (node.type) {
    case 'heading':
    case 'paragraph':
      for (const line of inline(node.children).split('\n')) out.push(indent + line);
      return;
    case 'list': {
      const list = node as List;
      list.children.forEach((item: ListItem, i) => {
        const marker = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : list.ordered ? `${(list.start ?? 1) + i}. ` : '• ';
        const inner: string[] = [];
        for (const child of item.children) blockLines(child, inner, '');
        inner.forEach((line, j) => out.push(indent + (j === 0 ? marker : ' '.repeat(marker.length)) + line));
      });
      return;
    }
    case 'blockquote': {
      const inner: string[] = [];
      for (const child of node.children) blockLines(child, inner, '');
      // A callout (`> [!warning] Title`): its marker goes, its title stays.
      if (inner.length > 0) inner[0] = inner[0].replace(/^\[![^\]]*\][+-]?\s*/, '');
      for (const line of inner) out.push(`${indent}│ ${line}`.trimEnd());
      return;
    }
    case 'code':
      for (const line of (node as Code).value.split('\n')) out.push(indent + line);
      return;
    case 'table':
      for (const row of (node as Table).children) out.push(indent + row.children.map((cell) => inline(cell.children)).join(' | '));
      return;
    case 'thematicBreak':
      out.push(`${indent}———`);
      return;
    case 'html': {
      const text = node.value.replace(/<[^>]*>/g, '').trim();
      if (text) out.push(indent + text);
      return;
    }
    default:
      if ('children' in node) for (const child of node.children as Nodes[]) blockLines(child, out, indent);
  }
}

/**
 * A text card's Markdown as the plain text a board label can hold: one line
 * per block, list markers and checkboxes kept, emphasis / links / wikilinks
 * reduced to their words, `%%comments%%` dropped, blank lines between blocks
 * collapsed to one.
 */
export function flattenCardMarkdown(markdown: string): string {
  const source = stripOfmComments(markdown, parseMarkdownAst);
  const tree: Root = parseMarkdownAst(source);
  const blocks: string[] = [];
  for (const child of tree.children) {
    const lines: string[] = [];
    blockLines(child, lines, '');
    if (lines.length) blocks.push(lines.join('\n'));
  }
  return blocks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Canvas -> sketch
// ---------------------------------------------------------------------------

export interface CanvasConversionInput {
  space: string;
  document: CanvasDocument;
  files: Record<string, CanvasFileTarget>;
  /** Absolute app base, no trailing slash — page and file links point there. */
  baseUrl: string;
  /** Picture bytes by space path (images that fit the caps); a missing one makes a linked card. */
  pictures: ReadonlyMap<string, BoardSketchImage>;
}

export interface CanvasConversion {
  scene: ExcalidrawScene;
  report: CanvasConversionReport;
}

function strokeOf(color: string | undefined): string | undefined {
  const resolved = resolveCanvasColor(color, 'light');
  return resolved ? (normalizeHex(resolved) ?? resolved) : undefined;
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** Builds the board scene and the loss report. Pure: the caller resolved the files and read the pictures. */
export function convertCanvasDocument(input: CanvasConversionInput): CanvasConversion {
  const { document: doc, files, baseUrl, space } = input;
  const losses = new Map<CanvasConversionLoss['code'], number>();
  const lose = (code: CanvasConversionLoss['code'], n = 1) => losses.set(code, (losses.get(code) ?? 0) + n);

  const parentOf = groupMembership(doc);
  const nodes: Array<BoardSketchNode | BoardSketchImageNode> = [];
  const images = new Map<string, BoardSketchImage>();
  const pageLink = (pageId: string, subpath?: string) =>
    `${baseUrl}/s/${encodeURIComponent(space)}/p/${encodeURIComponent(pageId)}${subpath ? `#${encodeURIComponent(subpath.replace(/^#/, ''))}` : ''}`;
  const fileLink = (p: string) => `${baseUrl}/files/${encodeURIComponent(space)}/${encodePath(p)}`;
  // Sketch ids must not collide with the ids the builder mints for bound texts (`t-<id>`) and arrows (`e<n>`).
  const sid = (id: string) => `c-${id}`;

  for (const node of doc.nodes) {
    // A frame member must be another frame's NON-frame child: frames do not nest in excalidraw.
    const parent = parentOf.get(node.id);
    const frame = node.type !== 'group' && parent !== undefined ? sid(parent) : undefined;
    if (node.type === 'group' && parent !== undefined) lose('nestedGroups');
    const stroke = strokeOf(node.color);
    const card = (label: string, opts: { link?: string; muted?: boolean } = {}): BoardSketchNode => ({
      id: sid(node.id),
      type: 'rectangle',
      x: node.x,
      y: node.y,
      w: node.width,
      h: node.height,
      label,
      color: stroke ?? (opts.muted ? MUTED_STROKE : DEFAULT_STROKE),
      background: stroke ? (tintHex(stroke, 0.14) ?? 'transparent') : 'transparent',
      align: 'left',
      valign: 'top',
      overflow: 'clip',
      ...(frame ? { frame } : {}),
      ...(opts.link ? { link: opts.link } : {}),
    });
    switch (node.type) {
      case 'group':
        nodes.push({
          id: sid(node.id),
          type: 'frame',
          x: node.x,
          y: node.y,
          w: node.width,
          h: node.height,
          label: node.label ?? '',
          ...(stroke ? { color: stroke } : {}),
        });
        if (node.background) lose('groupBackground');
        break;
      case 'text': {
        const flat = flattenCardMarkdown(node.text);
        if (flat !== node.text.trim()) lose('markdownFlattened');
        nodes.push(card(flat));
        break;
      }
      case 'link':
        lose('linkPreview');
        nodes.push(card(`🔗 ${node.url}`, { link: node.url }));
        break;
      case 'file':
        nodes.push(fileCard(node, files[node.id], card, images, input.pictures, pageLink, fileLink, lose, frame));
        break;
    }
  }

  const edges: BoardSketchEdge[] = [];
  doc.edges.forEach((edge) => {
    // An edge to or from a group: frames are no binding anchors, the arrow still starts/ends at the frame's side.
    edges.push({
      id: `a-${edge.id}`,
      from: sid(edge.fromNode),
      to: sid(edge.toNode),
      ...(edge.label ? { label: edge.label } : {}),
      start: edge.fromEnd === 'arrow' ? 'arrow' : null,
      end: edge.toEnd === 'arrow' ? 'arrow' : null,
      ...(strokeOf(edge.color) ? { color: strokeOf(edge.color) } : {}),
      ...(edge.fromSide ? { fromSide: edge.fromSide } : {}),
      ...(edge.toSide ? { toSide: edge.toSide } : {}),
    });
  });
  if (doc.edges.length > 0) lose('edgeRouting', doc.edges.length);

  const clipped: string[] = [];
  const sketch: BoardSketchWithImages = { background: '#ffffff', nodes, edges };
  const scene = nodes.length > 0 ? buildSceneFromSketch(sketch, { images, clipped }) : emptyScene();
  if (clipped.length) lose('textCut', clipped.length);

  const order: CanvasConversionLoss['code'][] = [
    'markdownFlattened',
    'textCut',
    'noteContentNotEmbedded',
    'imageAsCard',
    'mediaAsCard',
    'linkPreview',
    'groupBackground',
    'nestedGroups',
    'edgeRouting',
    'noAccessCards',
    'missingCards',
  ];
  return {
    scene,
    report: {
      losses: order.filter((code) => losses.has(code)).map((code) => ({ code, count: losses.get(code)! })),
      nodes: doc.nodes.length,
      edges: doc.edges.length,
    },
  };
}

function emptyScene(): ExcalidrawScene {
  return { type: 'excalidraw', version: 2, source: 'folio-ai-board', elements: [], appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {} };
}

function fileCard(
  node: Extract<CanvasNode, { type: 'file' }>,
  target: CanvasFileTarget | undefined,
  card: (label: string, opts?: { link?: string; muted?: boolean }) => BoardSketchNode,
  images: Map<string, BoardSketchImage>,
  pictures: ReadonlyMap<string, BoardSketchImage>,
  pageLink: (pageId: string, subpath?: string) => string,
  fileLink: (p: string) => string,
  lose: (code: CanvasConversionLoss['code'], n?: number) => void,
  frame: string | undefined,
): BoardSketchNode | BoardSketchImageNode {
  if (!target || target.status === 'noAccess') {
    lose('noAccessCards');
    return card('🔒 No access', { muted: true });
  }
  if (target.status === 'missing') {
    lose('missingCards');
    return card(`⚠ Missing: ${target.path}${node.subpath ?? ''}`, { muted: true });
  }
  if (target.status === 'page') {
    if (target.kind === 'doc') lose('noteContentNotEmbedded');
    const icon = target.icon ?? (target.kind === 'doc' ? '📄' : target.kind === 'board' ? '🧩' : target.kind === 'canvas' ? '🗺' : '📎');
    const sub = node.subpath ? ` › ${node.subpath.replace(/^#\^?/, '')}` : '';
    return card(`${icon} ${target.title}${sub}`, { link: pageLink(target.pageId, node.subpath) });
  }
  if (target.media === 'image') {
    const picture = pictures.get(target.path);
    if (picture) {
      images.set(`c-${node.id}`, picture);
      return { id: `c-${node.id}`, type: 'image', x: node.x, y: node.y, w: node.width, h: node.height, ...(frame ? { frame } : {}) };
    }
    lose('imageAsCard');
    return card(`🖼 ${target.path}`, { link: fileLink(target.path) });
  }
  lose('mediaAsCard');
  return card(`📎 ${target.path}`, { link: fileLink(target.path) });
}

/**
 * The pictures of the image cards that fit the caps, read from the space's
 * content root (`root`), first come first served in card order. Anything that
 * fails to read just stays a linked card.
 */
export async function readCanvasPictures(root: string, doc: CanvasDocument, files: Record<string, CanvasFileTarget>): Promise<Map<string, BoardSketchImage>> {
  const out = new Map<string, BoardSketchImage>();
  let total = 0;
  for (const node of doc.nodes) {
    const target = files[node.id];
    if (node.type !== 'file' || !target || target.status !== 'file' || target.media !== 'image' || out.has(target.path)) continue;
    const ext = target.path.slice(target.path.lastIndexOf('.') + 1).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) continue;
    const abs = path.join(root, ...target.path.split('/'));
    if (!abs.startsWith(root + path.sep)) continue;
    const stat = await fs.lstat(abs).catch(() => null);
    if (!stat?.isFile() || stat.size > IMAGE_MAX_BYTES || total + stat.size > IMAGES_MAX_BYTES) continue;
    const bytes = await fs.readFile(abs).catch(() => null);
    if (!bytes) continue;
    total += bytes.length;
    out.set(target.path, { mimeType: mime, dataURL: `data:${mime};base64,${bytes.toString('base64')}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The page operation
// ---------------------------------------------------------------------------

/** The canvas of `entry` resolved for `reader` (no excerpts), with the pictures that fit. Throws 400 for a canvas that cannot be read. */
async function loadForConversion(entry: PageIndexEntry, reader: CanvasReader, baseUrl: string): Promise<CanvasConversion> {
  const raw = await storage.readCanvasRaw(entry.id);
  if ('error' in raw) throw badRequest(raw.error);
  const parsed = parseJsonCanvas(raw.text);
  if (!parsed.ok) throw badRequest(parsed.error);
  const resolved = await resolveCanvasFiles(entry.space, parsed.document, reader, { excerpts: false });
  const pictures = await readCanvasPictures(storage.getSpaceDir(entry.space), resolved.document, resolved.files);
  const conversion = convertCanvasDocument({ space: entry.space, document: resolved.document, files: resolved.files, baseUrl, pictures });
  // Cards and connections the reader skipped (bad JSON entries) are lost too.
  if (parsed.warnings.length > 0) conversion.report.losses.push({ code: 'skippedInvalid', count: parsed.warnings.length });
  return conversion;
}

/** What converting the canvas would lose, for the dialog — nothing is written. */
export async function canvasConversionReport(entry: PageIndexEntry, reader: CanvasReader, baseUrl: string): Promise<CanvasConversionReport> {
  return (await loadForConversion(entry, reader, baseUrl)).report;
}

/**
 * Creates the board next to the canvas (or in `body.parentPath`) and commits it
 * at once, as `author`, in one commit of its own. The canvas file is not
 * touched. Throws 400 when the canvas cannot be read or the scene fails the
 * board selfcheck (nothing is written then).
 */
export async function convertCanvasPage(
  entry: PageIndexEntry,
  reader: CanvasReader,
  body: CanvasConvertBody,
  author: GitIdentity,
  baseUrl: string,
): Promise<CanvasConvertResult> {
  if (entry.kind !== 'canvas') throw badRequest('page is not a canvas');
  const { scene, report } = await loadForConversion(entry, reader, baseUrl);
  const svg = renderSceneSvg(scene);
  try {
    selfcheckWhiteboardSvg(svg);
  } catch (err) {
    throw badRequest(`the board could not be built from this canvas: ${err instanceof Error ? err.message : String(err)}`);
  }
  const title = body.title?.trim() || `${entry.title} (board)`;
  const parentPath = body.parentPath ?? entry.dirPath;
  const board = await storage.createPage({ space: entry.space, parentPath, title, kind: 'board' }, { boardSvg: svg });
  await gitSync.commitNow(entry.space, `docs: convert canvas ${entry.relPath} -> ${board.path}`, author);
  return { board, report };
}
