import { useCallback, useEffect, useRef } from 'react';

/**
 * Local drafts for forms — the shared plumbing behind both sides of the
 * "a reload must not eat half an hour of work" fix:
 *   - the form BUILDER's dialog (app/routes/FormDefinitionEditor.tsx), and
 *   - the form RESPONDENT's answers (forms/FormRenderer.tsx).
 *
 * Same stance as tables/views/viewDraft.ts: a draft is private, local and
 * best-effort. Every storage failure (private mode, quota, a draft written by
 * an older build, malformed JSON) degrades to "no draft" and never throws.
 */

const BUILDER_PREFIX = 'folio:form-builder-draft';
const ANSWERS_PREFIX = 'folio:form-answers';

/** Drafts older than this are treated as abandoned and ignored. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Debounce for continuous autosave. */
export const DRAFT_DEBOUNCE_MS = 500;

/** Builder draft: per user + per form page, so two editors on one browser never see each other's. */
export function builderDraftKey(pageId: string, userId: string | undefined): string {
  return `${BUILDER_PREFIX}:${userId ?? 'anon'}:${pageId}`;
}

/**
 * Respondent answers: per form + per "who is filling it" scope — a signed-in
 * user, an anonymous share-link guest (the token), or an embed. Two forms or
 * two people on one browser never share a slot.
 */
export function answersDraftKey(formId: string, scope: string): string {
  return `${ANSWERS_PREFIX}:${scope}:${formId}`;
}

export interface StoredDraft<T> {
  savedAt: number;
  data: T;
}

export function readDraft<T>(key: string, now: number = Date.now()): StoredDraft<T> | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: unknown; savedAt?: unknown; data?: unknown };
    if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) return null;
    if (typeof parsed.savedAt !== 'number' || !parsed.data || typeof parsed.data !== 'object') return null;
    if (now - parsed.savedAt > DRAFT_MAX_AGE_MS) {
      removeDraft(key);
      return null;
    }
    return { savedAt: parsed.savedAt, data: parsed.data as T };
  } catch {
    return null;
  }
}

export function writeDraft<T>(key: string, data: T, now: number = Date.now()): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ v: 1, savedAt: now, data }));
  } catch {
    // Quota / storage disabled: the work still lives in memory for this session.
  }
}

export function removeDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* see writeDraft */
  }
}

/** "14:05" for today, "16 Oct, 14:05" otherwise — localised to the UI language. */
export function formatDraftTime(savedAt: number, language: string, now: number = Date.now()): string {
  const at = new Date(savedAt);
  const today = new Date(now);
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  try {
    return sameDay
      ? at.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
      : at.toLocaleString(language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return at.toISOString();
  }
}

export interface DraftAutosaveOptions {
  /** Autosave is paused while false (e.g. a stored draft is on offer and must not be overwritten yet). */
  enabled: boolean;
  /** false -> the current value is "nothing worth keeping" and the stored draft is removed instead. */
  persist: boolean;
  delayMs?: number;
}

export interface DraftAutosave {
  /** Remove the stored draft and stop writing until `resume()` — call on a successful save/submit and on an explicit discard. */
  clear: () => void;
  /** Start writing again after `clear()` (e.g. "submit another response"). */
  resume: () => void;
}

/**
 * Debounced continuous autosave of `value` under `key`. Unchanged values are
 * not rewritten (a restored draft keeps its original timestamp until it is
 * actually edited). A write still pending when the page is hidden/reloaded or
 * the component unmounts is flushed synchronously, so the last keystrokes
 * before a reload are not lost to the debounce.
 */
export function useDraftAutosave<T>(key: string | undefined, value: T, options: DraftAutosaveOptions): DraftAutosave {
  const { enabled, persist, delayMs = DRAFT_DEBOUNCE_MS } = options;
  const latest = useRef({ key, value, persist, enabled });
  latest.current = { key, value, persist, enabled };
  const lastSerialized = useRef<string | null>(null);
  const pending = useRef(false);
  const suspended = useRef(false);

  const commit = useCallback(() => {
    pending.current = false;
    const { key: k, value: v, persist: p, enabled: e } = latest.current;
    if (!k || !e || suspended.current) return;
    const serialized = JSON.stringify([p, v]);
    if (serialized === lastSerialized.current) return;
    lastSerialized.current = serialized;
    if (p) writeDraft(k, v);
    else removeDraft(k);
  }, []);

  useEffect(() => {
    if (!key || !enabled || suspended.current) return undefined;
    const serialized = JSON.stringify([persist, value]);
    // First run (or first run after resume/enable): the value on screen IS what is stored
    // (or what was just discarded) — adopt it as the baseline instead of rewriting it.
    if (lastSerialized.current === null) {
      lastSerialized.current = serialized;
      return undefined;
    }
    if (serialized === lastSerialized.current) return undefined;
    pending.current = true;
    const timer = window.setTimeout(commit, delayMs);
    return () => window.clearTimeout(timer);
  }, [key, value, persist, enabled, delayMs, commit]);

  useEffect(() => {
    const flush = () => {
      if (pending.current) commit();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [commit]);

  const clear = useCallback(() => {
    suspended.current = true;
    pending.current = false;
    lastSerialized.current = null;
    if (latest.current.key) removeDraft(latest.current.key);
  }, []);
  const resume = useCallback(() => {
    suspended.current = false;
    lastSerialized.current = null;
  }, []);

  return { clear, resume };
}

/**
 * Ask the browser to confirm before the tab is closed / reloaded while
 * `active` (unsaved or unsent work). The draft is kept either way — this is
 * just the "are you sure" safety net.
 */
export function useBeforeUnloadWarning(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);
}
