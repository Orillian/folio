/**
 * Pure coverage for boardHeading.ts ("Make heading"). The Excalidraw package is mocked with the
 * smallest stand-ins; real measurement, grouping and undo are checked live in a browser harness.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@excalidraw/excalidraw', () => ({
  CaptureUpdateAction: { IMMEDIATELY: 'IMMEDIATELY', NEVER: 'NEVER', EVENTUALLY: 'EVENTUALLY' },
  convertToExcalidrawElements: vi.fn((skeletons: Array<Record<string, unknown>>) =>
    skeletons.map((s, i) => ({
      id: `new-${i}`,
      version: 1,
      seed: 7,
      index: null,
      isDeleted: false,
      width: String(s.text ?? '').split('\n').reduce((m, l) => Math.max(m, l.length), 0) * ((s.fontSize as number) ?? 20) * 0.5,
      height: String(s.text ?? '').split('\n').length * ((s.fontSize as number) ?? 20) * 1.25,
      ...s,
    })),
  ),
  newElementWith: vi.fn((el: Record<string, unknown>, upd: Record<string, unknown>) => ({
    ...el,
    ...upd,
    version: (el.version as number) + 1,
  })),
}));

import {
  applyMakeHeading,
  headingFontSize,
  headingTarget,
  planHeadingSplit,
  splitHeadingText,
  wrapToWidth,
  type HeadingSource,
  type MeasureText,
} from './boardHeading';

/** 10px per character at size 20; 1.25 line height. */
const measure: MeasureText = (text, fontSize) => {
  const lines = text.split('\n');
  return { width: Math.max(...lines.map((l) => l.length)) * fontSize * 0.5, height: lines.length * fontSize * 1.25 };
};

function source(over: Partial<HeadingSource> = {}): HeadingSource {
  const originalText = over.originalText ?? 'Title line\nBody line one\nBody line two';
  return {
    x: 100,
    y: 200,
    width: 230,
    height: 75,
    angle: 0,
    text: originalText,
    originalText,
    fontSize: 20,
    textAlign: 'left',
    autoResize: true,
    ...over,
  };
}

describe('splitHeadingText', () => {
  it('returns null for a single line', () => {
    expect(splitHeadingText('Only one line')).toBeNull();
    expect(splitHeadingText('')).toBeNull();
    expect(splitHeadingText('\n\n')).toBeNull();
  });

  it('returns null when only blank lines follow the first line', () => {
    expect(splitHeadingText('Title\n\n  \n')).toBeNull();
  });

  it('splits the first line from the rest', () => {
    const split = splitHeadingText('Title\nBody one\nBody two');
    expect(split?.heading).toBe('Title');
    expect(split?.bodyLines).toEqual(['Body one', 'Body two']);
  });

  it('skips blank lines before the heading and between heading and body, and trims the tail', () => {
    const split = splitHeadingText('\n\nTitle\n\nBody\n\nMore\n\n');
    expect(split?.heading).toBe('Title');
    expect(split?.bodyLines).toEqual(['Body', '', 'More']);
    expect(split?.bodyStartIndex).toBe(4);
  });
});

describe('headingFontSize', () => {
  it('moves each standard size to the nearest bigger standard size to x1.4', () => {
    expect(headingFontSize(16)).toBe(20);
    expect(headingFontSize(20)).toBe(28);
    expect(headingFontSize(28)).toBe(36);
  });

  it('falls back to plain x1.4 for the biggest standard size and for custom sizes', () => {
    expect(headingFontSize(36)).toBe(50);
    expect(headingFontSize(24)).toBe(34);
    expect(headingFontSize(10)).toBe(14);
  });
});

describe('wrapToWidth', () => {
  const w = (s: string) => s.length * 10;
  it('keeps a line that fits', () => {
    expect(wrapToWidth('hello world', 200, w)).toBe('hello world');
  });
  it('wraps at spaces', () => {
    expect(wrapToWidth('aaa bbb ccc', 70, w)).toBe('aaa bbb\nccc');
  });
  it('breaks a word wider than the width by characters', () => {
    expect(wrapToWidth('abcdefgh', 30, w)).toBe('abc\ndef\ngh');
  });
  it('keeps explicit newlines', () => {
    expect(wrapToWidth('a\n\nb', 100, w)).toBe('a\n\nb');
  });
});

