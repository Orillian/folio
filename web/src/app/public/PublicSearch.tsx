import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
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
  /** Called when a result is followed — the mobile drawer closes on it. */
  onNavigate?: () => void;
  /** Shown under the box while it is empty (the page tree); a non-empty query replaces it with the results. */
  children: ReactNode;
}

/**
 * Search box of a public site: a debounced (200 ms) call to the anonymous, space-scoped search
 * route and an inline results list that takes the place of `children` while there is a query.
 * Not the Cmd+K QuickSwitcher — that one lives inside AuthProvider and searches across spaces.
 */
export function PublicSearch({ site, onNavigate, children }: PublicSearchProps) {
  const { t } = useTranslation('app');
  const [query, setQuery] = useState('');
  const trimmed = useDebouncedValue(query.trim(), 200);
  const active = trimmed.length >= MIN_QUERY_LENGTH;

  const { data, isFetching, isError } = useQuery({
    queryKey: [PUBLIC_SITE_QUERY_KEY, site.space, 'search', trimmed],
    queryFn: () => api.searchPublic(site.space, trimmed),
    enabled: active,
    staleTime: 30_000,
    retry: false,
  });

  // The box shows what was typed this instant; the results follow the debounced value, so the
  // list under the box may lag a keystroke behind — "browsing" starts the moment the box is cleared.
  const showResults = query.trim().length >= MIN_QUERY_LENGTH;
  const hits = data?.hits ?? [];

  return (
    <>
      <div className="relative px-2 pb-2">
        <Search size={14} className="pointer-events-none absolute left-4 top-2 text-neutral-400" aria-hidden="true" />
        <input
          type="search"
          role="searchbox"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
          placeholder={t('publicSite.search.placeholder')}
          aria-label={t('publicSite.search.label')}
          className="w-full rounded-md border border-neutral-300 bg-white py-1.5 pl-8 pr-7 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
        {query && (
          <button
            type="button"
            aria-label={t('publicSite.search.clear')}
            onClick={() => setQuery('')}
            className="absolute right-3.5 top-1.5 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {showResults ? (
        <div className="px-2" aria-live="polite">
          {(isFetching || !active) && hits.length === 0 && (
            <p className="px-1.5 py-2 text-xs text-neutral-400">{t('publicSite.search.searching')}</p>
          )}
          {isError && <p className="px-1.5 py-2 text-xs text-red-600 dark:text-red-400">{t('publicSite.search.failed')}</p>}
          {active && !isFetching && !isError && hits.length === 0 && (
            <p className="px-1.5 py-2 text-xs text-neutral-500 dark:text-neutral-400">{t('publicSite.search.noResults', { query: trimmed })}</p>
          )}
          {hits.length > 0 && (
            <ul>
              {hits.map((hit) => (
                <li key={hit.id}>
                  <Link
                    to={publicPageUrl(site, hit.id)}
                    onClick={() => {
                      setQuery('');
                      onNavigate?.();
                    }}
                    className="block rounded-md px-1.5 py-1.5 text-sm text-neutral-800 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800/70"
                  >
                    <span className="block truncate">{hit.title}</span>
                    {hit.snippet && <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">{hit.snippet}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        children
      )}
    </>
  );
}
