/**
 * "Convert to Folio board" — the pure half (canvas document + resolved files ->
 * excalidraw scene + loss report). The page operation (real PG + git) is in
 * canvasPages.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { CanvasDocument, CanvasFileTarget } from '../shared/contracts.js';
import { convertCanvasDocument, flattenCardMarkdown } from './canvasToBoard.js';
import { renderSceneSvg, selfcheckWhiteboardSvg, type ExcalidrawElement } from './confluenceWhiteboard.js';

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const doc: CanvasDocument = {
  nodes: [
    { id: 'g', type: 'group', x: 0, y: 0, width: 700, height: 400, label: 'Sprint', color: '4', background: 'img/bg.png' },
    { id: 'inner', type: 'group', x: 20, y: 40, width: 300, height: 300, label: 'Inner' },
    { id: 't', type: 'text', text: '# Goal\n\nShip **canvas** support, see [[Spec|the spec]].\n\n- [x] parser\n- [ ] renderer', x: 40, y: 80, width: 260, height: 160, color: '1' },
    { id: 'long', type: 'text', text: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'), x: 400, y: 40, width: 200, height: 80 },
    { id: 'note', type: 'file', file: 'Notes/Spec.md', subpath: '#Scope', x: 400, y: 200, width: 250, height: 100 },
    { id: 'pic', type: 'file', file: 'img/diagram.png', x: 800, y: 0, width: 120, height: 120 },
    { id: 'big', type: 'file', file: 'img/huge.png', x: 800, y: 150, width: 120, height: 120 },
    { id: 'clip', type: 'file', file: 'audio/talk.mp3', x: 800, y: 300, width: 120, height: 60 },
    { id: 'secret', type: 'file', file: '', x: 950, y: 0, width: 120, height: 60 },
    { id: 'gone', type: 'file', file: 'old.md', x: 950, y: 100, width: 120, height: 60 },
    { id: 'web', type: 'link', url: 'https://example.com/x', x: 950, y: 200, width: 200, height: 60, color: '#123456' },
  ],
  edges: [
    { id: 'e1', fromNode: 't', fromSide: 'right', fromEnd: 'none', toNode: 'note', toSide: 'left', toEnd: 'arrow', label: 'details', color: '6' },
    { id: 'e2', fromNode: 'note', fromEnd: 'arrow', toNode: 'web', toEnd: 'arrow' },
    { id: 'e3', fromNode: 'pic', fromEnd: 'none', toNode: 'g', toEnd: 'none' },
  ],
};
const files: Record<string, CanvasFileTarget> = {
  note: { status: 'page', pageId: 'P1', kind: 'doc', title: 'Spec', path: 'Notes/Spec.md' },
  pic: { status: 'file', path: 'img/diagram.png', media: 'image' },
  big: { status: 'file', path: 'img/huge.png', media: 'image' },
  clip: { status: 'file', path: 'audio/talk.mp3', media: 'audio' },
  secret: { status: 'noAccess' },
  gone: { status: 'missing', path: 'old.md' },
};

function convert() {
  return convertCanvasDocument({
    space: 'vault',
    document: doc,
    files,
    baseUrl: 'https://folio.test',
    pictures: new Map([['img/diagram.png', { mimeType: 'image/png', dataURL: PNG_1PX }]]),
  });
}

const byId = (elements: ExcalidrawElement[], id: string) => elements.find((e) => e.id === id)!;

describe('flattenCardMarkdown', () => {
  it('keeps the words and the list markers, drops the markup', () => {
    expect(flattenCardMarkdown('# Goal\n\nShip **canvas** support, see [[Spec|the spec]].\n\n- [x] parser\n- [ ] renderer')).toBe(
      'Goal\nShip canvas support, see the spec.\n☑ parser\n☐ renderer',
    );
    expect(flattenCardMarkdown('1. one\n2. [two](x.md) ![[pic.png]]\n\n> quote %%hidden%%\n\n```js\nlet a = 1;\n```')).toBe('1. one\n2. two [pic.png]\n│ quote\nlet a = 1;');
    expect(flattenCardMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('a | b\n1 | 2');
    expect(flattenCardMarkdown('> [!warning]- Risk\n> Body text.')).toBe('│ Risk\n│ Body text.');
  });
});

describe('convertCanvasDocument', () => {
  it('builds a scene that passes the board selfcheck', () => {
    const { scene } = convert();
    expect(selfcheckWhiteboardSvg(renderSceneSvg(scene))).toBe(scene.elements.length);
  });

  it('groups become frames with their label and colour; members by geometry, the inner group a frame of its own', () => {
    const { scene } = convert();
    const g = byId(scene.elements, 'c-g');
    expect(g).toMatchObject({ type: 'frame', x: 0, y: 0, width: 700, height: 400, name: 'Sprint', strokeColor: '#08b94e', frameId: null });
    const inner = byId(scene.elements, 'c-inner');
    expect(inner).toMatchObject({ type: 'frame', name: 'Inner', frameId: null });
    expect(byId(scene.elements, 'c-t').frameId).toBe('c-inner');
    expect(byId(scene.elements, 'c-long').frameId).toBe('c-g');
    expect(byId(scene.elements, 'c-pic').frameId).toBeNull();
  });

  it('a text card is a rectangle of the same geometry with its plain text top-left, cut to fit', () => {
    const { scene } = convert();
    const t = byId(scene.elements, 'c-t');
    expect(t).toMatchObject({ type: 'rectangle', x: 40, y: 80, width: 260, height: 160, strokeColor: '#e93147' });
    expect(t.backgroundColor).toMatch(/^#[0-9a-f]{6}$/);
    const label = byId(scene.elements, 't-c-t');
    expect(label).toMatchObject({ type: 'text', containerId: 'c-t', textAlign: 'left', verticalAlign: 'top' });
    expect(label.originalText).toBe('Goal\nShip canvas support, see the spec.\n☑ parser\n☐ renderer');
    const long = byId(scene.elements, 'c-long');
    expect(long).toMatchObject({ x: 400, y: 40, width: 200, height: 80 }); // the card keeps its size
    expect(byId(scene.elements, 't-c-long').text).toMatch(/…$/);
  });

  it('a note card is its title with a link to the page (subpath kept); images, files, links, no-access and missing cards', () => {
    const { scene } = convert();
    const note = byId(scene.elements, 'c-note');
    expect(note.link).toBe('https://folio.test/s/vault/p/P1#Scope');
    expect(byId(scene.elements, 't-c-note').originalText).toBe('📄 Spec › Scope');
    const pic = byId(scene.elements, 'c-pic');
    expect(pic).toMatchObject({ type: 'image', x: 800, y: 0, width: 120, height: 120, fileId: 'f-c-pic' });
    expect(scene.files['f-c-pic']).toMatchObject({ mimeType: 'image/png', dataURL: PNG_1PX });
    expect(byId(scene.elements, 'c-big')).toMatchObject({ type: 'rectangle', link: 'https://folio.test/files/vault/img/huge.png' });
    expect(byId(scene.elements, 'c-clip').link).toBe('https://folio.test/files/vault/audio/talk.mp3');
    expect(byId(scene.elements, 'c-secret').link).toBeNull();
    expect(byId(scene.elements, 't-c-secret').originalText).toBe('🔒 No access');
    expect(byId(scene.elements, 't-c-gone').originalText).toBe('⚠ Missing: old.md');
    expect(byId(scene.elements, 'c-web')).toMatchObject({ link: 'https://example.com/x', strokeColor: '#123456' });
  });

  it('edges become arrows between the same sides, with label, colour and arrowheads', () => {
    const { scene } = convert();
    const e1 = byId(scene.elements, 'a-e1');
    expect(e1).toMatchObject({ type: 'arrow', strokeColor: '#7852ee', startArrowhead: null, endArrowhead: 'arrow', elbowed: true });
    // Leaves the text card's right side, reaches the note's left side.
    expect(e1.x).toBe(300);
    expect(e1.y).toBe(160);
    const last = e1.points![e1.points!.length - 1];
    expect([e1.x + last[0], e1.y + last[1]]).toEqual([400, 250]);
    expect(e1.startBinding?.elementId).toBe('c-t');
    expect(e1.endBinding?.elementId).toBe('c-note');
    expect(byId(scene.elements, 't-a-e1')).toMatchObject({ containerId: 'a-e1', originalText: 'details' });
    const e2 = byId(scene.elements, 'a-e2');
    expect(e2).toMatchObject({ startArrowhead: 'arrow', endArrowhead: 'arrow' });
    // To a group: the frame is no binding anchor, the arrow still ends at its side.
    const e3 = byId(scene.elements, 'a-e3');
    expect(e3).toMatchObject({ startArrowhead: null, endArrowhead: null, endBinding: null });
  });

  it('reports what the board loses', () => {
    expect(convert().report).toEqual({
      nodes: 11,
      edges: 3,
      losses: [
        { code: 'markdownFlattened', count: 1 },
        { code: 'textCut', count: 1 },
        { code: 'noteContentNotEmbedded', count: 1 },
        { code: 'imageAsCard', count: 1 },
        { code: 'mediaAsCard', count: 1 },
        { code: 'linkPreview', count: 1 },
        { code: 'groupBackground', count: 1 },
        { code: 'nestedGroups', count: 1 },
        { code: 'edgeRouting', count: 3 },
        { code: 'noAccessCards', count: 1 },
        { code: 'missingCards', count: 1 },
      ],
    });
  });

  it('an empty canvas makes an empty board', () => {
    const { scene, report } = convertCanvasDocument({ space: 's', document: { nodes: [], edges: [] }, files: {}, baseUrl: '', pictures: new Map() });
    expect(scene.elements).toEqual([]);
    expect(report).toEqual({ nodes: 0, edges: 0, losses: [] });
  });
});
