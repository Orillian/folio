import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import {
  REACTION_CHIPS_GAP_PX,
  REACTION_CHIPS_SELECTED_CLEARANCE_PX,
  REACTION_EMOJIS,
  REACTION_LABEL_KEYS,
  elementSceneBounds,
  elementVisualOutset,
  indexReactions,
  isReactable,
  parseReactionKey,
  reactionTarget,
  reactionChipsTop,
  reactionKey,
  reactionLabelKey,
  sceneToContainerPoint,
  toggleReaction,
} from './reactionsModel';

const rect = (over: Record<string, unknown> = {}) =>
  ({ id: 'r1', type: 'rectangle', x: 10, y: 20, width: 100, height: 50, angle: 0, version: 3, versionNonce: 1, isDeleted: false, ...over }) as unknown as ExcalidrawElement;

describe('reaction keys', () => {
  it('round-trips and rejects malformed keys', () => {
    expect(parseReactionKey(reactionKey('el1', '👍', 'guest:Amber Fox'))).toEqual({ elementId: 'el1', emoji: '👍', userId: 'guest:Amber Fox' });
    expect(parseReactionKey('nonsense')).toBeNull();
    expect(parseReactionKey('a|b')).toBeNull();
    expect(parseReactionKey('a|b|')).toBeNull();
  });
});

describe('toggleReaction (Y.Map)', () => {
  it('sets a key per (element, emoji, user) and deletes it on the second toggle', () => {
    const doc = new Y.Doc();
    const map = doc.getMap('reactions');
    expect(toggleReaction(doc, map, 'e1', '👍', 'u1', undefined, () => 5)).toBe(true);
    expect(map.get(reactionKey('e1', '👍', 'u1'))).toEqual({ at: 5 });
    expect(toggleReaction(doc, map, 'e1', '👍', 'u1')).toBe(false);
    expect(map.size).toBe(0);
  });

  it('keeps both reactions when two clients react to the same shape concurrently, in both merge directions', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    toggleReaction(a, a.getMap('reactions'), 'e1', '👍', 'alice', undefined, () => 2);
    toggleReaction(b, b.getMap('reactions'), 'e1', '👍', 'bob', undefined, () => 1);
    toggleReaction(b, b.getMap('reactions'), 'e1', '🎉', 'bob', undefined, () => 3);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const doc of [a, b]) {
      const index = indexReactions(doc.getMap('reactions'));
      expect(index.get('e1')?.get('👍')).toEqual(['bob', 'alice']); // oldest first
      expect(index.get('e1')?.get('🎉')).toEqual(['bob']);
    }
  });

  it('a removal propagates and does not disturb other users', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    toggleReaction(a, a.getMap('reactions'), 'e1', '👍', 'alice');
    toggleReaction(a, a.getMap('reactions'), 'e1', '👍', 'bob');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    toggleReaction(b, b.getMap('reactions'), 'e1', '👍', 'alice');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(indexReactions(a.getMap('reactions')).get('e1')?.get('👍')).toEqual(['bob']);
  });

  it('indexReactions skips malformed keys', () => {
    const doc = new Y.Doc();
    const map = doc.getMap('reactions');
    map.set('garbage', { at: 1 });
    map.set(reactionKey('e1', '❤️', 'u1'), 'not-an-object');
    expect([...indexReactions(map).get('e1')!.get('❤️')!]).toEqual(['u1']);
    expect(indexReactions(map).has('garbage')).toBe(false);
  });
});

describe('geometry', () => {
  it('skips connectors, deleted elements and bound text', () => {
    expect(isReactable(rect({ type: 'arrow' }))).toBe(false);
    expect(isReactable(rect({ isDeleted: true }))).toBe(false);
    expect(isReactable(rect({ type: 'text', containerId: 'r1' }))).toBe(false);
    expect(isReactable(rect({ type: 'text', containerId: null }))).toBe(true);
  });
  it('maps scene to container pixels through scroll, zoom and offsets', () => {
    const vp = { scrollX: -50, scrollY: 10, zoom: { value: 2 }, offsetLeft: 300, offsetTop: 80 };
    expect(sceneToContainerPoint({ x: 100, y: 0 }, vp, { left: 300, top: 80 })).toEqual({ x: 100, y: 20 });
  });
});

