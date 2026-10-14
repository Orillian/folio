import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssistantRunStep } from '@shared/contracts';
import { ApiError } from '../api';
import { subscribeAssistantRun, type AssistantEventsSource } from '../assistant/stream';
import { createDeltaBatcher, createRunEventHandler } from '../assistant/runStream';
import { messagesFromConversation, type PublicAskAdapter, type PublicAskMessage } from './publicAsk';

/** How often a tracked run is checked against the server's own record, independent of the stream's health (see the heartbeat effect). */
const HEARTBEAT_MS = 30_000;

export interface PublicAskState {
  messages: PublicAskMessage[];
  /** The answer so far, while a run streams. */
  streamText: string;
  step: AssistantRunStep | null;
  /** A question is being sent or answered. */
  isRunning: boolean;
  /** The stream dropped and is backing off before it retries. */
  reconnecting: boolean;
  /** The remembered conversation is being restored. */
  loading: boolean;
  /** The last failure (an ApiError from the server, or a plain Error for a failed stream); null when there is none. */
  error: unknown;
  /** Restores the remembered conversation once (and re-attaches to a run still going in it). Call when the panel is first opened. */
  hydrate: () => void;
  /** Asks a question. Resolves true when the run started; false when it did not (`error` says why) and the text should go back to the input. */
  send: (message: string) => Promise<boolean>;
  stop: () => Promise<void>;
  /** Starts over: forgets the remembered conversation and clears the chat. */
  reset: () => void;
  dismissError: () => void;
}

/**
 * The visitor's Ask AI chat on a public site: the public counterpart of AssistantRunProvider +
 * AssistantPanel's conversation state. The wire is the injected `adapter` (publicAsk.ts); everything that
 * decides how a run is read and drawn is the signed-in panel's own code — subscribeAssistantRun for the
 * NDJSON stream (reconnects, `since` de-duplication), createRunEventHandler / createDeltaBatcher for what an
 * event does to the view — so the two cannot drift apart.
 *
 * What differs from the signed-in panel: no query cache (the conversation lives in this hook), the
 * conversation is the visitor's one remembered thread, and the run is not discovered through an
 * "active run" endpoint but through the conversation's `activeRunId`.
 */
