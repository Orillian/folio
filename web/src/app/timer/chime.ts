import { useSyncExternalStore } from 'react';

/**
 * The sound at the end of the shared page timer, made with the Web Audio API:
 * no binary asset, nothing to download. A short, soft bell — four sine notes of
 * a major arpeggio, each with a quick attack and a long exponential decay.
 *
 * THE BROWSER'S RULE. An AudioContext starts `suspended` until the page has had
 * a user gesture; a timer that rings in a tab nobody has clicked in would be
 * silent. So: (1) the first click / key press / touch anywhere in the app
 * unlocks (creates + resumes) the context — `armAudioUnlock()`, called once
 * when the timer is on screen; (2) pressing any timer button unlocks it too;
 * (3) if at the moment of ringing the context is still suspended, `playChime`
 * reports `false` and the caller says so («click anywhere to enable the
 * sound») instead of failing silently; `useAudioLocked()` drives the muted icon.
 *
 * The person's own «mute» switch lives in localStorage, per device.
 */

const MUTE_KEY = 'folio:timer-muted';

let context: AudioContext | null = null;
const listeners = new Set<() => void>();
let unlockArmed = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function audioContextClass(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function ensureContext(): AudioContext | null {
  if (context) return context;
  const Ctor = audioContextClass();
  if (!Ctor) return null;
  try {
    context = new Ctor();
    context.addEventListener?.('statechange', emit);
  } catch {
    context = null;
  }
  return context;
}

/** Whether the context is running: a chime played now would be heard. */
export function audioReady(): boolean {
  return context?.state === 'running';
}

/** Creates/resumes the context. Call it from a user gesture. Resolves to whether sound can play now. */
export async function unlockAudio(): Promise<boolean> {
  const ctx = ensureContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      // Still blocked: the caller reads audioReady().
    }
  }
  emit();
  return ctx.state === 'running';
}

/** Unlocks the audio on the first gesture anywhere in the page. Safe to call many times; returns nothing to clean up (it removes itself). */
export function armAudioUnlock(): void {
  // Create the context now (allowed without a gesture, it just starts suspended), so the «sound is blocked» icon
  // tells the truth about this browser instead of guessing before the first chime.
  ensureContext();
  if (unlockArmed || typeof document === 'undefined') return;
  unlockArmed = true;
  const events = ['pointerdown', 'keydown', 'touchstart'] as const;
  const onGesture = (): void => {
    void unlockAudio().then((ready) => {
      if (!ready) return;
      for (const name of events) document.removeEventListener(name, onGesture, true);
      unlockArmed = false;
    });
  };
  for (const name of events) document.addEventListener(name, onGesture, true);
}

/** True while a chime could NOT be heard because the browser still blocks audio (drives the muted icon). */
export function useAudioLocked(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => !audioReady(),
    () => false,
  );
}

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    if (muted) localStorage.setItem(MUTE_KEY, '1');
    else localStorage.removeItem(MUTE_KEY);
  } catch {
    // Private mode: the switch just does not persist.
  }
  emit();
}

/** C5 E5 G5 C6, a little apart; the last one rings longest. */
const NOTES: ReadonlyArray<{ freq: number; at: number; len: number }> = [
  { freq: 523.25, at: 0, len: 0.9 },
  { freq: 659.25, at: 0.16, len: 0.9 },
  { freq: 783.99, at: 0.32, len: 0.9 },
  { freq: 1046.5, at: 0.48, len: 1.5 },
];

/**
 * Rings the bell. Returns false when nothing could be heard: the context is
 * missing or still suspended (the browser wants a gesture first). `force`
 * plays even when muted — the «test» press in the popover.
 */
export function playChime(options: { force?: boolean } = {}): boolean {
  if (!options.force && isMuted()) return true; // silence was asked for: not a failure
  const ctx = ensureContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    // Try once: it succeeds when the page already had a gesture and the context was only auto-suspended.
    void ctx.resume().then(emit, () => undefined);
  }
  if (ctx.state !== 'running') return false;
  const start = ctx.currentTime + 0.02;
  for (const note of NOTES) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = note.freq;
    const t = start + note.at;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + note.len);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + note.len + 0.05);
  }
  return true;
}

/** Forget the context — tests. */
export function __resetChimeForTests(): void {
  context = null;
  unlockArmed = false;
  listeners.clear();
}
