// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetChimeForTests, armAudioUnlock, audioReady, isMuted, playChime, setMuted, unlockAudio } from './chime';

/** An AudioContext double: starts suspended like a page without a gesture, becomes running on resume(). */
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static resumable = true;
  state: 'suspended' | 'running' = 'suspended';
  currentTime = 0;
  destination = {};
  oscillators = 0;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  addEventListener() {}
  resume() {
    if (FakeAudioContext.resumable) this.state = 'running';
    return Promise.resolve();
  }
  createOscillator() {
    this.oscillators += 1;
    const node = { frequency: { value: 0 }, type: '', connect: (n: unknown) => n, start: vi.fn(), stop: vi.fn() };
    return node;
  }
  createGain() {
    return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: (n: unknown) => n };
  }
}

beforeEach(() => {
  __resetChimeForTests();
  FakeAudioContext.instances = [];
  FakeAudioContext.resumable = true;
  vi.stubGlobal('AudioContext', FakeAudioContext);
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('the end-of-timer chime', () => {
  it('stays silent and says so while the browser has not allowed audio yet', () => {
    FakeAudioContext.resumable = false;
    expect(playChime()).toBe(false);
    expect(FakeAudioContext.instances[0].oscillators).toBe(0);
    expect(audioReady()).toBe(false);
  });

  it('rings four notes once audio is unlocked by a gesture', async () => {
    expect(await unlockAudio()).toBe(true);
    expect(audioReady()).toBe(true);
    expect(playChime()).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0].oscillators).toBe(4);
  });

  it('the first click anywhere unlocks the audio, and the listeners then go away', async () => {
    armAudioUnlock();
    expect(audioReady()).toBe(false);
    document.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(audioReady()).toBe(true));
    const count = FakeAudioContext.instances.length;
    document.dispatchEvent(new Event('pointerdown'));
    expect(FakeAudioContext.instances).toHaveLength(count);
  });

  it('the mute switch is respected and persists', async () => {
    await unlockAudio();
    setMuted(true);
    expect(isMuted()).toBe(true);
    expect(playChime()).toBe(true); // silence was asked for: not a failure
    expect(FakeAudioContext.instances[0].oscillators).toBe(0);
    expect(playChime({ force: true })).toBe(true); // the «test» press
    expect(FakeAudioContext.instances[0].oscillators).toBe(4);
    setMuted(false);
    expect(isMuted()).toBe(false);
  });

  it('a browser without Web Audio does not throw', () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    vi.unstubAllGlobals();
    expect(playChime()).toBe(false);
  });
});
