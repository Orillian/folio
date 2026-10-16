import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { Waypoints } from 'lucide-react';
import '../i18n/register';

/** Graph view (16.10.2026): the sidebar row under Tags that opens the space's graph. */
export function GraphLink({ space, onNavigate }: { space: string; onNavigate?: () => void }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const location = useLocation();
  const href = `/s/${encodeURIComponent(space)}/graph`;
  const active = location.pathname === href || location.pathname === `/s/${space}/graph`;
  return (
    <button
      type="button"
      onClick={() => {
        navigate(href);
        onNavigate?.();
      }}
      aria-current={active ? 'page' : undefined}
      // Like `.agent`: the bare word tells a newcomer little (owner, 16.10) — the hover hint says what the graph is.
      title={t('sidebar.graphHint')}
      aria-label={`${t('graph.title')} — ${t('sidebar.graphHint')}`}
      className={`mt-0.5 flex w-full items-center gap-1.5 rounded-md px-1 py-1.5 text-left text-sm ${
        active
          ? 'bg-neutral-200/70 font-medium text-neutral-900 dark:bg-neutral-700/60 dark:text-neutral-50'
          : 'text-neutral-600 hover:bg-neutral-200/70 dark:text-neutral-300 dark:hover:bg-neutral-800'
      }`}
    >
      <span className="w-[13px] shrink-0" aria-hidden="true" />
      <Waypoints size={14} className="shrink-0 opacity-70" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-medium">{t('graph.title')}</span>
    </button>
  );
}
