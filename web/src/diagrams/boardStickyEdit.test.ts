// @vitest-environment jsdom
/**
 * boardStickyEdit.ts: opening a freshly inserted sticky for text entry via
 * Enter on the sole selected container. The Excalidraw side of this (the real
 * `startTextEditing`) is covered by a live harness run, not here — these tests
 * pin the waiting/dispatching contract around it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSoleSelection, openStickyTextEditor, soleSelection } from './boardStickyEdit';

function makeHost(): { host: HTMLElement; canvas: HTMLCanvasElement } {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.className = 'excalidraw__canvas interactive';
  host.appendChild(canvas);
  document.body.appendChild(host);
  return { host, canvas };
}

function apiWith(selected: () => Record<string, boolean>) {
  return { getAppState: () => ({ selectedElementIds: selected() }) };
}

describe('soleSelection', () => {
  it('selects exactly the given element and clears any group scope', () => {
    expect(soleSelection('a')).toEqual({ selectedElementIds: { a: true }, selectedGroupIds: {}, editingGroupId: null });
  });
});

describe('isSoleSelection', () => {
  it('is true only when the given element is the single selected one', () => {
    expect(isSoleSelection(apiWith(() => ({ a: true })), 'a')).toBe(true);
    expect(isSoleSelection(apiWith(() => ({ a: true, b: true })), 'a')).toBe(false);
    expect(isSoleSelection(apiWith(() => ({ b: true })), 'a')).toBe(false);
    expect(isSoleSelection(apiWith(() => ({ a: false })), 'a')).toBe(false);
    expect(isSoleSelection(apiWith(() => ({})), 'a')).toBe(false);
  });
});

describe('openStickyTextEditor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('presses Enter on the interactive canvas once the new note is the sole committed selection', () => {
    const { host, canvas } = makeHost();
    const keys: KeyboardEvent[] = [];
    host.addEventListener('keydown', (e) => keys.push(e as KeyboardEvent));
    openStickyTextEditor(apiWith(() => ({ s: true })), host, 's');
    expect(keys).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBe('Enter');
    expect(keys[0].target).toBe(canvas);
    expect(keys[0].bubbles).toBe(true);
  });

  it('waits while an older note is still the committed selection, then fires once it flips', () => {
    const { host } = makeHost();
    const keys: KeyboardEvent[] = [];
    host.addEventListener('keydown', (e) => keys.push(e as KeyboardEvent));
    let selected: Record<string, boolean> = { old: true };
    openStickyTextEditor(apiWith(() => selected), host, 'new');
    vi.advanceTimersByTime(100);
    expect(keys).toHaveLength(0);
    selected = { new: true };
    vi.advanceTimersByTime(50);
    expect(keys).toHaveLength(1);
  });

  it('gives up after a bounded wait when the selection never settles', () => {
    const { host } = makeHost();
    const keys: KeyboardEvent[] = [];
    host.addEventListener('keydown', (e) => keys.push(e as KeyboardEvent));
    openStickyTextEditor(apiWith(() => ({ old: true })), host, 'new');
    vi.advanceTimersByTime(10_000);
    expect(keys).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('blurs a text editor that is still open so it submits before the new note opens', () => {
    const { host } = makeHost();
    const textarea = document.createElement('textarea');
    textarea.className = 'excalidraw-wysiwyg';
    host.appendChild(textarea);
    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    openStickyTextEditor(apiWith(() => ({ s: true })), host, 's');
    expect(document.activeElement).not.toBe(textarea);
  });

  it('can be cancelled, and does nothing when the host was unmounted meanwhile', () => {
    const a = makeHost();
    const keysA: KeyboardEvent[] = [];
    a.host.addEventListener('keydown', (e) => keysA.push(e as KeyboardEvent));
    const cancel = openStickyTextEditor(apiWith(() => ({ s: true })), a.host, 's');
    cancel();
    vi.advanceTimersByTime(100);
    expect(keysA).toHaveLength(0);

    const b = makeHost();
    const keysB: KeyboardEvent[] = [];
    b.host.addEventListener('keydown', (e) => keysB.push(e as KeyboardEvent));
    openStickyTextEditor(apiWith(() => ({ s: true })), b.host, 's');
    b.host.remove();
    vi.advanceTimersByTime(100);
    expect(keysB).toHaveLength(0);
  });
});