describe('planHeadingSplit', () => {
  it('returns null for a single line', () => {
    expect(planHeadingSplit(source({ originalText: 'one line', text: 'one line' }), measure)).toBeNull();
  });

  it('puts the heading at the source top-left and the body under it with a gap', () => {
    const plan = planHeadingSplit(source(), measure)!;
    expect(plan.heading).toMatchObject({ text: 'Title line', originalText: 'Title line', x: 100, y: 200, fontSize: 28 });
    // 10 chars at size 28 = 140 wide, one line = 35 high.
    expect(plan.heading.width).toBe(140);
    expect(plan.heading.height).toBe(35);
    expect(plan.body).toMatchObject({ text: 'Body line one\nBody line two', originalText: 'Body line one\nBody line two', x: 100, fontSize: 20 });
    // heading height 35 + gap round(20 * 0.4) = 8
    expect(plan.body.y).toBe(200 + 35 + 8);
    expect(plan.body.height).toBe(2 * 20 * 1.25);
  });

  it('centres each part about the source centre for textAlign center', () => {
    const plan = planHeadingSplit(source({ textAlign: 'center' }), measure)!;
    const sourceCentre = 100 + 230 / 2;
    expect(plan.heading.x + plan.heading.width / 2).toBeCloseTo(sourceCentre);
    expect(plan.body.x + plan.body.width / 2).toBeCloseTo(sourceCentre);
  });

  it('keeps the right edge for textAlign right', () => {
    const plan = planHeadingSplit(source({ textAlign: 'right' }), measure)!;
    expect(plan.heading.x + plan.heading.width).toBeCloseTo(330);
    expect(plan.body.x + plan.body.width).toBeCloseTo(330);
  });

  it('keeps the source width for a fixed-width block and wraps the heading to it', () => {
    const originalText = 'A very long heading that needs wrapping\nBody';
    const plan = planHeadingSplit(source({ originalText, text: originalText, width: 200, autoResize: false }), measure)!;
    expect(plan.heading.width).toBe(200);
    expect(plan.body.width).toBe(200);
    expect(plan.heading.text.split('\n').length).toBeGreaterThan(1);
    for (const line of plan.heading.text.split('\n')) expect(measure(line, 28).width).toBeLessThanOrEqual(200);
    expect(plan.heading.originalText).toBe('A very long heading that needs wrapping');
  });

  it('reuses the already wrapped body lines of a fixed-width block', () => {
    const plan = planHeadingSplit(
      source({
        originalText: 'Head\nalpha beta gamma delta',
        text: 'Head\nalpha beta\ngamma delta',
        width: 100,
        autoResize: false,
      }),
      measure,
    )!;
    expect(plan.body.text).toBe('alpha beta\ngamma delta');
    expect(plan.body.originalText).toBe('alpha beta gamma delta');
  });

  it('maps wrapped lines correctly when the heading itself wrapped and blank lines surround it', () => {
    const plan = planHeadingSplit(
      source({
        originalText: '\nlong head line\n\nbody text here',
        text: '\nlong head\nline\n\nbody text\nhere',
        width: 100,
        autoResize: false,
      }),
      measure,
    )!;
    expect(plan.body.text).toBe('body text\nhere');
  });

  it('falls back to its own wrapping when the wrapped text does not line up', () => {
    const plan = planHeadingSplit(
      source({ originalText: 'Head\nalpha beta', text: 'something else entirely', width: 60, autoResize: false }),
      measure,
    )!;
    for (const line of plan.body.text.split('\n')) expect(measure(line, 20).width).toBeLessThanOrEqual(60);
    expect(plan.body.text.replace(/\n/g, ' ')).toBe('alpha beta');
  });

  it('rotates both parts rigidly about the source centre', () => {
    const angle = Math.PI / 2;
    const s = source({ angle });
    const upright = planHeadingSplit(source(), measure)!;
    const plan = planHeadingSplit(s, measure)!;
    expect(plan.heading.angle).toBe(angle);
    expect(plan.body.angle).toBe(angle);
    // Distance between the two part centres is unchanged by rotation.
    const dist = (p: typeof plan) =>
      Math.hypot(
        p.heading.x + p.heading.width / 2 - (p.body.x + p.body.width / 2),
        p.heading.y + p.heading.height / 2 - (p.body.y + p.body.height / 2),
      );
    expect(dist(plan)).toBeCloseTo(dist(upright));
    // A quarter turn clockwise rotates the heading-to-body vector (vx, vy) to (-vy, vx).
    const vec = (p: typeof plan) => ({
      x: p.body.x + p.body.width / 2 - (p.heading.x + p.heading.width / 2),
      y: p.body.y + p.body.height / 2 - (p.heading.y + p.heading.height / 2),
    });
    const before = vec(upright);
    const after = vec(plan);
    expect(after.x).toBeCloseTo(-before.y);
    expect(after.y).toBeCloseTo(before.x);
  });

  it('is the identity layout at angle 0 (no rotation drift)', () => {
    const plan = planHeadingSplit(source({ angle: 0 }), measure)!;
    expect(plan.heading.x).toBe(100);
    expect(plan.heading.y).toBe(200);
  });
});

