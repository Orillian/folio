import { describe, expect, it } from 'vitest';
import type { CanvasDocument } from '@shared/contracts';
import {
  canvasBounds,
  cardColors,
  edgeModels,
  initialView,
  layers,
  previewLine,
  safeExternalUrl,
  spaceFileUrl,
  urlDomain,
  visibleCards,
  withAlpha,
} from './renderModel';

const doc: CanvasDocument = {
  nodes: [
    { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 50, color: '1' },
    { id: 'g', type: 'group', x: -20, y: -20, width: 600, height: 120, label: 'G' },
    { id: 'b', type: 'text', text: 'B', x: 400, y: 0, width: 100, height: 50, color: '#00ff00' },
  ],
  edges: [
    { id: 'e', fromNode: 'a', fromEnd: 'none', toNode: 'b', toEnd: 'arrow', color: '5', label: 'next' },
    { id: 'ghost', fromNode: 'a', fromEnd: 'none', toNode: 'nope', toEnd: 'arrow' },
  ],
};

describe('colours', () => {
  it('withAlpha turns hex into rgba and leaves other colours alone', () => {
    expect(withAlpha('#e93147', 0.1)).toBe('rgba(233, 49, 71, 0.1)');
    expect(withAlpha('#0f0', 0.5)).toBe('rgba(0, 255, 0, 0.5)');
    expect(withAlpha('var(--x)', 0.5)).toBe('var(--x)');
  });

  it('a coloured card: Obsidian’s preset as the border, a faint wash as the fill — per scheme', () => {
    expect(cardColors('1', 'light')).toEqual({ border: '#e93147', fill: 'rgba(233, 49, 71, 0.08)', labelFill: 'rgba(233, 49, 71, 0.2)' });
    expect(cardColors('1', 'dark')).toEqual({ border: '#fb464c', fill: 'rgba(251, 70, 76, 0.16)', labelFill: 'rgba(251, 70, 76, 0.3)' });
    expect(cardColors('#00ff00', 'dark', 'group').fill).toBe('rgba(0, 255, 0, 0.1)');
    expect(cardColors(undefined, 'light')).toEqual({});
  });
});

describe('edgeModels', () => {
  it('draws every edge between cards on the canvas, with its colour, arrow and label', () => {
    const edges = edgeModels(doc, 'light');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ id: 'e', color: '#00bfbc', startArrow: null, label: 'next' });
    expect(edges[0].path).toBe('M 100 25 C 250 25, 250 25, 400 25');
    expect(edges[0].endArrow).toBe('400,25 386,31 386,19');
    expect(edges[0].labelAt).toEqual({ x: 250, y: 25 });
    expect(edgeModels(doc, 'dark')[0].color).toBe('#53dfdd');
  });
});

describe('first view', () => {
  it('is null until the container has a size, then a fit clamped to 10%..100%', () => {
    expect(initialView(doc, 0, 0)).toBeNull();
    expect(initialView(doc, 1200, 800)?.zoom).toBe(1);
    const huge: CanvasDocument = { nodes: [{ id: 'x', type: 'text', text: '', x: 0, y: 0, width: 200000, height: 100 }], edges: [] };
    expect(initialView(huge, 1200, 800)?.zoom).toBe(0.1);
    expect(canvasBounds(doc)).toEqual({ x: -20, y: -20, width: 600, height: 120 });
  });

  it('splits groups from cards and mounts only what is near the viewport', () => {
    const { groups, cards } = layers(doc);
    expect(groups.map((g) => g.id)).toEqual(['g']);
    expect(cards.map((c) => c.id)).toEqual(['a', 'b']);
    // A 200px-wide window at 100% looking at x 0..200 (plus half a screen either side) holds `a`, not `b` at 400.
    expect(visibleCards(cards, { x: 0, y: 0, zoom: 1 }, 200, 200).map((c) => c.id)).toEqual(['a']);
    expect(visibleCards(cards, { x: 0, y: 0, zoom: 0.5 }, 200, 200).map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('cards', () => {
  it('previewLine: the first non-empty line without Markdown markers', () => {
    expect(previewLine('\n## **Big** idea\nmore')).toBe('Big idea');
    expect(previewLine('- [ ] [[Note|alias]] and [link](x.md)')).toBe('alias and link');
    expect(previewLine('> [!warning]- Risk\n> body')).toBe('Risk');
  });

  it('link cards: domain, and only http(s)/mailto are clickable', () => {
    expect(urlDomain('https://www.example.com/a?b')).toBe('example.com');
    expect(urlDomain('not a url')).toBe('not a url');
    expect(safeExternalUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,x')).toBeNull();
  });

  it('space file URLs are encoded per segment, with the share token for a guest', () => {
    expect(spaceFileUrl('my space', 'Attach ments/pic #1.png')).toBe('/files/my%20space/Attach%20ments/pic%20%231.png');
    expect(spaceFileUrl('s', 'a.png', 't k')).toBe('/files/s/a.png?share=t%20k');
  });
});
