import { describe, expect, it } from 'vitest';
import { hubCount, labelStrength, planLabels, SMALL_GRAPH, type LabelCandidate, type LabelPlanInput } from './graphLabels';

/** `n` nodes on a wide grid (never touching), degree falling with the index: n0 is the biggest hub. */
function grid(n: number, extra: Partial<LabelCandidate> = {}): LabelCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    sx: 100 + (i % 20) * 120,
    sy: 60 + Math.floor(i / 20) * 60,
    radiusPx: 4,
    degree: n - i,
    text: `Node ${i}`,
    isCenter: false,
    ...extra,
  }));
}

const base = (over: Partial<LabelPlanInput>): LabelPlanInput => ({
  candidates: [],
  total: 0,
  k: 1,
  labelZoom: 1.1,
  hot: null,
  measure: (t) => t.length * 6,
  fontPx: 12,
  maxLabels: 600,
  ...over,
});
const ids = (labels: Array<{ id: string }>) => labels.map((l) => l.id);

describe('planLabels: zoom reveals labels', () => {
  it('a big graph at a low zoom shows only the top hubs, by degree', () => {
    const candidates = grid(109);
    const labels = planLabels(base({ candidates, total: 109, k: 0.4 }));
    expect(labels.length).toBeGreaterThanOrEqual(hubCount(109));
    expect(labels.length).toBeLessThanOrEqual(25);
    // the biggest hubs are in, in degree order
    expect(ids(labels).slice(0, 5)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
    expect(ids(labels)).not.toContain('n100');
    // each of the top hubs at full strength
    expect(labels.slice(0, hubCount(109)).every((l) => l.alpha === 1)).toBe(true);
  });

  it('zooming in reveals more; at the threshold everything that fits is drawn', () => {
    const candidates = grid(109);
    const at = (k: number) => planLabels(base({ candidates, total: 109, k })).length;
    expect(at(0.3)).toBeLessThan(at(0.7));
    expect(at(0.7)).toBeLessThan(at(1.2));
    expect(at(1.2)).toBe(109);
  });

  it('the threshold setting stays meaningful: a higher one hides more at the same zoom', () => {
    const candidates = grid(109);
    const count = (labelZoom: number) => planLabels(base({ candidates, total: 109, k: 0.8, labelZoom })).length;
    expect(count(3)).toBeLessThan(count(1.1));
    expect(count(0.5)).toBe(109); // zoomed past the threshold
  });

  it('the fitted overview of a big graph is hubs only, whatever the window size; the reveal zoom is the larger of the threshold and twice the fit', () => {
    const candidates = grid(109);
    for (const fitK of [1.0, 0.25]) {
      const overview = planLabels(base({ candidates, total: 109, k: fitK, fitK }));
      expect(overview.length).toBeLessThanOrEqual(hubCount(109) + 8);
    }
    // fit 1.0: everything from 2.0 (twice the fit); fit 0.25: everything from the threshold, 1.1
    expect(planLabels(base({ candidates, total: 109, k: 2, fitK: 1 }))).toHaveLength(109);
    expect(planLabels(base({ candidates, total: 109, k: 1.1, fitK: 0.25 }))).toHaveLength(109);
    expect(planLabels(base({ candidates, total: 109, k: 1.1, fitK: 1 })).length).toBeLessThan(60);
  });

  it('a phone shows fewer hubs than a desktop window', () => {
    const candidates = grid(109);
    const desktop = planLabels(base({ candidates, total: 109, k: 1, fitK: 1, area: 1_000_000 })).length;
    const phone = planLabels(base({ candidates, total: 109, k: 1, fitK: 1, area: 375 * 560 })).length;
    expect(phone).toBeLessThan(desktop);
    expect(phone).toBeLessThanOrEqual(hubCount(109) / 2 + 4);
    expect(hubCount(109, 375 * 560)).toBeGreaterThanOrEqual(3);
  });

  it('a small graph keeps the plain fade: nothing below the threshold, all of it above, a blend between', () => {
    expect(SMALL_GRAPH).toBeGreaterThanOrEqual(30);
    const candidates = grid(30);
    expect(planLabels(base({ candidates, total: 30, k: 0.5 }))).toHaveLength(0);
    const mid = planLabels(base({ candidates, total: 30, k: 1.0 }));
    expect(mid).toHaveLength(30);
    expect(mid[0].alpha).toBeGreaterThan(0.3);
    expect(mid[0].alpha).toBeLessThan(1);
    expect(planLabels(base({ candidates, total: 30, k: 1.5 })).every((l) => l.alpha === 1)).toBe(true);
  });

  it('labelStrength falls with the rank and never exceeds the fade', () => {
    expect(labelStrength(0, 100, 100, 0.2, 1.1)).toBe(1);
    expect(labelStrength(50, 100, 100, 0.2, 1.1)).toBe(0);
    expect(labelStrength(50, 100, 100, 1.2, 1.1)).toBe(1);
  });
});

describe('planLabels: focus', () => {
  it('the hovered node and its neighbours are always labelled, even at a low zoom and far from the hubs', () => {
    const candidates = grid(109);
    const hot = new Set(['n100', 'n101', 'n105']);
    const labels = planLabels(base({ candidates, total: 109, k: 0.3, hot, focusId: 'n100' }));
    for (const id of hot) expect(labels.find((l) => l.id === id)).toMatchObject({ alpha: 1, important: true });
    // important ones come first; the others step back
    expect(ids(labels).slice(0, 3).sort()).toEqual(['n100', 'n101', 'n105']);
    const rest = labels.filter((l) => !l.important);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((l) => l.alpha <= 0.25)).toBe(true);
  });

  it('the centre of a local graph is always labelled', () => {
    const candidates = grid(5);
    candidates[4].isCenter = true;
    const labels = planLabels(base({ candidates, total: 5, k: 0.2 }));
    expect(ids(labels)).toEqual(['n4']);
  });
});

