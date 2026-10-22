// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeltaBatcher, createRunEventHandler, runStepText } from './runStream';

describe('createRunEventHandler', () => {
  it('turns status events into steps and deltas into text, and leaves terminal events to the caller', () => {
    const onStep = vi.fn();
    const onDelta = vi.fn();
    const handle = createRunEventHandler({ onStep, onDelta });

    handle({ seq: 1, type: 'status', status: 'tool', label: 'search_pages' });
    handle({ seq: 2, type: 'delta', text: 'Hello' });
    handle({ seq: 3, type: 'stopped', conversationId: 'c1' });

    expect(onStep).toHaveBeenCalledOnce();
    expect(onStep).toHaveBeenCalledWith({ status: 'tool', label: 'search_pages' });
    expect(onDelta).toHaveBeenCalledOnce();
    expect(onDelta).toHaveBeenCalledWith('Hello');
  });
});

describe('createDeltaBatcher', () => {
  let frames: FrameRequestCallback[];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames[id - 1] = () => undefined;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('flushes everything pushed within one frame as a single chunk', () => {
    const flush = vi.fn();
    const batcher = createDeltaBatcher(flush);
    batcher.push('a');
    batcher.push('b');
    expect(flush).not.toHaveBeenCalled();
    frames.forEach((cb) => cb(0));
    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith('ab');
  });

  it('drops queued text on cancel, so a stale frame cannot append to the next run', () => {
    const flush = vi.fn();
    const batcher = createDeltaBatcher(flush);
    batcher.push('stale');
    batcher.cancel();
    frames.forEach((cb) => cb(0));
    expect(flush).not.toHaveBeenCalled();
    batcher.push('fresh');
    frames.forEach((cb) => cb(0));
    expect(flush).toHaveBeenCalledWith('fresh');
  });
});

describe('runStepText', () => {
  const t = (key: string, values?: Record<string, unknown>) => (values?.tool ? `${key}:${values.tool}` : key);

  it('names the tool for a tool step, the label for other labelled steps, the status otherwise', () => {
    expect(runStepText(t, null)).toBe('assistant.chat.status.starting');
    expect(runStepText(t, { status: 'tool', label: 'search_pages' })).toBe('assistant.chat.status.tool:search_pages');
    expect(runStepText(t, { status: 'thinking', label: 'Reading pages' })).toBe('Reading pages');
    expect(runStepText(t, { status: 'writing' })).toBe('assistant.chat.status.writing');
  });

  it('shows a live counter while the model thinks or writes a tool call', () => {
    expect(runStepText(t, { status: 'thinking', tokens: 120 })).toBe('assistant.chat.status.thinkingNow assistant.chat.status.tokens');
    expect(runStepText(t, { status: 'tool', label: 'create_page', generating: true, tokens: 900 })).toBe('assistant.chat.status.draftingPage assistant.chat.status.tokens');
    expect(runStepText(t, { status: 'tool', label: 'save_base', generating: true, tokens: 5 })).toBe('assistant.chat.status.preparingTool:save_base assistant.chat.status.tokens');
    expect(runStepText(t, { status: 'tool', generating: true })).toBe('assistant.chat.status.preparingAction');
  });

  it('appends the silence since the last event, and names the silent model-writing phase', () => {
    const tt = (key: string, values?: Record<string, unknown>) =>
      key.endsWith('elapsedMinutes') ? `${values?.minutes}m ${values?.seconds}s` : key.endsWith('elapsedSeconds') ? `${values?.seconds}s` : values?.tool ? `${key}:${values.tool}` : key;
    expect(runStepText(tt, { status: 'thinking' }, null)).toBe('assistant.chat.status.thinking');
    expect(runStepText(tt, { status: 'thinking' }, 45)).toBe('assistant.chat.status.modelPreparing · 45s');
    expect(runStepText(tt, { status: 'writing' }, 72)).toBe('assistant.chat.status.modelPreparing · 1m 12s');
    expect(runStepText(tt, { status: 'tool', label: 'create_page' }, 5)).toBe('assistant.chat.status.tool:create_page · 5s');
    expect(runStepText(tt, { status: 'thinking', label: 'Reading pages' }, 9)).toBe('Reading pages · 9s');
    expect(runStepText(tt, null, 4)).toBe('assistant.chat.status.starting · 4s');
  });
});
