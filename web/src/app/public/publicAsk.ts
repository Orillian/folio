/**
 * The client side of "Ask Folio AI" on a public site, minus React: where a visitor's conversation is
 * remembered, the adapter that maps the panel's four needs (start, events, stop, load) onto the
 * anonymous `/api/public/spaces/:slug/assistant/**` routes, and the wording of its failures. The state
 * machine that drives a run with an adapter is usePublicAsk.ts; the in-app panel's counterpart of this
 * file is its use of api.startAssistantRun & co.
 *
 * Nothing here may touch a session: the visitor is anonymous, and the only credential is the guest token
 * of the one conversation (a bearer secret returned once, when the conversation is created).
 */
import type { PublicAssistantConversation } from '@shared/contracts';
import { api, ApiError } from '../api';
import { apiErrorText, type Translate } from '../errorText';

/** The conversation a visitor continues on a reload: its id and the guest token that proves it is theirs. */
export interface PublicAskSession {
  conversationId: string;
  guestToken: string;
}

/** One bubble of the visitor's chat. Answers are Markdown, questions are plain text. */
export interface PublicAskMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

/** Per site: two sites on one host (path mode) must not share a conversation. */
export function publicAskStorageKey(slug: string): string {
  return `folio:public-ask:${slug}`;
}

/** The remembered conversation of this site, or null (none yet, storage unavailable, or unreadable). */
export function readPublicAskSession(slug: string): PublicAskSession | null {
  try {
    const raw = localStorage.getItem(publicAskStorageKey(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PublicAskSession> | null;
    if (typeof parsed?.conversationId === 'string' && typeof parsed.guestToken === 'string' && parsed.conversationId && parsed.guestToken) {
      return { conversationId: parsed.conversationId, guestToken: parsed.guestToken };
    }
  } catch {
    // Unreadable or storage blocked (private window): behave as a first visit.
  }
  return null;
}

/** Remembers the conversation, or forgets it with null. Silent when storage is unavailable: the chat still works until the tab is reloaded. */
export function writePublicAskSession(slug: string, session: PublicAskSession | null): void {
  try {
    if (session) localStorage.setItem(publicAskStorageKey(slug), JSON.stringify(session));
    else localStorage.removeItem(publicAskStorageKey(slug));
  } catch {
    // Quota or blocked storage — nothing to do.
  }
}

/** A conversation as the server stored it, as bubbles. */
export function messagesFromConversation(conversation: PublicAssistantConversation): PublicAskMessage[] {
  return conversation.messages.map((m) => ({ id: m.id, role: m.role, content: m.content }));
}

/**
 * What usePublicAsk needs from the server. The adapter owns the remembered session, so the panel never
 * handles a guest token: `start` creates or continues the conversation and remembers it, the other three
 * authenticate with whatever is remembered.
 */
export interface PublicAskAdapter {
  /** Is there a remembered conversation to restore? */
  hasSession: () => boolean;
  /** Asks a question (in the remembered conversation, or a new one) and remembers the conversation. `pageId` is the page the visitor is reading. */
  start: (message: string, pageId?: string) => Promise<{ runId: string; conversationId: string }>;
  /** URL of the NDJSON event stream of a run, replaying from `since` (read with subscribeAssistantRun, source `anonymous`). */
  events: (runId: string, since: number) => string;
  /** Cancels a run. */
  stop: (runId: string) => Promise<void>;
  /** The remembered conversation from the server, or null when there is none — or the server no longer knows it (404), in which case it is forgotten. */
  load: () => Promise<PublicAssistantConversation | null>;
  /** Forgets the remembered conversation ("New conversation"). */
  forget: () => void;
}

export function createPublicAskAdapter(slug: string): PublicAskAdapter {
  return {
    hasSession: () => readPublicAskSession(slug) !== null,

    async start(message, pageId) {
      const attempt = (session: PublicAskSession | null) =>
        api.startPublicAssistantRun(slug, {
          message,
          ...(session ? { conversationId: session.conversationId, guestToken: session.guestToken } : {}),
          ...(pageId ? { pageId } : {}),
        });
      const remembered = readPublicAskSession(slug);
      let started;
      try {
        started = await attempt(remembered);
      } catch (error) {
        // A remembered conversation the server no longer knows (or a token that is not its own) is a 404:
        // start a fresh one instead of leaving the visitor stuck. The remembered one is replaced only once the new one exists.
        if (remembered && error instanceof ApiError && error.status === 404) started = await attempt(null);
        else throw error;
      }
      writePublicAskSession(slug, { conversationId: started.conversationId, guestToken: started.guestToken });
      return { runId: started.runId, conversationId: started.conversationId };
    },

    events: (runId, since) => api.publicAssistantEventsUrl(slug, runId, since, readPublicAskSession(slug)?.guestToken ?? ''),

    async stop(runId) {
      const session = readPublicAskSession(slug);
      if (session) await api.stopPublicAssistantRun(slug, runId, session.guestToken);
    },

    async load() {
      const session = readPublicAskSession(slug);
      if (!session) return null;
      try {
        return await api.getPublicAssistantConversation(slug, session.conversationId, session.guestToken);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          writePublicAskSession(slug, null);
          return null;
        }
        throw error;
      }
    },

    forget: () => writePublicAskSession(slug, null),
  };
}

/**
 * Localized text for a failed question: the server's own refusals (not set up, rate limited, disabled in
 * the demo) through errorText.ts's rules, with the 429's `Retry-After` turned into "try again in N minutes"
 * when the server sent one; anything else — a dropped stream included — is the assistant's generic failure.
 */
export function publicAskErrorText(t: Translate, error: unknown): string {
  if (error instanceof ApiError && error.status === 429 && error.retryAfter) {
    return t('publicSite.ask.rateLimitedIn', { count: Math.max(1, Math.ceil(error.retryAfter / 60)) });
  }
  return apiErrorText(t, error, 'assistant.chat.errors.generic');
}
