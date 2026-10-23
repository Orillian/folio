import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import type { AccessMatrixResponse } from '@shared/contracts';
import { api } from '../../api';
import { CreateGroupDialog } from './CreateGroupDialog';
import { GroupPanel } from './GroupPanel';
import { matchesGroupQuery } from './groupsLogic';
import '../../i18n/register';

export interface GroupsTabProps {
  matrix: AccessMatrixResponse;
}

/** Groups tab (053, docs/spec-access.md section 15) — list, create, and an expandable per-group panel. Instance-admin page, so every group (archived too) is listed. */
export function GroupsTab({ matrix }: GroupsTabProps) {
  const { t } = useTranslation('app');
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const groups = useQuery({ queryKey: ['groups'], queryFn: api.listGroups });
  const filtered = (groups.data?.groups ?? []).filter((g) => matchesGroupQuery(g, query));

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('access.groups.searchPlaceholder')}
          aria-label={t('access.groups.searchPlaceholder')}
          className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm text-neutral-800 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:text-neutral-200"
        />
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
        >
          <Plus size={14} /> {t('access.groups.create')}
        </button>
      </div>

      {groups.isLoading && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}
      {groups.isError && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {t('access.groups.loadFailed')}{' '}
          <button type="button" onClick={() => groups.refetch()} className="underline underline-offset-2">
            {t('auth.retry')}
          </button>
        </p>
      )}
      {groups.data && filtered.length === 0 && (
        <p className="text-sm text-neutral-400">{groups.data.groups.length === 0 ? t('access.groups.emptyAll') : t('access.groups.empty')}</p>
      )}

      {filtered.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <div className="min-w-[560px]">
            <div className="sticky top-0 z-10 grid grid-cols-[minmax(240px,1.6fr)_minmax(120px,1fr)_6rem_7rem] gap-3 border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
              <span>{t('access.groups.group')}</span>
              <span>{t('access.groups.slug')}</span>
              <span>{t('access.groups.members')}</span>
              <span>{t('access.people.status')}</span>
            </div>
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {filtered.map((g) => {
                const expanded = expandedId === g.id;
                const archived = g.archivedAt !== null;
                return (
                  <li key={g.id} className={archived ? 'bg-neutral-50/80 dark:bg-neutral-900/50' : undefined}>
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : g.id)}
                      aria-expanded={expanded}
                      aria-label={t('access.groups.toggleNamed', { name: g.name })}
                      className="grid w-full grid-cols-[minmax(240px,1.6fr)_minmax(120px,1fr)_6rem_7rem] items-center gap-3 px-3 py-2 text-left"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 text-neutral-400">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                            {g.name}
                            {g.source !== 'local' && (
                              <span
                                data-testid="group-source-badge"
                                className="ml-1.5 rounded-full bg-blue-50 px-1.5 py-0.5 align-middle text-[10px] font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                              >
                                {t(`access.groups.source.${g.source}`, { defaultValue: g.source })}
                              </span>
                            )}
                          </span>
                          {g.description && <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">{g.description}</span>}
                        </span>
                      </span>
                      <span className="truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">{g.slug}</span>
                      <span className="text-sm text-neutral-700 dark:text-neutral-300">{g.memberCount}</span>
                      <span
                        className={`w-fit rounded-full px-2 py-0.5 text-xs ${archived ? 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300' : 'bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300'}`}
                      >
                        {archived ? t('access.groups.archived') : t('access.people.active')}
                      </span>
                    </button>
                    {expanded && <GroupPanel groupId={g.id} users={matrix.users} onDeleted={() => setExpandedId(null)} />}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {creating && (
        <CreateGroupDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setExpandedId(id);
          }}
        />
      )}
    </div>
  );
}
