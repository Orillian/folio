import { describe, expect, it } from 'vitest';
import type { CanvasDocument, CanvasNode } from '../contracts.js';
import {
  boundsOf,
  controlOffset,
  drawOrder,
  edgeGeometry,
  facingSides,
  FIT_MAX_ZOOM,
  FIT_MIN_ZOOM,
  fitView,
  groupMembership,
  MAX_ZOOM,
  MIN_ZOOM,
  sideAnchor,
  zoomAround,
} from './geometry.js';

const box = (id: string, x: number, y: number, width: number, height: number, type: CanvasNode['type'] = 'text'): CanvasNode =>
  (type === 'group' ? { id, type, x, y, width, height } : { id, type: 'text', text: id, x, y, width, height }) as CanvasNode;

describe('fitView', () => {
  it('waits for a real viewport: no fit into a 0x0 (or tiny) container', () => {
    const bounds = { x: 0, y: 0, width: 100, height: 100 };
    expect(fitView(bounds, 0, 0)).toBeNull();
    expect(fitView(bounds, 800, 0)).toBeNull();
    expect(fitView(bounds, 30, 600)).toBeNull();
    expect(fitView(bounds, NaN, 600)).toBeNull();
  });

  it('never zooms a small canvas in past 100%, and centres it', () => {
    const v = fitView({ x: 0, y: 0, width: 200, height: 100 }, 1000, 800)!;
    expect(v.zoom).toBe(FIT_MAX_ZOOM);
    expect(v).toEqual({ x: 400, y: 350, zoom: 1 });
  });

  it('never zooms a huge canvas out past 10%', () => {
    const v = fitView({ x: -50000, y: -50000, width: 100000, height: 100000 }, 1000, 800)!;
    expect(v.zoom).toBe(FIT_MIN_ZOOM);
    // The centre of the content lands in the centre of the viewport.
    expect(v.x + 0 * v.zoom).toBeCloseTo(500);
    expect(v.y + 0 * v.zoom).toBeCloseTo(400);
  });

  it('fits a medium canvas with padding', () => {
    const v = fitView({ x: 100, y: 100, width: 2000, height: 1000 }, 1040, 800)!;
    expect(v.zoom).toBeCloseTo(0.48); // (1040 - 80) / 2000
    const left = 100 * v.zoom + v.x;
    const right = 2100 * v.zoom + v.x;
    expect(left).toBeCloseTo(40);
    expect(right).toBeCloseTo(1000);
  });

  it('an empty canvas shows the origin at 100%', () => {
    expect(fitView(null, 600, 400)).toEqual({ x: 300, y: 200, zoom: 1 });
  });
});

describe('zoomAround', () => {
  it('keeps the point under the cursor in place and clamps the zoom', () => {
    const view = { x: 10, y: 20, zoom: 1 };
    const at = { x: 300, y: 200 };
    const worldBefore = { x: (at.x - view.x) / view.zoom, y: (at.y - view.y) / view.zoom };
    const z = zoomAround(view, 2, at);
    expect(z.zoom).toBe(2);
    expect((at.x - z.x) / z.zoom).toBeCloseTo(worldBefore.x);
    expect((at.y - z.y) / z.zoom).toBeCloseTo(worldBefore.y);
    expect(zoomAround(view, 1000, at).zoom).toBe(MAX_ZOOM);
    expect(zoomAround(view, 0.0001, at).zoom).toBe(MIN_ZOOM);
  });
});

describe('edges', () => {
  const a = { x: 0, y: 0, width: 100, height: 50 };
  const b = { x: 400, y: 0, width: 100, height: 50 };

  it('side anchors sit in the middle of each side', () => {
    expect(sideAnchor(a, 'top')).toEqual({ x: 50, y: 0 });
    expect(sideAnchor(a, 'right')).toEqual({ x: 100, y: 25 });
    expect(sideAnchor(a, 'bottom')).toEqual({ x: 50, y: 50 });
    expect(sideAnchor(a, 'left')).toEqual({ x: 0, y: 25 });
  });

  it('picks the facing sides when the file names none', () => {
    expect(facingSides(a, b)).toEqual(['right', 'left']);
    expect(facingSides(b, a)).toEqual(['left', 'right']);
    expect(facingSides(a, { x: 0, y: 300, width: 100, height: 50 })).toEqual(['bottom', 'top']);
  });

  it('draws a cubic curve leaving and entering at right angles, the arrow at the target by default', () => {
    const g = edgeGeometry({ fromEnd: 'none', toEnd: 'arrow' }, a, b);
    expect(g.start).toEqual({ x: 100, y: 25 });
    expect(g.end).toEqual({ x: 400, y: 25 });
    const off = controlOffset(g.start, g.end);
    expect(off).toBe(150);
    expect(g.c1).toEqual({ x: 250, y: 25 });
    expect(g.c2).toEqual({ x: 250, y: 25 });
    expect(g.path).toBe('M 100 25 C 250 25, 250 25, 400 25');
    expect(g.mid).toEqual({ x: 250, y: 25 });
    expect(g.startArrow).toBeNull();
    // The arrow points into the target: tip on the anchor, base 14px back along the curve.
    expect(g.endArrow).toEqual([
      { x: 400, y: 25 },
      { x: 386, y: 31 },
      { x: 386, y: 19 },
    ]);
  });

  it('honours written sides and both-end arrows', () => {
    const g = edgeGeometry({ fromSide: 'bottom', toSide: 'top', fromEnd: 'arrow', toEnd: 'none' }, a, { x: 0, y: 300, width: 100, height: 50 });
    expect(g.start).toEqual({ x: 50, y: 50 });
    expect(g.end).toEqual({ x: 50, y: 300 });
    expect(g.c1.y).toBeGreaterThan(g.start.y);
    expect(g.c2.y).toBeLessThan(g.end.y);
    expect(g.endArrow).toBeNull();
    // The start arrow points back into the source card (upwards).
    expect(g.startArrow![0]).toEqual({ x: 50, y: 50 });
    expect(g.startArrow![1].y).toBeGreaterThan(50);
  });

  it('keeps a minimum curvature for cards that touch', () => {
    expect(controlOffset({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(40);
    expect(controlOffset({ x: 0, y: 0 }, { x: 5000, y: 0 })).toBe(250);
  });
});

describe('groups', () => {
  const doc: CanvasDocument = {
    nodes: [
      box('card-outside', 900, 900, 50, 50),
      box('outer', 0, 0, 600, 600, 'group'),
      box('inner', 50, 50, 300, 300, 'group'),
      box('in-inner', 100, 100, 50, 50),
      box('in-outer', 400, 400, 50, 50),
      box('straddles', 550, 100, 100, 50),
    ],
    edges: [],
  };

  it('a card belongs to the smallest group that contains it whole', () => {
    const m = groupMembership(doc);
    expect(m.get('in-inner')).toBe('inner');
    expect(m.get('in-outer')).toBe('outer');
    expect(m.get('inner')).toBe('outer');
    expect(m.has('outer')).toBe(false);
    expect(m.has('straddles')).toBe(false);
    expect(m.has('card-outside')).toBe(false);
  });

  it('draws groups first, larger under smaller, then the cards in file order', () => {
    expect(drawOrder(doc).map((n) => n.id)).toEqual(['outer', 'inner', 'card-outside', 'in-inner', 'in-outer', 'straddles']);
  });

  it('bounds cover every card', () => {
    expect(boundsOf(doc.nodes)).toEqual({ x: 0, y: 0, width: 950, height: 950 });
    expect(boundsOf([])).toBeNull();
  });
});