describe('planLabels: collisions', () => {
  it('skips a label whose box overlaps one already placed, in degree order', () => {
    // three nodes on top of each other: only the biggest hub keeps its label
    const stacked: LabelCandidate[] = [
      { id: 'big', sx: 200, sy: 100, radiusPx: 6, degree: 9, text: 'Biggest hub', isCenter: false },
      { id: 'mid', sx: 210, sy: 100, radiusPx: 4, degree: 5, text: 'Middle', isCenter: false },
      { id: 'far', sx: 600, sy: 100, radiusPx: 4, degree: 1, text: 'Far away', isCenter: false },
    ];
    const labels = planLabels(base({ candidates: stacked, total: 3, k: 2 }));
    expect(ids(labels)).toEqual(['big', 'far']);
  });

  it('labels that only touch their padding are still apart, and nodes stacked vertically do not collide with a far label', () => {
    const a: LabelCandidate = { id: 'a', sx: 100, sy: 100, radiusPx: 4, degree: 2, text: 'aaaa', isCenter: false };
    const b: LabelCandidate = { id: 'b', sx: 100, sy: 140, radiusPx: 4, degree: 1, text: 'bbbb', isCenter: false };
    expect(ids(planLabels(base({ candidates: [a, b], total: 2, k: 2 })))).toEqual(['a', 'b']);
  });

  it('the focus is never skipped for overlapping and keeps others off its box; its neighbours come next and may not overlap each other', () => {
    const focus: LabelCandidate = { id: 'f', sx: 200, sy: 100, radiusPx: 5, degree: 1, text: 'Focused page', isCenter: false };
    const hub: LabelCandidate = { id: 'h', sx: 205, sy: 100, radiusPx: 8, degree: 50, text: 'Hub', isCenter: false };
    const nearby: LabelCandidate = { id: 'n1', sx: 207, sy: 102, radiusPx: 3, degree: 2, text: 'Neighbour one', isCenter: false };
    const apart: LabelCandidate = { id: 'n2', sx: 500, sy: 100, radiusPx: 3, degree: 2, text: 'Neighbour two', isCenter: false };
    const labels = planLabels(base({ candidates: [hub, nearby, apart, focus], total: 4, k: 2, focusId: 'f', hot: new Set(['f', 'n1', 'n2']) }));
    expect(ids(labels)).toEqual(['f', 'n2']); // n1 sits under the focus label, the (not neighbouring) hub too
  });

  it('the cap on non-important labels holds', () => {
    const labels = planLabels(base({ candidates: grid(60), total: 60, k: 2, maxLabels: 8 }));
    expect(labels).toHaveLength(8);
  });
});
