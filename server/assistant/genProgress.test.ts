import { describe, expect, it } from 'vitest';
import { createGenerationProgress, realToolName, type GenerationProgress } from './genProgress.js';
import { createRunTiming } from './runTiming.js';
import { reconcileFinalText, withParagraphGap } from './runText.js';

function setup(intervalMs = 500) {
  let clock = 1_000;
  const seen: GenerationProgress[] = [];
  const tracker = createGenerationProgress({ intervalMs, now: () => clock, onProgress: (p) => seen.push(p) });
  return { tracker, seen, advance: (ms: number) => (clock += ms) };
}

describe('createGenerationProgress', () => {
  it('reports thinking at once, then at most once per interval, with a chars/4 estimate', () => {
    const { tracker, seen, advance } = setup();
    tracker.handle({ type: 'thinking-delta', text: 'a'.repeat(40) });
    tracker.handle({ type: 'thinking-delta', text: 'a'.repeat(40) });
    advance(499);
    tracker.handle({ type: 'thinking-delta', text: 'a'.repeat(40) });
    expect(seen).toEqual([{ phase: 'thinking', tool: null, tokens: 10 }]);
    advance(1);
    tracker.handle({ type: 'thinking-delta', text: 'a'.repeat(40) });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ phase: 'thinking', tool: null, tokens: 40 });
  });

  it('names the tool of a partial tool call (custom tools arrive as mcp), prefers token-delta, never leaks the arguments', () => {
    const { tracker, seen } = setup();
    tracker.handle({ type: 'partial-tool-call', toolCall: { type: 'mcp', args: { toolName: 'create_page', args: { markdown: 'SECRET'.repeat(100) } } } });
    expect(seen[0]).toMatchObject({ phase: 'tool', tool: 'create_page' });
    expect(JSON.stringify(seen)).not.toContain('SECRET');
    tracker.handle({ type: 'token-delta', tokens: 7 });
    tracker.handle({ type: 'token-delta', tokens: 5 });
    // a tool/phase change bypasses the throttle
    tracker.handle({ type: 'thinking-delta', text: 'x' });
    expect(seen.at(-1)).toMatchObject({ phase: 'thinking', tokens: 12 });
  });

  it('is silent while reply text streams or a tool runs, and resumes on the next model step', () => {
    const { tracker, seen, advance } = setup(0);
    tracker.handle({ type: 'text-delta', text: 'Hello' });
    tracker.handle({ type: 'token-delta', tokens: 3 });
    tracker.handle({ type: 'tool-call-started' });
    tracker.handle({ type: 'token-delta', tokens: 3 });
    expect(seen).toEqual([]);
    advance(1);
    tracker.handle({ type: 'step-started' });
    tracker.handle({ type: 'token-delta', tokens: 4 });
    expect(seen).toEqual([{ phase: 'thinking', tool: null, tokens: 4 }]);
  });

  it('does not carry tokens counted while reply text streamed into the next thinking phase', () => {
    const { tracker, seen } = setup(0);
    tracker.handle({ type: 'text-delta', text: 'Creating' });
    tracker.handle({ type: 'token-delta', tokens: 1428 });
    tracker.handle({ type: 'thinking-delta', text: 'x' });
    tracker.handle({ type: 'token-delta', tokens: 3 });
    expect(seen.at(-1)).toEqual({ phase: 'thinking', tool: null, tokens: 3 });
  });

  it('does not count the tool result the SDK feeds back as token-deltas (live: 3367 tokens for a skill)', () => {
    const { tracker, seen, advance } = setup(0);
    tracker.handle({ type: 'tool-call-completed' });
    tracker.handle({ type: 'token-delta', tokens: 3367 });
    tracker.handle({ type: 'token-delta', tokens: 1413 });
    expect(seen).toEqual([]);
    advance(1);
    tracker.handle({ type: 'thinking-delta', text: 'x' });
    tracker.handle({ type: 'token-delta', tokens: 5 });
    expect(seen.at(-1)).toEqual({ phase: 'thinking', tool: null, tokens: 5 });
  });
});

describe('withParagraphGap / reconcileFinalText', () => {
  it('separates narration chunks that were split by a tool call, only when needed', () => {
    expect(withParagraphGap('format.', 'Looking', true)).toBe('\n\nLooking');
    expect(withParagraphGap('format.\n', 'Looking', true)).toBe('Looking');
    expect(withParagraphGap('format.', 'Looking', false)).toBe('Looking');
    expect(withParagraphGap('', 'Looking', true)).toBe('Looking');
  });

  it('saves the separated stream text when the SDK result is the same words, else the result', () => {
    expect(reconcileFinalText('a b.\n\nc d', 'a b.c d')).toBe('a b.\n\nc d');
    expect(reconcileFinalText('first\n\nsecond', 'second')).toBe('second');
    expect(reconcileFinalText('', 'only')).toBe('only');
  });
});

describe('createRunTiming', () => {
  it('records milestones, firsts, turns, tool calls and token totals', () => {
    let clock = 0;
    const timing = createRunTiming(() => clock);
    clock = 100;
    timing.milestone('agent-ready');
    clock = 300;
    expect(timing.onUpdate({ type: 'thinking-delta', text: '' }).firstDelta).toBe(300);
    clock = 900;
    expect(timing.onUpdate({ type: 'text-delta', text: 'x' }).firstText).toBe(900);
    expect(timing.onUpdate({ type: 'text-delta', text: 'y' }).firstText).toBeNull();
    timing.onUpdate({ type: 'step-started', stepId: 1 });
    timing.onUpdate({ type: 'turn-ended', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } });
    timing.toolFinished({ tool: 'read_page', ms: 40, ok: true });
    clock = 1_000;
    expect(timing.snapshot()).toMatchObject({
      agentReadyMs: 100,
      firstDeltaMs: 300,
      firstTextMs: 900,
      turns: 1,
      toolCalls: 1,
      toolMs: 40,
      inputTokens: 10,
      outputTokens: 5,
      totalMs: 1_000,
    });
  });

  it('counts model round trips, not turn-ended: 3 tool calls (one parallel pair) plus the final reply is 3 turns', () => {
    const timing = createRunTiming(() => 0);
    const feed = (type: string): void => void timing.onUpdate({ type });
    feed('thinking-delta');
    feed('tool-call-started');
    feed('tool-call-completed');
    feed('token-delta'); // tool result going back as input: not a new round by itself
    feed('tool-call-started');
    feed('tool-call-started'); // parallel pair
    feed('tool-call-completed');
    feed('tool-call-completed');
    feed('text-delta');
    feed('text-delta');
    feed('turn-ended');
    expect(timing.snapshot().turns).toBe(3);
  });
});

describe('realToolName', () => {
  it('unwraps a custom (mcp) tool and leaves other names alone', () => {
    expect(realToolName('mcp', { toolName: 'create_page', args: {} })).toBe('create_page');
    expect(realToolName('mcp', undefined)).toBe('mcp');
    expect(realToolName('shell', { toolName: 'x' })).toBe('shell');
  });
});
