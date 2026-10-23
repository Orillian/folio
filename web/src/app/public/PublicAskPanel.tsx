import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Send, Sparkles, Square, X } from 'lucide-react';
import type { PublicSiteInfo } from '@shared/contracts';
import { Markdown } from '../../markdown';
import type { Translate } from '../errorText';
import { runStepParts } from '../assistant/runStream';
import { useRunElapsed } from '../assistant/useRunElapsed';
import { useMarkdownPublicSite } from './PublicPageBody';
import { createPublicAskAdapter, publicAskErrorText } from './publicAsk';
import { usePublicAsk } from './usePublicAsk';
import '../i18n/register';

/** The server's cap on one question (publicAssistantRunBodySchema). */
const MAX_QUESTION_LENGTH = 4000;

function openStorageKey(slug: string): string {
  return `folio:public-ask-open:${slug}`;
}

/** Whether the panel was open before a reload / a remount of the site view; per tab, like the signed-in panel's flag. */
function readStoredOpen(slug: string): boolean {
  try {
    return sessionStorage.getItem(openStorageKey(slug)) === '1';
  } catch {
    return false;
  }
}

function storeOpen(slug: string, open: boolean): void {
  try {
    sessionStorage.setItem(openStorageKey(slug), open ? '1' : '0');
  } catch {
    // Storage unavailable: the panel just starts closed after a reload.
  }
}

/**
 * <Markdown>'s reading-view typography is page-sized (72ch column, 2.5rem padding, 1.9rem headings); inside an
 * answer bubble it is trimmed to chat scale. `!` on max-width because the "wide" display setting overrides it with a more specific rule.
 */
const ANSWER_CLASS =
  'min-w-0 [&_.folio-markdown]:max-w-none! [&_.folio-markdown]:p-0 [&_.folio-markdown]:text-[13.5px] [&_.folio-markdown]:leading-relaxed ' +
  '[&_.folio-markdown_:is(h1,h2,h3,h4)]:my-2 [&_.folio-markdown_:is(h1,h2)]:text-base [&_.folio-markdown_h3]:text-sm [&_.folio-markdown_h4]:text-sm ' +
  '[&_.folio-markdown_p]:mb-2 [&_.folio-markdown_p:last-child]:mb-0 [&_.folio-markdown_img]:max-w-full';

export interface PublicAskPanelProps {
  site: PublicSiteInfo;
  /** The page on screen, when there is one — sent with each question as the answer's navigation context. */
  pageId?: string;
}

/**
 * "Ask AI about this space": a button in the public site's header that toggles a chat over the site's
 * pages (a fixed sheet under the header), for anonymous visitors. The conversation is read-only Q&A on the
 * server side (public routes, the "Public visitor" system user); this component is only the chat UI — the run itself lives in
 * usePublicAsk, which stays mounted while the panel is closed, so an answer keeps streaming and a reload
 * restores the conversation (publicAsk.ts remembers it per site in localStorage).
 *
 * No feedback buttons, surveys or settings: those belong to signed-in users.
 */
