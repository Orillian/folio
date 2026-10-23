import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Link as LinkIcon, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useDocumentTitle } from '../hooks';
import { useToast } from '../ui/Toast';
import { fetchPage } from '../routes/PageContent';
import { CompareColumn } from './CompareColumn';
import { useCompare } from './compareContext';
import { comparePath, parseCompareParam, type CompareRef } from './compareList';
import { useScrollSync } from './scrollSync';
import { CompareZoomControl } from './CompareZoomControl';
import { readStoredZoom, writeStoredZoom } from './compareZoom';
import type { CompareBase } from './VersionBody';
import './compare.css';
import '../i18n/register';

/**
 * `/compare?items=<pageId>,<pageId>@<sha>,…` — 2 to 5 pages and versions side by side.
 *
 * The URL is the whole state of the view (columns and their order), so a link can be sent to anyone: each reader's
 * browser fetches every column with THEIR rights, and a column they cannot open shows the usual no-access /
 * not-found notice instead of breaking the view. The reader's own compare list (localStorage) only feeds the tray.
 *
 * Outside the space shell on purpose: the columns come from any spaces, so there is no single space for a sidebar
 * to show. The leftmost column is the base the version columns are highlighted against.
 */
export function ComparePage() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const showToast = useToast();
  const compare = useCompare();
  const [params] = useSearchParams();
  const refs = parseCompareParam(params.get('items'));
  const hasVersion = refs.some((ref) => ref.sha);
  useDocumentTitle(t('compare.title'));

  // Highlighting follows the versions (default on while there is one); scroll sync too. null = "not chosen, use the default".
  const [highlightChoice, setHighlightChoice] = useState<boolean | null>(null);
  const [syncChoice, setSyncChoice] = useState<boolean | null>(null);
  const highlight = hasVersion && (highlightChoice ?? true);
  const sync = syncChoice ?? hasVersion;

  // One zoom for every column, remembered by this browser.
  const [zoom, setZoomState] = useState(readStoredZoom);
  const setZoom = useCallback((next: number) => {
    setZoomState(next);
    writeStoredZoom(next);
  }, []);

  // CSS `zoom` changes the editors' scale without resizing the window: CodeMirror reads its scale (pointer mapping) on
  // a measure, and a window `resize` is what makes it take one.
  useEffect(() => {
    window.dispatchEvent(new Event('resize'));
  }, [zoom]);

  const columnsRef = useRef<HTMLDivElement>(null);
  useScrollSync(columnsRef, sync);

  // The base's text: the leftmost column, as it is now (live page) or as it was (version). Only asked for while highlighting.
  const first = refs[0];
  const baseQuery = useQuery({
    queryKey: ['compare-base', first?.pageId, first?.sha ?? 'live'],
    queryFn: async () => (first.sha ? (await api.getPageHistoryVersion(first.pageId, first.sha)).markdown : (await fetchPage(first.pageId)).markdown),
    enabled: highlight && Boolean(first),
    // A live page changes under the reader's hands; the text is read again whenever highlighting is switched on or "Refresh" is pressed.
    staleTime: 0,
    gcTime: 0,
    networkMode: 'always',
  });
  const base: CompareBase = { markdown: baseQuery.data, loading: baseQuery.isLoading };

  const go = useCallback((next: CompareRef[]) => navigate(comparePath(next), { replace: true }), [navigate]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast(t('compare.linkCopied'), 'info');
    } catch {
      showToast(window.location.href);
    }
  }

  const goBack = () => (window.history.length > 1 ? navigate(-1) : navigate('/'));

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-950">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
        <button
          type="button"
          onClick={goBack}
          aria-label={t('compare.page.back')}
          title={t('compare.page.back')}
          className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 max-md:min-h-10 max-md:min-w-10 dark:hover:bg-neutral-800"
        >
          <ArrowLeft size={17} aria-hidden="true" />
        </button>
        <h1 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {t('compare.title')} <span className="font-normal text-neutral-400">· {refs.length}</span>
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-700 dark:text-neutral-300">
          {hasVersion && (
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={highlight} onChange={(e) => setHighlightChoice(e.target.checked)} />
              {t('compare.page.highlight')}
            </label>
          )}
          {highlight && (
            <button
              type="button"
              onClick={() => void baseQuery.refetch()}
              disabled={baseQuery.isFetching}
              title={t('compare.page.refreshHint')}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
            >
              <RefreshCw size={12} aria-hidden="true" />
              {t('compare.page.refresh')}
            </button>
          )}
          <label className="inline-flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={sync} onChange={(e) => setSyncChoice(e.target.checked)} />
            {t('compare.page.syncScroll')}
          </label>
          <button
            type="button"
            onClick={() => void copyLink()}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <LinkIcon size={12} aria-hidden="true" />
            {t('compare.page.copyLink')}
          </button>
          <button
            type="button"
            onClick={() => {
              compare.clear();
              navigate('/');
            }}
            className="rounded-md px-1.5 py-1 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {t('compare.clear')}
          </button>
        </div>
      </header>

      {refs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
          <p className="max-w-sm">{t('compare.page.empty')}</p>
          <Link to="/" className="text-blue-600 underline underline-offset-2 dark:text-blue-400">
            {t('admin.backHome')}
          </Link>
        </div>
      ) : (
        <>
          {refs.length === 1 && <p className="shrink-0 border-b border-neutral-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-neutral-800 dark:bg-amber-950/30 dark:text-amber-200">{t('compare.page.needMore')}</p>}
          {/* Equal columns; below 360px each the row scrolls sideways (on a phone: swipes, one column nearly a screen wide). */}
          <div ref={columnsRef} className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto md:snap-none">
            {refs.map((ref, index) => (
              <CompareColumn
                key={ref.sha ? `${ref.pageId}@${ref.sha}` : ref.pageId}
                entry={ref}
                isBase={index === 0}
                zoom={zoom}
                showBaseMarker={highlight && refs.length > 1}
                base={highlight && index > 0 ? base : null}
                onRemove={() => {
                  compare.remove(ref);
                  go(refs.filter((_, i) => i !== index));
                }}
              />
            ))}
          </div>
          <CompareZoomControl zoom={zoom} onChange={setZoom} />
        </>
      )}
    </div>
  );
}
