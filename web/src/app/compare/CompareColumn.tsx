import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ExternalLink, X } from 'lucide-react';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { PageContent, fetchPage } from '../routes/PageContent';
import { PageCrashed } from '../routes/PageCrashed';
import { formatRelativeDate, shortSha } from '../history';
import { api } from '../api';
import { VersionBody, type CompareBase } from './VersionBody';
import type { CompareRef } from './compareList';
import { zoomAppliesToKind } from './compareZoom';
import '../i18n/register';

export interface CompareColumnProps {
  entry: CompareRef;
  /** The leftmost column: the one the others are compared with. */
  isBase: boolean;
  /** The view's zoom, in percent: applied to the body of the column, never to its title bar. */
  zoom: number;
  /** Draw the base marker (only when something is compared with it). */
  showBaseMarker: boolean;
  /** Text to compare a version column with; null when this is the base or highlighting is off. */
  base: CompareBase | null;
  onRemove: () => void;
}

/**
 * One column of the compare view: a compact title bar (title, space, version, open, remove) over a body that scrolls
 * on its own. A column of the CURRENT page is the page itself — PageContent, the same editor with the same live
 * collaboration (its own session per page, see useCollabSession); a column of a VERSION is read-only.
 */
export function CompareColumn({ entry, isBase, zoom, showBaseMarker, base, onRemove }: CompareColumnProps) {
  const { t } = useTranslation('app');
  // The page's own cache entry (PageContent reads the same one): title, space, kind, path.
  const { data: page } = useQuery({ queryKey: ['page', entry.pageId], queryFn: () => fetchPage(entry.pageId), networkMode: 'always' });
  const { data: history } = useQuery({
    queryKey: ['history', entry.pageId],
    queryFn: () => api.getPageHistory(entry.pageId),
    enabled: Boolean(entry.sha),
  });
  // A board, canvas, artifact or file viewer keeps its own scale: CSS zoom would clip Excalidraw's canvas and skew its pointer.
  const effectiveZoom = zoomAppliesToKind(page?.kind) ? zoom : 100;
  const version = entry.sha ? history?.find((item) => item.sha === entry.sha) : undefined;

  return (
    <section
      data-compare-column={entry.sha ? `${entry.pageId}@${entry.sha}` : entry.pageId}
      className="flex min-h-0 min-w-[360px] flex-1 basis-0 snap-start flex-col border-r border-neutral-200 last:border-r-0 max-md:min-w-[85vw] dark:border-neutral-800"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-3 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">{page?.title ?? entry.pageId}</div>
          <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">
            {page?.space}
            {entry.sha && (
              <>
                {page?.space ? ' · ' : ''}
                {version ? t('compare.column.versionFrom', { date: formatRelativeDate(version.date), sha: shortSha(entry.sha) }) : t('compare.tray.version', { sha: shortSha(entry.sha) })}
              </>
            )}
          </div>
        </div>
        {isBase && showBaseMarker && (
          <span title={t('compare.column.baseHint')} className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
            {t('compare.column.base')}
          </span>
        )}
        {page && (
          <Link
            to={`/s/${encodeURIComponent(page.space)}/p/${encodeURIComponent(entry.pageId)}`}
            aria-label={t('compare.column.open')}
            title={t('compare.column.open')}
            className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
          >
            <ExternalLink size={14} aria-hidden="true" />
          </Link>
        )}
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('compare.column.remove')}
          title={t('compare.column.remove')}
          className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      {/* The column's own scroll area, like the shell's <main>. The editors and the reading view scroll inside themselves (scrollSync.ts finds whichever scrolls). A wide table or code block scrolls inside its own box (compare.css); this area only scrolls sideways for what has no box of its own.
          The zoom (only for document-like kinds, see zoomAppliesToKind) is CSS `zoom` on an inner wrapper: it scales lengths and fonts alike, so the text reflows to the column (a 50% column shows twice the text per line), unlike a transform that would only shrink the picture. */}
      <div data-compare-body="" className="min-h-0 flex-1 overflow-x-auto overflow-y-auto">
        <div data-compare-zoom={effectiveZoom} className="h-full" style={effectiveZoom === 100 ? undefined : { zoom: effectiveZoom / 100 }}>
          <ErrorBoundary
            resetKey={`${entry.pageId}@${entry.sha ?? ''}`}
            fallback={(error, reset, eventId) => <PageCrashed onRetry={reset} eventId={eventId} error={error} />}
          >
            {entry.sha ? (
              <VersionBody pageId={entry.pageId} sha={entry.sha} page={page} base={base} />
            ) : (
              <div className="h-full">
                <PageContent id={entry.pageId} embedded />
              </div>
            )}
          </ErrorBoundary>
        </div>
      </div>
    </section>
  );
}