export function PublicAskPanel({ site, pageId }: PublicAskPanelProps) {
  const { t } = useTranslation('app');
  const adapter = useMemo(() => createPublicAskAdapter(site.space), [site.space]);
  const ask = usePublicAsk(adapter, pageId);
  const markdownSite = useMarkdownPublicSite(site);
  const [open, setOpenState] = useState(() => readStoredOpen(site.space));
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const busy = ask.isRunning || ask.loading;
  const runElapsed = useRunElapsed(ask.isRunning, ask.step, ask.streamText);
  const askStatus = runStepParts(t as Translate, ask.step, runElapsed);
  const { hydrate } = ask;

  function setOpen(next: boolean) {
    setOpenState(next);
    storeOpen(site.space, next);
  }

  // First time the panel is on screen: bring back the remembered conversation (and a run still going in it).
  useEffect(() => {
    if (open) hydrate();
  }, [open, hydrate]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // `setOpen` only reads the site slug, which never changes for a mounted panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The input is disabled while an answer is on its way; hand the cursor back when it is done.
  useEffect(() => {
    if (open && !busy) inputRef.current?.focus();
  }, [open, busy]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [ask.messages, ask.streamText, ask.isRunning, open]);

  async function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    const started = await ask.send(text);
    // Not sent (rate limited, not set up, offline…): the question goes back to the input.
    if (!started) setDraft((current) => current || text);
  }

  // On a phone the panel covers the page, so following a link to one of the site's pages has to get it out of the way.
  function onMessagesClick(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof Element) || !event.target.closest('a[data-folio-nav]')) return;
    if (window.matchMedia?.('(max-width: 767px)').matches) setOpen(false);
  }

  const errorMessage = ask.error ? publicAskErrorText(t as Translate, ask.error) : null;

  return (
    <>
      {/* The header button toggles the sheet. Short visible label from md up (icon only on a phone); the full sentence is the tooltip and the accessible name. */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('publicSite.ask.button')}
        title={t('publicSite.ask.button')}
        className={`ph-no-capture flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-sm text-neutral-700 hover:border-neutral-400 hover:bg-neutral-50 max-md:min-h-10 max-md:min-w-10 max-md:justify-center dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:bg-neutral-800 ${
          open
            ? 'border-neutral-400 bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-800'
            : 'border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-900'
        }`}
      >
        {ask.isRunning ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
        <span className="hidden md:inline">{t('publicSite.ask.buttonShort')}</span>
      </button>

      <section
        role="dialog"
        aria-label={t('publicSite.ask.title')}
        data-report-exclude=""
        hidden={!open}
        className="ph-no-capture fixed inset-x-2 bottom-2 z-[60] flex h-[min(80vh,720px)] flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white text-neutral-900 shadow-2xl md:inset-x-auto md:bottom-4 md:right-4 md:top-16 md:h-auto md:max-h-[720px] md:w-[420px] dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-3 py-2.5 dark:border-neutral-800">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
            <Sparkles size={16} aria-hidden="true" />
          </span>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('publicSite.ask.title')}</h2>
          <button
            type="button"
            onClick={ask.reset}
            disabled={busy || ask.messages.length === 0}
            aria-label={t('publicSite.ask.newConversation')}
            title={t('publicSite.ask.newConversation')}
            className="shrink-0 rounded p-1.5 text-neutral-500 hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-800"
          >
            <Plus size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={t('ui.close')}
            title={t('ui.close')}
            className="shrink-0 rounded p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        <p className="shrink-0 border-b border-neutral-100 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-800/40 dark:text-neutral-400">
          {t('publicSite.ask.intro', { space: site.name })}
        </p>

        {/* The click handler is delegated: it only looks for links rendered inside the answers. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" onClick={onMessagesClick}>
          <div className="flex flex-col gap-2.5">
            {ask.loading && (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-neutral-400" aria-label={t('ui.loading')} />
              </div>
            )}
            <div role="log" aria-live="polite" className="flex flex-col gap-2.5">
              {ask.messages.map((message) =>
                message.role === 'user' ? (
                  <div
                    key={message.id}
                    className="ml-auto max-w-[88%] whitespace-pre-wrap break-words rounded-xl bg-neutral-900 px-3 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
                  >
                    {message.content}
                  </div>
                ) : (
                  <div
                    key={message.id}
                    className="mr-auto min-w-0 max-w-[94%] overflow-x-auto rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-100"
                  >
                    <div className={ANSWER_CLASS}>
                      <Markdown markdown={message.content} space={site.space} pagePath="" publicSite={markdownSite} />
                    </div>
                  </div>
                ),
              )}
            </div>

            {ask.isRunning && (
              <div className="mr-auto max-w-[94%] rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800/60">
                {ask.streamText && (
                  <p className="whitespace-pre-wrap break-words text-neutral-800 dark:text-neutral-100" aria-live="off">
                    {ask.streamText}
                  </p>
                )}
                <div
                  role="status"
                  className={`flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400 ${
                    ask.streamText ? 'mt-2 border-t border-neutral-200 pt-2 dark:border-neutral-700' : ''
                  }`}
                >
                  <Loader2 className={`h-3.5 w-3.5 shrink-0 animate-spin ${ask.reconnecting ? 'text-amber-500' : ''}`} aria-hidden="true" />
                  <span className="min-w-0 truncate">{ask.reconnecting ? t('assistant.chat.reconnecting') : askStatus.text}</span>
                  {!ask.reconnecting && askStatus.elapsed ? <span className="shrink-0 tabular-nums">· {askStatus.elapsed}</span> : null}
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() => void ask.stop()}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-700"
                  >
                    <Square size={11} className="fill-current" aria-hidden="true" />
                    {t('publicSite.ask.stop')}
                  </button>
                </div>
              </div>
            )}

            {errorMessage && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
              >
                <span className="min-w-0 flex-1">{errorMessage}</span>
                <button
                  type="button"
                  onClick={ask.dismissError}
                  aria-label={t('ui.close')}
                  className="shrink-0 rounded p-0.5 hover:bg-red-100 dark:hover:bg-red-900/40"
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="shrink-0 border-t border-neutral-200 p-2.5 dark:border-neutral-800"
        >
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              rows={2}
              value={draft}
              maxLength={MAX_QUESTION_LENGTH}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends, Shift+Enter is a new line; Enter that confirms an IME composition is not a send.
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={t('publicSite.ask.placeholder')}
              aria-label={t('publicSite.ask.placeholder')}
              className="min-h-16 max-h-40 flex-1 resize-none rounded-lg border border-neutral-300 bg-white px-2.5 py-2 text-sm outline-none focus:border-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
            <button
              type="submit"
              disabled={!draft.trim() || busy}
              aria-label={t('publicSite.ask.send')}
              title={t('publicSite.ask.send')}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
            >
              <Send size={15} aria-hidden="true" />
            </button>
          </div>
          <p className="mt-1.5 text-[11px] leading-tight text-neutral-400 dark:text-neutral-500">{t('publicSite.ask.poweredBy')}</p>
        </form>
      </section>
    </>
  );
}
