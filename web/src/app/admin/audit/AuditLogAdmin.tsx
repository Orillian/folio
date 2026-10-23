import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Download } from 'lucide-react';
import type { AuditLogEvent } from '@shared/contracts';
import { api, ApiError } from '../../api';
import { formatDateTime } from '../../formatDate';
import { useDocumentTitle } from '../../hooks';
import {
  ACTION_FAMILIES,
  AUDIT_PAGE_SIZE,
  EMPTY_AUDIT_FILTERS,
  actionLabelKey,
  displayAction,
  filtersFromSearch,
  filtersToQuery,
  hasActiveFilters,
  metaParts,
  type AuditFilters,
} from './logic';
import '../../i18n/register';

const CONTROL_CLASS =
  'rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200';
const LABEL_CLASS = 'flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400';
const BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800';

/**
 * `/admin/audit` — instance admin: the audit log of the whole instance (who did what, to what, when).
 * Filters (actor, action prefix, target, date range) are applied with the Apply button and kept in
 * the address bar; pages load by keyset ("Load more"); the same filter exports as CSV. Actions with
 * no label of their own (a newer server, a plugin) show their action string and meta as they are.
 * The space-level "Access changes" feed in the space's access dialog stays where it was.
 */
export function AuditLogAdmin() {
  const { t } = useTranslation('app');
  useDocumentTitle(t('audit.title'));
  const [search, setSearch] = useSearchParams();
  const applied = filtersFromSearch(search);
  const [draft, setDraft] = useState<AuditFilters>(applied);
  const query = filtersToQuery(applied);

  const users = useQuery({ queryKey: ['users'], queryFn: api.listUsers, retry: false });
  const events = useInfiniteQuery({
    queryKey: ['admin', 'audit', applied],
    queryFn: ({ pageParam }) => api.listAuditEvents({ ...query, cursor: pageParam, limit: AUDIT_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const rows = events.data?.pages.flatMap((p) => p.events) ?? [];
  const forbidden = events.error instanceof ApiError && events.error.status === 403;

  function apply(next: AuditFilters): void {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) if (value.trim()) params.set(key, value.trim());
    setSearch(params, { replace: true });
  }

  return (
    <div className="h-full overflow-y-auto bg-white dark:bg-neutral-950">
      <header className="flex h-14 items-center gap-2 border-b border-neutral-200 px-3 dark:border-neutral-800 md:gap-3 md:px-4">
        <Link
          to="/"
          aria-label={t('ui.back')}
          className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 max-md:min-h-10 max-md:min-w-10 dark:hover:bg-neutral-800"
        >
          <ArrowLeft size={17} />
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('audit.title')}</h1>
        {!forbidden && (
          <a href={api.auditExportUrl(query)} download className={BUTTON_CLASS}>
            <Download size={14} aria-hidden="true" /> {t('audit.exportCsv')}
          </a>
        )}
      </header>
      <main className="mx-auto max-w-6xl p-4 md:p-6">
        {forbidden ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('admin.noAccess')}</p>
        ) : (
          <>
            <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">{t('audit.intro')}</p>
            <form
              className="mb-4 flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                apply(draft);
              }}
            >
              <label className={LABEL_CLASS}>
                {t('audit.filters.actor')}
                <select value={draft.actor} onChange={(e) => setDraft({ ...draft, actor: e.target.value })} className={`${CONTROL_CLASS} max-w-56`}>
                  <option value="">{t('audit.filters.anyone')}</option>
                  {(users.data?.users ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.email})
                    </option>
                  ))}
                </select>
              </label>
              <label className={LABEL_CLASS}>
                {t('audit.filters.action')}
                <input
                  list="audit-action-families"
                  value={draft.action}
                  onChange={(e) => setDraft({ ...draft, action: e.target.value })}
                  placeholder="access."
                  maxLength={80}
                  className={`${CONTROL_CLASS} w-40`}
                />
                <datalist id="audit-action-families">
                  {ACTION_FAMILIES.map((family) => (
                    <option key={family} value={family} />
                  ))}
                </datalist>
              </label>
              <label className={LABEL_CLASS}>
                {t('audit.filters.target')}
                <input
                  value={draft.target}
                  onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                  placeholder={t('audit.filters.targetPlaceholder')}
                  maxLength={200}
                  className={`${CONTROL_CLASS} w-48`}
                />
              </label>
              <label className={LABEL_CLASS}>
                {t('audit.filters.from')}
                <input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} className={CONTROL_CLASS} />
              </label>
              <label className={LABEL_CLASS}>
                {t('audit.filters.to')}
                <input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} className={CONTROL_CLASS} />
              </label>
              <button type="submit" className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-white dark:text-neutral-900">
                {t('audit.filters.apply')}
              </button>
              {(hasActiveFilters(applied) || hasActiveFilters(draft)) && (
                <button
                  type="button"
                  className={BUTTON_CLASS}
                  onClick={() => {
                    setDraft(EMPTY_AUDIT_FILTERS);
                    apply(EMPTY_AUDIT_FILTERS);
                  }}
                >
                  {t('audit.filters.reset')}
                </button>
              )}
            </form>

            {events.isPending && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}
            {events.isError && <p className="text-sm text-red-600 dark:text-red-400">{t('audit.loadFailed')}</p>}
            {events.isSuccess && rows.length === 0 && <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('audit.empty')}</p>}

            {rows.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
                <table className="w-full min-w-[860px] text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
                      <th className="px-3 py-2 font-medium">{t('audit.columns.time')}</th>
                      <th className="px-3 py-2 font-medium">{t('audit.columns.actor')}</th>
                      <th className="px-3 py-2 font-medium">{t('audit.columns.action')}</th>
                      <th className="px-3 py-2 font-medium">{t('audit.columns.target')}</th>
                      <th className="px-3 py-2 font-medium">{t('audit.columns.details')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((event) => (
                      <AuditRow key={event.id} event={event} onFilter={(patch) => apply({ ...applied, ...patch })} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {events.hasNextPage && (
              <div className="mt-3">
                <button type="button" disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()} className={BUTTON_CLASS}>
                  {events.isFetchingNextPage ? t('ui.loading') : t('audit.loadMore')}
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function AuditRow({ event, onFilter }: { event: AuditLogEvent; onFilter: (patch: Partial<AuditFilters>) => void }) {
  const { t, i18n } = useTranslation('app');
  const label = t(actionLabelKey(displayAction(event.action, event.meta)), { defaultValue: '' });
  const parts = metaParts(event.meta);
  return (
    <tr className="border-b border-neutral-100 align-top last:border-0 dark:border-neutral-900">
      <td className="whitespace-nowrap px-3 py-2 text-neutral-600 dark:text-neutral-300">{formatDateTime(event.at, i18n.language)}</td>
      <td className="max-w-52 px-3 py-2">
        {event.actorId ? (
          <button type="button" onClick={() => onFilter({ actor: event.actorId! })} title={t('audit.filterByActor')} className="block max-w-full text-left hover:underline">
            <span className="block truncate font-medium text-neutral-800 dark:text-neutral-200">{event.actorName ?? t('audit.deletedUser')}</span>
            {event.actorEmail && <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">{event.actorEmail}</span>}
          </button>
        ) : (
          <span className="text-neutral-400 dark:text-neutral-500">{t('audit.noActor')}</span>
        )}
      </td>
      <td className="px-3 py-2">
        <button type="button" onClick={() => onFilter({ action: event.action })} title={t('audit.filterByAction')} className="text-left hover:underline">
          <span className="block text-neutral-900 dark:text-neutral-100">{label || event.action}</span>
          {label && <code className="block text-xs text-neutral-500 dark:text-neutral-400">{event.action}</code>}
        </button>
      </td>
      <td className="max-w-48 px-3 py-2">
        {event.target ? (
          <button type="button" onClick={() => onFilter({ target: event.target! })} title={t('audit.filterByTarget')} className="block max-w-full text-left hover:underline">
            {event.targetName ? (
              <>
                <span className="block truncate text-xs text-neutral-900 dark:text-neutral-100">{event.targetName}</span>
                <span className="block truncate font-mono text-[11px] text-neutral-500 dark:text-neutral-400">{event.target}</span>
              </>
            ) : (
              <span className="block truncate font-mono text-xs">{event.target}</span>
            )}
          </button>
        ) : (
          <span className="text-neutral-400 dark:text-neutral-500">—</span>
        )}
      </td>
      <td className="px-3 py-2">
        {parts.length === 0 ? (
          <span className="text-neutral-400 dark:text-neutral-500">—</span>
        ) : (
          <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            {parts.map(({ key, value }) => (
              <div key={key} className="flex gap-1">
                <dt className="text-neutral-500 dark:text-neutral-400">{key}</dt>
                <dd className="break-all text-neutral-800 dark:text-neutral-200">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </td>
    </tr>
  );
}