export function usePublicAsk(adapter: PublicAskAdapter, pageId: string | undefined): PublicAskState {
  const [messages, setMessages] = useState<PublicAskMessage[]>([]);
  const [streamText, setStreamText] = useState('');
  const [step, setStep] = useState<AssistantRunStep | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Refs, not state: read inside the subscription's callbacks, which close over whichever render started them.
  const abortRef = useRef<AbortController | null>(null);
  const trackedRunRef = useRef<string | null>(null);
  const lastSeqRef = useRef(0);
  const textRef = useRef('');
  const submittingRef = useRef(false);
  const hydratedRef = useRef(false);
  const pageIdRef = useRef(pageId);
  pageIdRef.current = pageId;
  /** Sidesteps a circular useCallback dependency: resync needs attach, and attach calls resync when the stream gives up. Kept current below. */
  const attachRef = useRef<(runId: string, since: number) => void>(() => {});

  const source = useMemo<AssistantEventsSource>(() => ({ url: adapter.events, anonymous: true }), [adapter]);
  const batcher = useMemo(
    () =>
      createDeltaBatcher((chunk) => {
        textRef.current += chunk;
        setStreamText(textRef.current);
      }),
    [],
  );
  const handleRunEvent = useMemo(() => createRunEventHandler({ onStep: setStep, onDelta: batcher.push }), [batcher]);

  /** Ends the tracked run's live state (not the messages). */
  const finishRun = useCallback(() => {
    trackedRunRef.current = null;
    abortRef.current = null;
    batcher.cancel();
    textRef.current = '';
    setRunId(null);
    setStreamText('');
    setStep(null);
    setReconnecting(false);
  }, [batcher]);

  const appendMessage = useCallback((message: PublicAskMessage) => {
    setMessages((current) => (current.some((m) => m.id === message.id) ? current : [...current, message]));
  }, []);

  /**
   * The stream gave up (budget exhausted, or the server refused it): ask the server what became of the run.
   * Still going -> subscribe again from where we were, with a fresh reconnect budget (unless the refusal
   * was final, which asking again would only repeat). Otherwise show what the server stored.
   */
  const resync = useCallback(
    async (id: string, mayReattach: boolean) => {
      try {
        const conversation = await adapter.load();
        if (trackedRunRef.current !== id) return; // superseded meanwhile (stop / new question / unmount)
        if (mayReattach && conversation?.activeRunId === id) {
          attachRef.current(id, lastSeqRef.current);
          return;
        }
        if (conversation) setMessages(messagesFromConversation(conversation));
        else setError(new Error('conversation unavailable'));
      } catch (failure) {
        if (trackedRunRef.current !== id) return;
        setError(failure);
      }
      finishRun();
    },
    [adapter, finishRun],
  );

  /** (Re)opens the event subscription for `id` from `since`. Callers set the visible text first, so partial text shows at once. */
  const attach = useCallback(
    (id: string, since: number) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      trackedRunRef.current = id;
      lastSeqRef.current = since;

      subscribeAssistantRun({
        runId: id,
        since,
        source,
        signal: controller.signal,
        onReconnecting: (value) => {
          if (trackedRunRef.current === id) setReconnecting(value);
        },
        onEvent: (event) => {
          if (trackedRunRef.current !== id) return;
          lastSeqRef.current = event.seq;
          handleRunEvent(event);
        },
      })
        .then((terminal) => {
          if (trackedRunRef.current !== id) return;
          if (terminal.type === 'complete') {
            appendMessage({ id: terminal.message.id, role: 'assistant', content: terminal.message.content });
          } else if (terminal.type === 'error') {
            setError(new Error(terminal.code));
          }
          // 'stopped' is silent: stop() already kept the partial text it had.
          finishRun();
        })
        .catch((failure: unknown) => {
          if (trackedRunRef.current !== id) return;
          abortRef.current = null;
          if (failure instanceof DOMException && failure.name === 'AbortError') return;
          setReconnecting(false);
          // A 4xx from the events route means the server will not show this run to us (unknown run, wrong token): asking again cannot help.
          void resync(id, !(failure instanceof ApiError));
        });
    },
    [appendMessage, finishRun, handleRunEvent, resync, source],
  );
  useEffect(() => {
    attachRef.current = attach;
  }, [attach]);

  const startTracking = useCallback(
    (id: string, since: number) => {
      batcher.cancel();
      textRef.current = '';
      setStreamText('');
      setStep(null);
      setRunId(id);
      attach(id, since);
    },
    [attach, batcher],
  );

  const hydrate = useCallback(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    if (!adapter.hasSession()) return;
    setLoading(true);
    adapter
      .load()
      .then((conversation) => {
        if (!conversation) return;
        // Questions asked while this was loading are already on screen; the server's list is authoritative and includes them.
        setMessages(messagesFromConversation(conversation));
        // A reload during an answer: the run's events replay from the start, rebuilding the text so far.
        if (conversation.activeRunId && !trackedRunRef.current) startTracking(conversation.activeRunId, 0);
      })
      .catch(() => undefined) // leave the chat empty; the conversation stays remembered, so the next question still continues it
      .finally(() => setLoading(false));
  }, [adapter, startTracking]);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const message = text.trim();
      if (!message || submittingRef.current || trackedRunRef.current) return false;
      submittingRef.current = true;
      setSubmitting(true);
      setError(null);
      const optimistic: PublicAskMessage = { id: `optimistic-${Date.now()}`, role: 'user', content: message };
      setMessages((current) => [...current, optimistic]);
      try {
        const started = await adapter.start(message, pageIdRef.current);
        startTracking(started.runId, 0);
        return true;
      } catch (failure) {
        // The run never started server-side: the question was not sent, so its bubble goes (the caller puts the text back in the input).
        setMessages((current) => current.filter((m) => m.id !== optimistic.id));
        setError(failure);
        return false;
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [adapter, startTracking],
  );

  const stop = useCallback(async () => {
    const id = trackedRunRef.current;
    if (!id) return;
    const partial = textRef.current;
    abortRef.current?.abort();
    if (partial.trim()) appendMessage({ id: `stopped-${Date.now()}`, role: 'assistant', content: partial });
    finishRun();
    try {
      await adapter.stop(id);
    } catch {
      // Best-effort: the subscription is already torn down locally either way.
    }
  }, [adapter, appendMessage, finishRun]);

  const reset = useCallback(() => {
    if (trackedRunRef.current || submittingRef.current) return;
    adapter.forget();
    setMessages([]);
    setError(null);
  }, [adapter]);

  const dismissError = useCallback(() => setError(null), []);

  // Terminal-state guarantee (the signed-in panel's HEARTBEAT, same reason): the stream can look healthy
  // while the run has long finished and its last event never arrived. While a run is tracked, ask the
  // server on a timer; the moment it disagrees, show what it stored.
  useEffect(() => {
    if (!runId) return;
    const timer = setInterval(() => {
      if (trackedRunRef.current !== runId) return;
      adapter
        .load()
        .then((conversation) => {
          if (trackedRunRef.current !== runId || !conversation || conversation.activeRunId === runId) return;
          abortRef.current?.abort();
          setMessages(messagesFromConversation(conversation));
          finishRun();
        })
        .catch(() => undefined); // a failed check just tries again next tick
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [adapter, finishRun, runId]);

  // Leaving the page must not leave a read open; the run itself keeps going on the server and is picked up again on return.
  useEffect(
    () => () => {
      trackedRunRef.current = null;
      abortRef.current?.abort();
      batcher.cancel();
    },
    [batcher],
  );

  return {
    messages,
    streamText,
    step,
    isRunning: runId !== null || submitting,
    reconnecting,
    loading,
    error,
    hydrate,
    send,
    stop,
    reset,
    dismissError,
  };
}