const idleState = { selectedElementIds: {} as Record<string, boolean>, activeTool: { type: 'selection' } };

function textEl(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    type: 'text',
    isDeleted: false,
    containerId: null,
    originalText: 'Title\nBody',
    text: 'Title\nBody',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    fontSize: 20,
    fontFamily: 5,
    lineHeight: 1.25,
    textAlign: 'left',
    verticalAlign: 'top',
    autoResize: true,
    groupIds: [],
    version: 3,
    strokeColor: '#e03131',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 60,
    roundness: null,
    frameId: null,
    ...over,
  } as never;
}

describe('headingTarget', () => {
  it('returns the single selected free multi-line text', () => {
    const el = textEl();
    expect(headingTarget([el], { ...idleState, selectedElementIds: { t1: true } })).toBe(el);
  });
  it('is null for single-line text, bound text, other types, several selected, or an unselected scene', () => {
    const sel = { ...idleState, selectedElementIds: { t1: true } };
    expect(headingTarget([textEl({ originalText: 'one' })], sel)).toBeNull();
    expect(headingTarget([textEl({ containerId: 'box' })], sel)).toBeNull();
    expect(headingTarget([textEl({ type: 'rectangle' })], sel)).toBeNull();
    expect(headingTarget([textEl(), textEl({ id: 't2' })], { ...idleState, selectedElementIds: { t1: true, t2: true } })).toBeNull();
    expect(headingTarget([textEl()], idleState)).toBeNull();
  });
  it('is null in view mode and while editing text', () => {
    const base = { ...idleState, selectedElementIds: { t1: true } };
    expect(headingTarget([textEl()], { ...base, viewModeEnabled: true })).toBeNull();
    expect(headingTarget([textEl()], { ...base, editingTextElement: {} })).toBeNull();
  });
});

describe('applyMakeHeading', () => {
  function fakeApi(elements: unknown[]) {
    return { getSceneElementsIncludingDeleted: vi.fn(() => elements), updateScene: vi.fn() };
  }

  it('writes heading + body in one updateScene as one undo step, grouped, body keeping the id', () => {
    const other = { id: 'other', type: 'rectangle', isDeleted: false, groupIds: [] };
    const api = fakeApi([other, textEl({ groupIds: ['outer'] })]);
    const result = applyMakeHeading(api as never, 't1')!;
    expect(api.updateScene).toHaveBeenCalledTimes(1);
    const call = api.updateScene.mock.calls[0][0];
    expect(call.captureUpdate).toBe('IMMEDIATELY');
    const [first, heading, body] = call.elements;
    expect(first).toBe(other);
    expect(body.id).toBe('t1');
    expect(heading.id).toBe(result.headingId);
    expect(heading.id).not.toBe('t1');
    expect(heading.groupIds).toEqual([result.groupId, 'outer']);
    expect(body.groupIds).toEqual([result.groupId, 'outer']);
    expect(heading).toMatchObject({ strokeColor: '#e03131', opacity: 60, fontFamily: 5, textAlign: 'left', fontSize: 28, text: 'Title' });
    expect(heading.containerId).toBeNull();
    expect(body).toMatchObject({ text: 'Body', originalText: 'Body', fontSize: 20, version: 4 });
    expect(call.appState.selectedElementIds).toEqual({ [heading.id]: true, t1: true });
    expect(call.appState.selectedGroupIds).toEqual({ [result.groupId]: true });
  });

  it('does nothing for single-line, bound or missing text', () => {
    for (const el of [textEl({ originalText: 'one', text: 'one' }), textEl({ containerId: 'b' })]) {
      const api = fakeApi([el]);
      expect(applyMakeHeading(api as never, 't1')).toBeNull();
      expect(api.updateScene).not.toHaveBeenCalled();
    }
    const api = fakeApi([]);
    expect(applyMakeHeading(api as never, 'nope')).toBeNull();
  });
});