describe('reactionTarget (when the add button shows)', () => {
  const a = rect({ id: 'a' });
  const b = rect({ id: 'b', x: 300 });
  const label = rect({ id: 'label', type: 'text', containerId: 'a' });
  const arrow = rect({ id: 'arr', type: 'arrow' });
  const free = rect({ id: 'free', type: 'text', containerId: null });
  const scene = [a, b, label, arrow, free];
  const state = (over: Record<string, unknown> = {}, ids: string[] = ['a']) => ({
    selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])),
    viewModeEnabled: false,
    activeTool: { type: 'selection' },
    cursorButton: 'up',
    ...over,
  });

  it('is the single selected element, including free text', () => {
    expect(reactionTarget(scene, state())?.id).toBe('a');
    expect(reactionTarget(scene, state({}, ['free']))?.id).toBe('free');
  });
  it('maps a selected bound label (alone or with its container) to the container', () => {
    expect(reactionTarget(scene, state({}, ['label']))?.id).toBe('a');
    expect(reactionTarget(scene, state({}, ['a', 'label']))?.id).toBe('a');
  });
  it('is null with no selection, a multi-selection, a stale id, or a non-reactable element', () => {
    expect(reactionTarget(scene, state({}, []))).toBeNull();
    expect(reactionTarget(scene, { ...state(), selectedElementIds: { a: false } })).toBeNull();
    expect(reactionTarget(scene, state({}, ['a', 'b']))).toBeNull();
    expect(reactionTarget(scene, state({}, ['gone']))).toBeNull();
    expect(reactionTarget(scene, state({}, ['arr']))).toBeNull();
  });
  it('is null in View mode and with any tool other than selection', () => {
    expect(reactionTarget(scene, state({ viewModeEnabled: true }))).toBeNull();
    expect(reactionTarget(scene, state({ activeTool: { type: 'hand' } }))).toBeNull();
    expect(reactionTarget(scene, state({ activeTool: { type: 'rectangle' } }))).toBeNull();
  });
  it.each([
    ['cursorButton', 'down'],
    ['isResizing', true],
    ['isRotating', true],
    ['selectedElementsAreBeingDragged', true],
    ['editingTextElement', {}],
    ['newElement', {}],
    ['multiElement', {}],
    ['resizingElement', {}],
    ['selectionElement', {}],
  ])('is null while a gesture is in progress (%s)', (key, value) => {
    expect(reactionTarget(scene, state({ [key]: value }))).toBeNull();
  });
});

describe('reaction palette', () => {
  it('offers the status marks first, then the original set, without duplicates', () => {
    expect([...REACTION_EMOJIS]).toEqual(['✅', '❌', '🔧', '👍', '❤️', '😂', '🎉', '🤔', '👀', '🔥', '👏']);
    expect(new Set(REACTION_EMOJIS).size).toBe(REACTION_EMOJIS.length);
  });

  it('names every palette emoji with a distinct label key and none for a foreign one', () => {
    const keys = REACTION_EMOJIS.map((e) => reactionLabelKey(e));
    expect(keys.every((k) => typeof k === 'string' && k.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(REACTION_EMOJIS.length);
    expect(Object.keys(REACTION_LABEL_KEYS)).toHaveLength(REACTION_EMOJIS.length);
    expect(reactionLabelKey('✅')).toBe('yes');
    expect(reactionLabelKey('❌')).toBe('no');
    expect(reactionLabelKey('🔧')).toBe('inProgress');
    expect(reactionLabelKey('🦄')).toBeNull();
  });

  it('keeps old reactions readable: the stored key still carries the plain emoji', () => {
    const map = new Y.Doc().getMap('reactions');
    map.set(reactionKey('e1', '👍', 'u1'), { at: 1 });
    map.set(reactionKey('e1', '✅', 'u2'), { at: 2 });
    expect([...(indexReactions(map).get('e1') ?? new Map()).keys()]).toEqual(['👍', '✅']);
  });
});

describe('chip placement under a shape', () => {
  const sticky = { strokeColor: 'transparent', strokeWidth: 1, roughness: 0 };
  /** Screen-space gap between the shape's bottom edge on screen and the chips row, at a given zoom. */
  const gapAt = (el: Parameters<typeof elementVisualOutset>[0], zoom: number, selected = false) => {
    const bottomPx = 400;
    return reactionChipsTop(bottomPx, elementVisualOutset(el), zoom, selected) - bottomPx;
  };

  it('keeps a transparent-stroke sticky exactly the fixed gap away at zoom 0.5, 1 and 2', () => {
    for (const zoom of [0.5, 1, 2]) expect(gapAt(sticky, zoom)).toBe(REACTION_CHIPS_GAP_PX);
    expect(REACTION_CHIPS_GAP_PX).toBeGreaterThanOrEqual(4);
    expect(REACTION_CHIPS_GAP_PX).toBeLessThanOrEqual(6);
  });

  it('adds the half-stroke and the roughness wobble in scene units, so they scale with zoom', () => {
    const drawn = { strokeColor: '#1e1e1e', strokeWidth: 4, roughness: 2 };
    const outset = elementVisualOutset(drawn);
    expect(outset).toBe(3.5);
    expect(gapAt(drawn, 1)).toBe(REACTION_CHIPS_GAP_PX + 3.5);
    expect(gapAt(drawn, 2)).toBe(REACTION_CHIPS_GAP_PX + 7);
    expect(gapAt(drawn, 0.5)).toBe(REACTION_CHIPS_GAP_PX + 1.75);
  });

  it('adds clearance for the selection frame only while the shape is selected', () => {
    expect(gapAt(sticky, 1, true)).toBe(REACTION_CHIPS_GAP_PX + REACTION_CHIPS_SELECTED_CLEARANCE_PX);
  });

  it('measures from the lowest point of a rotated shape', () => {
    const el = { x: 0, y: 0, width: 100, height: 100, angle: Math.PI / 4 };
    const b = elementSceneBounds(el);
    expect(b.bottom).toBeCloseTo(50 + 50 * Math.SQRT2, 6);
    const vp = { scrollX: 0, scrollY: 0, zoom: { value: 2 }, offsetLeft: 0, offsetTop: 0 };
    const bottom = sceneToContainerPoint({ x: b.left, y: b.bottom }, vp, { left: 0, top: 0 }).y;
    expect(reactionChipsTop(bottom, 0, 2, false)).toBeCloseTo(bottom + REACTION_CHIPS_GAP_PX, 6);
  });

  it('falls back to zoom 1 for a degenerate zoom value', () => {
    expect(reactionChipsTop(0, 2, 0, false)).toBe(2 + REACTION_CHIPS_GAP_PX);
  });
});
