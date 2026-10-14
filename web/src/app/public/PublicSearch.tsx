import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { api } from '../api';
import { useDebouncedValue } from '../hooks';
import { PUBLIC_SITE_QUERY_KEY, publicPageUrl, type PublicSiteRef } from './publicSite';
import '../i18n/register';

/** Shorter queries match half the space; the server has nothing useful to say to them either. */
const MIN_QUERY_LENGTH = 2;

export interface PublicSearchProps {
  site: PublicSiteRef;
}

/**
 * Header search of a public site, modelled on the app's own header search (SearchBox + QuickSwitcher):
 * a button that opens a small search dialog with the input and the results under it. The query is a
 * debounced (200 ms) call to the anonymous, space-scoped search route. Ctrl/Cmd+K opens it too.
 * Not the QuickSwitcher itself — that one lives inside AuthProvider and searches across spaces.
 *
 * The dialog is `position: fixed` and carries its own state, so the button is the only thing that takes
 * room in the header, and the query survives the site view moving between the home and a page.
 */
export function PublicSearch({ site }: PublicSearchProps) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const trimmed = useDebouncedValue(query.trim(), 200);
  const active = trimmed.length >= MIN_QUERY_LENGTH;
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);

  const { data, isFetching, isError } = useQuery({
    queryKey: [PUBLIC_SITE_QUERY_KEY, site.space, 'search', trimmed],
    queryFn: () => api.searchPublic(site.space, trimmed),
    enabled: open && active,
    staleTime: 30_000,
    retry: false,
  });

  // The box shows what was typed this instant; the results follow the debounced value, so the
  // list under the box may lag a keystroke behind.
  const showResults = query.trim().length >= MIN_QUERY_LENGTH;
  const hits = data?.hits ?? [];
  const current = Math.min(activeIndex, Math.max(hits.length - 1, 0));

  function close() {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
    triggerRef.current?.focus();
  }

  // Ctrl/Cmd+K, like the app's own header search.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Keep the keyboard-selected hit in view.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [current, hits.length]);

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' && hits.length > 0) {
      event.preventDefault();
      setActiveIndex(Math.min(current + 1, hits.length - 1));
    } else if (event.key === 'ArrowUp' && hits.length > 0) {
      event.preventDefault();
      setActiveIndex(Math.max(current - 1, 0));
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing && showResults && hits[current]) {
      event.preventDefault();
      void navigate(publicPageUrl(site, hits[current].id));
      close();
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('publicSite.search.label')}
        title={t('publicSite.search.label')}
        aria-haspopup="dialog"
        // The app's own header search pill (header/SearchBox.tsx): a bare 40px icon button below md,
        // the pill with its text and shortcut hint from md up, narrowing a little more on tight headers.
        className="flex h-9 items-center gap-2 rounded-md border border-neutral-300 bg-white px-2.5 text-left text-sm text-neutral-400 hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-neutral-600 max-md:min-h-10 max-md:min-w-10 max-md:shrink-0 max-md:justify-center md:w-full md:min-w-0 md:max-w-[11rem] lg:max-w-[14rem] xl:max-w-[18rem]"
      >
        <Search size={14} className="shrink-0" aria-hidden="true" />
        <span className="hidden min-w-0 flex-1 truncate md:inline">{t('publicSite.search.button')}</span>
        <kbd className="hidden shrink-0 rounded border border-neutral-300 bg-neutral-50 px-1.5 py-0.5 font-sans text-xs text-neutral-400 md:inline dark:border-neutral-700 dark:bg-neutral-800">
          {isMac ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[6vh] md:pt-[12vh]"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
          // Escape from anywhere inside: the input or a result link the visitor tabbed to.
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('publicSite.search.label')}
            className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white text-neutral-900 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          >
            <div className="flex items-center gap-2 border-b border-neutral-200 px-3.5 py-2.5 dark:border-neutral-700">
              <Search size={16} className="shrink-0 text-neutral-400" aria-hidden="true" />
              <input
                ref={inputRef}
                type="search"
                role="searchbox"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={onInputKeyDown}
                placeholder={t('publicSite.search.placeholder')}
                aria-label={t('publicSite.search.label')}
                className="w-full min-w-0 bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-100 [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button
                  type="button"
                  aria-label={t('publicSite.search.clear')}
                  onClick={() => {
                    setQuery('');
                    setActiveIndex(0);
                    inputRef.current?.focus();
                  }}
                  className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>

            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5" aria-live="polite">
              {!showResults && <p className="px-2.5 py-2 text-sm text-neutral-400">{t('publicSite.search.hint')}</p>}
              {showResults && (
                <>
                  {(isFetching || !active) && hits.length === 0 && (
                    <p className="px-2.5 py-2 text-sm text-neutral-400">{t('publicSite.search.searching')}</p>
                  )}
                  {isError && <p className="px-2.5 py-2 text-sm text-red-600 dark:text-red-400">{t('publicSite.search.failed')}</p>}
                  {active && !isFetching && !isError && hits.length === 0 && (
                    <p className="px-2.5 py-2 text-sm text-neutral-500 dark:text-neutral-400">{t('publicSite.search.noResults', { query: trimmed })}</p>
                  )}
                  {hits.length > 0 && (
                    <ul>
                      {hits.map((hit, index) => (
                        <li key={hit.id}>
                          <Link
                            to={publicPageUrl(site, hit.id)}
                            onClick={close}
                            onMouseMove={() => setActiveIndex(index)}
                            data-active={index === current}
                            className={`block rounded-md px-2.5 py-1.5 text-sm text-neutral-800 dark:text-neutral-200 ${
                              index === current ? 'bg-neutral-100 dark:bg-neutral-800' : ''
                            }`}
                          >
                            <span className="block truncate">{hit.title}</span>
                            {hit.snippet && <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">{hit.snippet}</span>}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
