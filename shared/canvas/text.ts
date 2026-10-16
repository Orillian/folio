/**
 * Text views of a canvas — pure.
 *  - canvasSearchText: what search indexes for a canvas page (pages_index
 *    plain_text): group labels, text cards, link URLs and edge labels, in file
 *    order. File cards are left out on purpose — their path names another page,
 *    which this reader may not be allowed to see (the card shows "no access"
 *    then; a search snippet must not show the name either).
 *  - canvasOutline: the readable outline MCP read_page / fetch return for a
 *    canvas (groups with their cards, then the connections), with the file
 *    cards as the reader may see them.
 */
import type { CanvasDocument, CanvasFileTarget, CanvasNode } from '../contracts.js';
import { CANVAS_PRESET_NAMES } from './colors.js';
import { groupMembership } from './geometry.js';

export function canvasSearchText(doc: CanvasDocument): string {
  const parts: string[] = [];
  for (const node of doc.nodes) {
    if (node.type === 'group' && node.label) parts.push(node.label);
    else if (node.type === 'text' && node.text.trim()) parts.push(node.text);
    else if (node.type === 'link') parts.push(node.url);
  }
  for (const edge of doc.edges) if (edge.label) parts.push(edge.label);
  return parts.join('\n\n');
}

function colorNote(color: string | undefined): string {
  if (!color) return '';
  return ` · ${CANVAS_PRESET_NAMES[color] ?? color}`;
}

function geometryNote(node: CanvasNode): string {
  return `at ${Math.round(node.x)},${Math.round(node.y)} · ${Math.round(node.width)}×${Math.round(node.height)}${colorNote(node.color)}`;
}

/** One line naming a card, for the connections list. */
function shortName(node: CanvasNode, files: Record<string, CanvasFileTarget>): string {
  const clip = (s: string) => {
    const line = s.replace(/\s+/g, ' ').trim();
    return line.length > 60 ? `${line.slice(0, 59)}…` : line;
  };
  switch (node.type) {
    case 'text':
      return `${node.id} ("${clip(node.text) || 'empty'}")`;
    case 'link':
      return `${node.id} (${node.url})`;
    case 'group':
      return `${node.id} (group${node.label ? ` "${clip(node.label)}"` : ''})`;
    case 'file': {
      const target = files[node.id];
      if (!target || target.status === 'noAccess') return `${node.id} (not available)`;
      if (target.status === 'page') return `${node.id} ("${clip(target.title)}")`;
      return `${node.id} (${target.path})`;
    }
  }
}

function fileLine(node: Extract<CanvasNode, { type: 'file' }>, target: CanvasFileTarget | undefined): string {
  const geo = geometryNote(node);
  if (!target || target.status === 'noAccess') return `- [file ${node.id}] a page that is not available to you (${geo})`;
  const sub = node.subpath ?? '';
  if (target.status === 'page') return `- [file ${node.id}] "${target.title}" — ${target.kind} page ${target.pageId}, ${target.path}${sub} (${geo})`;
  if (target.status === 'file') return `- [file ${node.id}] ${target.media === 'other' ? 'file' : target.media} ${target.path} (${geo})`;
  return `- [file ${node.id}] missing: ${target.path}${sub} — nothing at that path now (${geo})`;
}

function nodeLines(node: CanvasNode, files: Record<string, CanvasFileTarget>, indent: string): string[] {
  switch (node.type) {
    case 'text': {
      const head = `${indent}- [text ${node.id}] (${geometryNote(node)})`;
      const body = node.text.trim() ? node.text.split('\n').map((l) => `${indent}  > ${l}`.trimEnd()) : [`${indent}  > (empty)`];
      return [head, ...body];
    }
    case 'file':
      return [indent + fileLine(node, files[node.id])];
    case 'link':
      return [`${indent}- [link ${node.id}] ${node.url} (${geometryNote(node)})`];
    case 'group':
      return [`${indent}- [group ${node.id}]${node.label ? ` "${node.label}"` : ''} (${geometryNote(node)})`];
  }
}

/** The canvas as Markdown text, for a model or a reader without the picture. */
export function canvasOutline(title: string, doc: CanvasDocument, files: Record<string, CanvasFileTarget>, warnings: readonly string[] = []): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(
    `JSON Canvas (read-only in Folio): ${doc.nodes.filter((n) => n.type !== 'group').length} card(s), ${doc.nodes.filter((n) => n.type === 'group').length} group(s), ${doc.edges.length} connection(s). Coordinates in canvas pixels, top-left corner.`,
  );
  const parentOf = groupMembership(doc);
  const children = new Map<string, CanvasNode[]>();
  for (const node of doc.nodes) {
    const parent = parentOf.get(node.id) ?? '';
    const list = children.get(parent) ?? [];
    list.push(node);
    children.set(parent, list);
  }
  const walk = (parent: string, depth: number) => {
    for (const node of children.get(parent) ?? []) {
      const indent = '  '.repeat(depth);
      lines.push(...nodeLines(node, files, indent));
      if (node.type === 'group') walk(node.id, depth + 1);
    }
  };
  lines.push('');
  lines.push('## Cards');
  lines.push('');
  if (doc.nodes.length === 0) lines.push('(empty canvas)');
  else walk('', 0);

  if (doc.edges.length > 0) {
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    lines.push('');
    lines.push('## Connections');
    lines.push('');
    for (const edge of doc.edges) {
      const from = byId.get(edge.fromNode);
      const to = byId.get(edge.toNode);
      if (!from || !to) continue;
      const arrow = edge.fromEnd === 'arrow' && edge.toEnd === 'arrow' ? '<->' : edge.toEnd === 'arrow' ? '->' : edge.fromEnd === 'arrow' ? '<-' : '--';
      const sides = edge.fromSide || edge.toSide ? ` [${edge.fromSide ?? 'auto'} to ${edge.toSide ?? 'auto'}]` : '';
      lines.push(`- ${shortName(from, files)} ${arrow} ${shortName(to, files)}${edge.label ? `: "${edge.label}"` : ''}${colorNote(edge.color)}${sides}`);
    }
  }
  if (warnings.length > 0) {
    lines.push('');
    lines.push('## Skipped while reading');
    lines.push('');
    for (const w of warnings) lines.push(`- ${w}`);
  }
  return `${lines.join('\n')}\n`;
}
