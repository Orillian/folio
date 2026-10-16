import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANVAS_MAX_EDGES, CANVAS_MAX_NODES, parseJsonCanvas, readCanvasJson, validCanvasColor } from './parse.js';

/** jsoncanvas.org's own sample (donors/obsidian/jsoncanvas/sample.canvas), inlined: tab-indented, as Obsidian writes it. */
const SPEC_SAMPLE = `{
\t"nodes":[
\t\t{"id":"754a8ef995f366bc","type":"group","x":-300,"y":-460,"width":610,"height":200,"label":"JSON Canvas"},
\t\t{"id":"8132d4d894c80022","type":"file","file":"readme.md","x":-280,"y":-200,"width":570,"height":560,"color":"6"},
\t\t{"id":"7efdbbe0c4742315","type":"file","file":"_site/logo.svg","x":-280,"y":-440,"width":217,"height":80},
\t\t{"id":"59e896bc8da20699","type":"text","text":"Learn more:\\n\\n- [Apps](/docs/apps.md)\\n- [Spec](spec/1.0.md)\\n- [Github](https://github.com/obsidianmd/jsoncanvas)","x":40,"y":-440,"width":250,"height":160},
\t\t{"id":"0ba565e7f30e0652","type":"file","file":"spec/1.0.md","x":360,"y":-400,"width":400,"height":400}
\t],
\t"edges":[
\t\t{"id":"6fa11ab87f90b8af","fromNode":"7efdbbe0c4742315","fromSide":"right","toNode":"59e896bc8da20699","toSide":"left"}
\t]
}`;

