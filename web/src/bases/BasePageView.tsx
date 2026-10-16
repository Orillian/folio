import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Eye, LayoutGrid, List, Map as MapIcon, Pencil, Settings2, SquareKanban, Table2 } from 'lucide-react';
import type { BaseColumn, BaseQueryResponse, BaseRow } from '@shared/bases/types';
import { api, ApiError } from '../app/api';
import { BaseResults, type PageHref } from './BaseResults';
import { sameAsShown } from './model';
import './i18n/register';

const BaseEditor = lazy(() => import('./BaseEditor'));

export const BASE_PAGE_SIZE = 200;

export function ViewTypeIcon({ type, size = 14 }: { type: string; size?: number }) {
  const props = { size, 'aria-hidden': true as const, className: 'shrink-0 opacity-70' };
  if (type === 'cards') return <LayoutGrid {...props} />;
  if (type === 'list') return <List {...props} />;
  if (type === 'kanban') return <SquareKanban {...props} />;
  if (type === 'map') return <MapIcon {...props} />;
  return <Table2 {...props} />;
}

/** One cell edit = that page's properties PUT (whole map, etag); refused when the value is read-only or changed meanwhile. */
export function useCellCommit(onDone: () => void) {
  const { t } = useTranslation('bases');
  return useCallback(
    async (row: BaseRow, column: BaseColumn, value: unknown) => {
      const key = column.key;
      if (!key) throw new Error(t('edit.notEditable'));
      const current = await api.getPageProperties(row.id);
      if (!current.canEdit) throw new Error(t('edit.noRights'));
      if (current.readOnly.includes(key)) throw new Error(t('edit.readOnlyKey', { key }));
      if (current.foreign.includes(key)) throw new Error(t('edit.foreign', { key }));
      if (!sameAsShown(current.properties[key], row.cells[column.id])) {
        onDone();
        throw new Error(t('edit.changedMeanwhile'));
      }
      const properties = { ...current.properties, [key]: value };
      try {
        await api.updatePageProperties(row.id, { properties, etag: current.etag ?? undefined });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          onDone();
          throw new Error(t('edit.conflict'));
        }
        throw err;
      }
      onDone();
    },
    [onDone, t],
  );
}

export interface BasePageViewProps {
  pageId: string;
  space: string;
  /** Editor+ on the base page itself: may change the base (views, filters…). */
  canEditBase: boolean;
}

