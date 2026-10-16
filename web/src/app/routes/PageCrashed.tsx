import { useTranslation } from 'react-i18next';
import { ReportCrashButton } from '../feedback/ReportCrashButton';
import { REPLAY_UNMASK_CLASS } from '../../sentry';
import { isStaleChunkError } from '../stale-chunk';
import '../i18n/register';

/** What the main area shows when the routed page threw while rendering — the sidebar and the header stay usable around it. */
export function PageCrashed({ onRetry, eventId, error }: { onRetry: () => void; eventId?: string; error?: unknown }) {
  const { t } = useTranslation('app');
  // A chunk of the app that cannot be fetched stays failed for the life of the document (the browser remembers the
  // failed import), so "Retry" for it can only be a reload. Reaching this screen means the automatic reload already
  // happened (or is not allowed: offline), so say what it is instead of a generic crash.
  const chunk = isStaleChunkError(error);
  return (
    <div className={`flex flex-col items-start gap-3 p-8 text-sm text-neutral-600 dark:text-neutral-300 ${REPLAY_UNMASK_CLASS}`}>
      <p>{t(chunk ? 'routes.page.chunkFailed' : 'routes.page.crashed')}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={chunk ? () => window.location.reload() : onRetry}
          className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
        >
          {t('auth.retry')}
        </button>
        <ReportCrashButton eventId={eventId} />
      </div>
    </div>
  );
}