describe('parseJsonCanvas', () => {
  it('reads the spec sample: every node type, z-order kept, edge ends defaulted (fromEnd none, toEnd arrow)', () => {
    const result = parseJsonCanvas(SPEC_SAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(result.document.nodes.map((n) => n.type)).toEqual(['group', 'file', 'file', 'text', 'file']);
    expect(result.document.nodes[0]).toEqual({ id: '754a8ef995f366bc', type: 'group', x: -300, y: -460, width: 610, height: 200, label: 'JSON Canvas' });
    expect(result.document.nodes[1]).toMatchObject({ type: 'file', file: 'readme.md', color: '6' });
    expect(result.document.edges).toEqual([
      { id: '6fa11ab87f90b8af', fromNode: '7efdbbe0c4742315', fromSide: 'right', fromEnd: 'none', toNode: '59e896bc8da20699', toSide: 'left', toEnd: 'arrow' },
    ]);
  });

  it('reads the donor sample file on disk the same way', () => {
    const file = path.resolve(import.meta.dirname, '../../../../../donors/obsidian/jsoncanvas/sample.canvas');
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return; // the donors folder is not part of every checkout
    }
    const result = parseJsonCanvas(text);
    expect(result.ok && result.document.nodes.length).toBe(5);
  });

  it('tolerates unknown keys at every level and drops them', () => {
    const result = parseJsonCanvas(
      JSON.stringify({
        version: 3,
        plugin: { anything: true },
        nodes: [{ id: 'a', type: 'text', text: 'hi', x: 0, y: 0, width: 10, height: 10, styleAttributes: { shape: 'pill' }, zIndex: 4 }],
        edges: [{ id: 'e', fromNode: 'a', toNode: 'a', pathfindingMethod: 'square' }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(result.document.nodes[0]).toEqual({ id: 'a', type: 'text', text: 'hi', x: 0, y: 0, width: 10, height: 10 });
    expect(Object.keys(result.document.edges[0]).sort()).toEqual(['fromEnd', 'fromNode', 'id', 'toEnd', 'toNode']);
  });

  it('an empty file or {} is an empty canvas; bad JSON and a non-object top level are readable errors', () => {
    expect(parseJsonCanvas('')).toEqual({ ok: true, document: { nodes: [], edges: [] }, warnings: [] });
    expect(parseJsonCanvas('  {}\n')).toEqual({ ok: true, document: { nodes: [], edges: [] }, warnings: [] });
    const bad = parseJsonCanvas('{"nodes": [');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/^The file is not valid JSON \(/);
    const list = parseJsonCanvas('[1,2]');
    expect(list).toEqual({ ok: false, error: 'The file is not a JSON Canvas: its top level is not an object.' });
  });

  it('skips bad nodes and edges with a warning each, and keeps the rest', () => {
    const result = readCanvasJson({
      nodes: [
        { id: 'ok', type: 'text', text: 'x', x: 0, y: 0, width: 100, height: 50 },
        { type: 'text', x: 0, y: 0, width: 1, height: 1 },
        { id: 'nopos', type: 'text', text: 'x' },
        { id: 'weird', type: 'sticker', x: 0, y: 0, width: 1, height: 1 },
        { id: 'ok', type: 'text', text: 'dup', x: 0, y: 0, width: 1, height: 1 },
        { id: 'nofile', type: 'file', x: 0, y: 0, width: 1, height: 1 },
        { id: 'nourl', type: 'link', x: 0, y: 0, width: 1, height: 1 },
        'garbage',
      ],
      edges: [
        { id: 'dangling', fromNode: 'ok', toNode: 'ghost' },
        { fromNode: 'ok', toNode: 'ok', fromSide: 'middle', toEnd: 'diamond', color: 'blue', label: 'self' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes.map((n) => n.id)).toEqual(['ok']);
    expect(result.warnings).toHaveLength(8);
    expect(result.warnings.join('\n')).toMatch(/unknown type "sticker"/);
    expect(result.warnings.join('\n')).toMatch(/used twice/);
    // An edge without an id gets one; a bad side / end / colour falls back to the spec defaults.
    expect(result.document.edges).toEqual([{ id: 'edge-2', fromNode: 'ok', fromEnd: 'none', toNode: 'ok', toEnd: 'arrow', label: 'self' }]);
  });

  it('keeps file subpaths that start with # and normalizes nothing else', () => {
    const result = readCanvasJson({
      nodes: [
        { id: 'h', type: 'file', file: 'Notes/A note.md', subpath: '#Heading two', x: 0, y: 0, width: 1, height: 1 },
        { id: 'b', type: 'file', file: 'Notes/A note.md', subpath: '#^block-1', x: 0, y: 0, width: 1, height: 1 },
        { id: 'n', type: 'file', file: 'Notes/A note.md', subpath: 'Heading', x: 0, y: 0, width: 1, height: 1 },
      ],
    });
    expect(result.ok && result.document.nodes).toEqual([
      { id: 'h', type: 'file', file: 'Notes/A note.md', subpath: '#Heading two', x: 0, y: 0, width: 1, height: 1 },
      { id: 'b', type: 'file', file: 'Notes/A note.md', subpath: '#^block-1', x: 0, y: 0, width: 1, height: 1 },
      { id: 'n', type: 'file', file: 'Notes/A note.md', x: 0, y: 0, width: 1, height: 1 },
    ]);
  });

  it('caps a huge canvas at CANVAS_MAX_NODES cards and CANVAS_MAX_EDGES edges, with a warning', () => {
    const nodes = Array.from({ length: CANVAS_MAX_NODES + 25 }, (_, i) => ({ id: `n${i}`, type: 'text', text: '', x: i, y: 0, width: 10, height: 10 }));
    const edges = Array.from({ length: CANVAS_MAX_EDGES + 3 }, (_, i) => ({ id: `e${i}`, fromNode: 'n0', toNode: 'n1' }));
    const result = readCanvasJson({ nodes, edges });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes).toHaveLength(CANVAS_MAX_NODES);
    expect(result.document.edges).toHaveLength(CANVAS_MAX_EDGES);
    expect(result.warnings).toEqual([
      `only the first ${CANVAS_MAX_NODES} cards are shown (the file has ${CANVAS_MAX_NODES + 25})`,
      `only the first ${CANVAS_MAX_EDGES} connections are shown (the file has ${CANVAS_MAX_EDGES + 3})`,
    ]);
  });

  it('keeps at most 20 warnings and says how many more there were', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, type: 'nope', x: 0, y: 0, width: 1, height: 1 }));
    const result = readCanvasJson({ nodes });
    expect(result.ok && result.warnings).toHaveLength(21);
    expect(result.ok && result.warnings[20]).toBe('…and 10 more');
  });
});

describe('validCanvasColor', () => {
  it('accepts the six presets (string or number) and hex colours, nothing else', () => {
    expect(['1', '6', 3].map(validCanvasColor)).toEqual(['1', '6', '3']);
    expect(['#f00', '#FF0000', '#ff000080'].map(validCanvasColor)).toEqual(['#f00', '#FF0000', '#ff000080']);
    expect(['0', '7', 'red', '#ggg', '', null].map(validCanvasColor)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });
});