export function BasePageView({ pageId, space, canEditBase }: BasePageViewProps) {
  const { t } = useTranslation('bases');
  const queryClient = useQueryClient();
  const [view, setView] = useState<string | undefined>(undefined);
  const [limit, setLimit] = useState(BASE_PAGE_SIZE);
  const [editing, setEditing] = useState(false);
  // Just created from the "New base" dialog: its Configure editor opens at once, so the filters can be set right away.
  const location = useLocation();
  const navigate = useNavigate();
  const justCreated = (location.state as { folioConfigureBase?: string } | null)?.folioConfigureBase === pageId;
  const [editorOpen, setEditorOpen] = useState<false | 'view' | 'yaml'>(justCreated && canEditBase ? 'view' : false);
  useEffect(() => {
    // One-shot: a reload or going back to this page must not reopen the editor.
    if (justCreated) navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [showWarnings, setShowWarnings] = useState(false);

  const query = useQuery({
    queryKey: ['base', pageId, view ?? null, limit],
    queryFn: () => api.getBase(pageId, { view, limit }),
    placeholderData: (prev) => prev,
  });
  const types = useQuery({ queryKey: ['property-types', space], queryFn: () => api.getSpacePropertyTypes(space), staleTime: 60_000 });
  const refresh = useCallback(() => void queryClient.invalidateQueries({ queryKey: ['base', pageId] }), [queryClient, pageId]);
  const commit = useCellCommit(refresh);
  const pageHref: PageHref = useCallback((id) => `/s/${space}/p/${id}`, [space]);

  const data: BaseQueryResponse | undefined = query.data;
  const anyEditable = useMemo(() => Boolean(data?.rows.some((r) => r.canEdit) && data.columns.some((c) => c.editable)), [data]);

  if (query.isLoading) return <div className="p-8 text-sm text-neutral-400">{t('loading')}</div>;
  if (query.isError || !data) {
    return <div className="p-8 text-sm text-red-600 dark:text-red-400">{t('loadFailed')}{query.error instanceof Error ? `: ${query.error.message}` : ''}</div>;
  }

  if (data.error) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 p-6">
        <div role="alert" className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-medium">{t('error.title')}</p>
            <p>{data.error.message}</p>
            {data.error.line && <p>{t('error.line', { line: data.error.line })}</p>}
            <p className="text-red-700/80 dark:text-red-300/80">{t('error.hint')}</p>
          </div>
        </div>
        {canEditBase && (
          <button type="button" onClick={() => setEditorOpen('yaml')} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800">
            {t('error.editYaml')}
          </button>
        )}
        {editorOpen && (
          <Suspense fallback={null}>
            <BaseEditor pageId={pageId} space={space} initialTab={editorOpen} viewName={undefined} onClose={() => setEditorOpen(false)} onSaved={refresh} />
          </Suspense>
        )}
      </div>
    );
  }

  const activeView = data.view;
  return (
    <div className="folio-base flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-700 md:px-6">
        <div role="tablist" aria-label={t('views')} className="flex min-w-0 flex-1 basis-full items-center gap-1 overflow-x-auto md:basis-0">
          {(data.views.length ? data.views : [{ name: t('defaultView'), type: 'table', supported: true }]).map((v) => {
            const active = data.views.length === 0 || v.name === activeView;
            return (
              <button
                key={v.name}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  if (data.views.length === 0) return;
                  setView(v.name);
                  setLimit(BASE_PAGE_SIZE);
                }}
                className={`inline-flex max-w-[14rem] shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm ${
                  active ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100' : 'text-neutral-600 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-800/60'
                }`}
                title={v.supported ? v.name : t('notSupportedType', { type: v.type })}
              >
                <ViewTypeIcon type={v.type} />
                <span className="truncate">{v.name}</span>
              </button>
            );
          })}
        </div>
        <span className="text-xs text-neutral-500 dark:text-neutral-400" aria-live="polite">
          {t('results', { count: data.total })}
        </span>
        {data.warnings.length > 0 && (
          <button
            type="button"
            onClick={() => setShowWarnings((v) => !v)}
            aria-expanded={showWarnings}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/40"
          >
            <AlertTriangle size={13} aria-hidden="true" />
            {t('warningsCount', { count: data.warnings.length })}
          </button>
        )}
        {anyEditable && (
          <div className="inline-flex overflow-hidden rounded-md border border-neutral-300 text-xs dark:border-neutral-600" role="group" aria-label={t('mode.label')}>
            <button type="button" aria-pressed={!editing} onClick={() => setEditing(false)} className={`inline-flex items-center gap-1 px-2 py-1 ${!editing ? 'bg-neutral-100 font-medium dark:bg-neutral-800' : ''}`}>
              <Eye size={13} aria-hidden="true" />
              {t('mode.view')}
            </button>
            <button type="button" aria-pressed={editing} onClick={() => setEditing(true)} className={`inline-flex items-center gap-1 border-l border-neutral-300 px-2 py-1 dark:border-neutral-600 ${editing ? 'bg-neutral-100 font-medium dark:bg-neutral-800' : ''}`}>
              <Pencil size={13} aria-hidden="true" />
              {t('mode.edit')}
            </button>
          </div>
        )}
        {canEditBase && (
          <button
            type="button"
            onClick={() => setEditorOpen('view')}
            className="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
          >
            <Settings2 size={13} aria-hidden="true" />
            {t('configure')}
          </button>
        )}
      </div>
      {(showWarnings || data.unsupportedType || data.truncated) && (
        <div className="space-y-1 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200 md:px-6">
          {data.unsupportedType && !showWarnings && <p>{t('notSupportedType', { type: data.unsupportedType })}</p>}
          {data.truncated && !showWarnings && <p>{t('truncated')}</p>}
          {showWarnings && (
            <ul className="list-disc space-y-0.5 pl-4">
              {data.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-3 py-3 md:px-6">
        <BaseResults
          response={data}
          space={space}
          pageHref={pageHref}
          editing={editing}
          types={types.data?.types}
          onCommit={commit}
        />
        {data.rows.length < data.total && (
          <div className="py-3 text-center">
            <button type="button" onClick={() => setLimit((l) => l + BASE_PAGE_SIZE)} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800">
              {t('loadMore', { shown: data.rows.length, total: data.total })}
            </button>
          </div>
        )}
      </div>
      {editorOpen && (
        <Suspense fallback={null}>
          <BaseEditor pageId={pageId} space={space} initialTab={editorOpen} viewName={activeView ?? undefined} onClose={() => setEditorOpen(false)} onSaved={(name) => {
            if (name !== undefined) setView(name);
            refresh();
          }} />
        </Suspense>
      )}
    </div>
  );
}
