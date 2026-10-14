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
    if (event.type === 'status') onStep({ status: event.status, label: event.label });
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

/** The "what is the agent doing" line shown next to the spinner while a run streams. `t` is the app namespace's translate function. */
export function runStepText(t: (key: string, values?: Record<string, unknown>) => string, step: AssistantRunStep | null): string {
  if (!step) return t('assistant.chat.status.starting');
  if (step.status === 'tool' && step.label) return t('assistant.chat.status.tool', { tool: step.label });
  return step.label ?? t(`assistant.chat.status.${step.status}`);
}
