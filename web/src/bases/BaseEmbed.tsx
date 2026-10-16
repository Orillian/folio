/**
 * A ```base block of a document, rendered in place: the same view a `.base`
 * page shows, run for the reader (POST /api/spaces/:space/base/preview, `this`
 * = the document). Read-only — the block's YAML is edited as text in the
 * editor; the pages' values are edited on a base page or in the pages.
 */
import { useEffect, useState } from 'react';
import type { BaseQueryResponse } from '@shared/bases/types';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Database } from 'lucide-react';
import { api } from '../app/api';
import { BaseResults, type PageHref } from './BaseResults';
import { ViewTypeIcon } from './BasePageView';
import './i18n/register';

export interface BaseEmbedProps {
  source: string;
  space: string;
  /** The document the block is in (`this`). */
  pageId?: string;
  pageHref?: PageHref;
  /** Links as plain anchors (the live editor's widget lives outside the app's router). */
  plainLinks?: boolean;
}

const EMBED_ROWS = 50;

export default function BaseEmbed({ source, space, pageId, pageHref, plainLinks }: BaseEmbedProps) {
  const { t } = useTranslation('bases');
  const [view, setView] = useState<string | undefined>(undefined);
  const [limit, setLimit] = useState(EMBED_ROWS);
  // Plain fetch, not react-query: the live editor mounts this in its own React root, outside the app's providers.
  const [state, setState] = useState<{ data?: BaseQueryResponse; loading: boolean; failed: boolean }>({ loading: true, failed: false });
  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, failed: false }));
    api.previewBase(space, { source, pageId, view, limit }).then(
      (data) => !cancelled && setState({ data, loading: false, failed: false }),
      () => !cancelled && setState((prev) => ({ ...prev, loading: false, failed: true })),
    );
    return () => {
      cancelled = true;
    };
  }, [space, pageId, source, view, limit]);
  const query = { isLoading: state.loading && !state.data, isError: state.failed, data: state.data };
  const href: PageHref = pageHref ?? ((id) => `/s/${space}/p/${id}`);
  const data = query.data;
  return (
    <div className="folio-base-embed not-prose my-3 rounded-lg border border-neutral-200 p-2 dark:border-neutral-700" data-testid="base-embed">
      <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400">
        <Database size={13} aria-hidden="true" />
        {data && data.views.length > 1
          ? data.views.map((v) => (
              <button
                key={v.name}
                type="button"
                onClick={() => setView(v.name)}
                aria-pressed={v.name === data.view}
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${v.name === data.view ? 'bg-neutral-100 font-medium text-neutral-800 dark:bg-neutral-800 dark:text-neutral-100' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/60'}`}
              >
                <ViewTypeIcon type={v.type} size={12} />
                {v.name}
              </button>
            ))
          : <span>{data?.view ?? t('embed.title')}</span>}
        {data && !data.error && <span className="ml-auto">{t('results', { count: data.total })}</span>}
      </div>
      {query.isLoading && <p className="p-2 text-sm text-neutral-400">{t('loading')}</p>}
      {query.isError && <p className="p-2 text-sm text-red-600 dark:text-red-400">{t('loadFailed')}</p>}
      {data?.error && (
        <p role="alert" className="flex items-start gap-1 p-2 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {data.error.message}
            {data.error.line ? ` (${t('error.line', { line: data.error.line })})` : ''}
          </span>
        </p>
      )}
      {data && !data.error && (
        <>
          {data.unsupportedType && <p className="mb-1 text-xs text-amber-700 dark:text-amber-300">{t('notSupportedType', { type: data.unsupportedType })}</p>}
          <BaseResults response={data} space={space} pageHref={href} compact plainLinks={plainLinks} />
          {data.rows.length < data.total && (
            <button type="button" onClick={() => setLimit((l) => l + EMBED_ROWS)} className="mt-2 text-xs text-blue-600 hover:underline dark:text-blue-400">
              {t('loadMore', { shown: data.rows.length, total: data.total })}
            </button>
          )}
        </>
      )}
    </div>
  );
}
