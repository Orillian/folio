import type { AssistantRunEvent, AssistantRunStep } from '@shared/contracts';

/**
 * The pieces of "show a run as it streams" that do not depend on WHO is asking: shared by the signed-in
 * panel (runState.tsx) and the public site's Ask panel (app/public/usePublicAsk.ts). The transport
 * (NDJSON, reconnects, de-duplication) is stream.ts's subscribeAssistantRun; this file is what both
 * panels do with each event it delivers, so a change to how a run is drawn happens once.
 */

/** Every run event a subscriber sees (`ping` only keeps the connection alive and is filtered out by stream.ts). */
export type RunDataEvent = Exclude<AssistantRunEvent, { type: 'ping' }>;

export interface RunEventHandlers {
  /** The agent moved to another step (thinking, a tool, writing the reply). */
  onStep: (step: AssistantRunStep) => void;
  /** A piece of the reply text. */
  onDelta: (text: string) => void;
}

/**
 * Turns the NDJSON events into view updates: `status` -> the step line, `delta` -> text. Terminal events
 * (`complete`, `stopped`, `error`) are deliberately ignored here — they end the subscription, and each
 * panel reacts to the terminal event it gets back from subscribeAssistantRun.
 */
export function createRunEventHandler({ onStep, onDelta }: RunEventHandlers): (event: RunDataEvent) => void {
  return (event) => {
    if (event.type === 'status') {
      onStep({
        status: event.status,
        label: event.label,
        ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
        ...(event.generating ? { generating: true } : {}),
      });
    }
    else if (event.type === 'delta') onDelta(event.text);
  };
}

export interface DeltaBatcher {
  /** Queues text; it is flushed with the next animation frame, together with anything queued meanwhile. */
  push: (text: string) => void;
  /** Drops queued text and cancels the pending frame — call before the visible text is replaced or reset, so a stale frame cannot append to the new text. */
  cancel: () => void;
}

/**
 * Batches streamed text into at most one state update per animation frame (owner report, 22.09.2026: "it
 * writes one letter at a time"): on top of the server's own coalescing, this catches several events landing
 * in one frame (a reconnect's replay burst) so that does not cost one React render per event.
 */
export function createDeltaBatcher(flush: (chunk: string) => void): DeltaBatcher {
  let pending = '';
  let frame: number | null = null;
  return {
    push(text) {
      pending += text;
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!pending) return;
        const chunk = pending;
        pending = '';
        flush(chunk);
      });
    },
    cancel() {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      pending = '';
    },
  };
}

/** Tools whose arguments are the text of a page: while they are generated the status says "writing a page". */
const PAGE_WRITING_TOOLS = ['create_page', 'update_page'];

/** How long without a run event before the status line starts counting seconds (the model can be silent for minutes while it writes a tool call). */
export const STALE_AFTER_MS = 3_000;

/** "45 s" / "1 min 12 s": whole seconds as a short duration for the status line. */
export function formatElapsed(t: (key: string, values?: Record<string, unknown>) => string, totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return t('assistant.chat.status.elapsedSeconds', { seconds });
  return t('assistant.chat.status.elapsedMinutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

/**
 * The "what is the agent doing" line shown next to the spinner while a run streams. `t` is the app namespace's
 * translate function. `elapsedSec` is the silence since the last run event (null while events keep arriving): it
 * is appended as "· 45 s", and a plain thinking / writing step — the stretch where the model writes a tool call or
 * the reply and the SDK reports nothing — says so instead of the generic "analyzing".
 */
export function runStepText(t: (key: string, values?: Record<string, unknown>) => string, step: AssistantRunStep | null, elapsedSec: number | null = null): string {
  const { text, elapsed } = runStepParts(t, step, elapsedSec);
  return elapsed === null ? text : `${text} · ${elapsed}`;
}

/** The status label and the elapsed counter apart — the panel truncates the label but never the counter. */
export function runStepParts(
  t: (key: string, values?: Record<string, unknown>) => string,
  step: AssistantRunStep | null,
  elapsedSec: number | null = null,
): { text: string; elapsed: string | null } {
  return { text: stepBaseText(t, step, elapsedSec !== null), elapsed: elapsedSec === null ? null : formatElapsed(t, elapsedSec) };
}

function stepBaseText(t: (key: string, values?: Record<string, unknown>) => string, step: AssistantRunStep | null, silent: boolean): string {
  if (!step) return t('assistant.chat.status.starting');
  const counter = step.tokens !== undefined && step.tokens > 0 ? ` ${t('assistant.chat.status.tokens', { tokens: step.tokens })}` : '';
  // The model is producing output that is not reply text yet: thinking, or the arguments of a tool call (a page for create_page).
  // A thinking counter that stopped moving: the model went on to write something the SDK does not report (a tool call's arguments).
  if (step.status === 'thinking' && step.tokens !== undefined) return silent ? t('assistant.chat.status.modelPreparing') : `${t('assistant.chat.status.thinkingNow')}${counter}`;
  if (step.status === 'tool' && step.generating) {
    if (step.label && PAGE_WRITING_TOOLS.some((name) => step.label!.endsWith(name))) return `${t('assistant.chat.status.draftingPage')}${counter}`;
    const base = step.label ? t('assistant.chat.status.preparingTool', { tool: step.label }) : t('assistant.chat.status.preparingAction');
    return `${base}${counter}`;
  }
  if (step.status === 'tool' && step.label) return t('assistant.chat.status.tool', { tool: step.label });
  if (silent && !step.label && (step.status === 'thinking' || step.status === 'writing')) return t('assistant.chat.status.modelPreparing');
  return step.label ?? t(`assistant.chat.status.${step.status}`);
}
