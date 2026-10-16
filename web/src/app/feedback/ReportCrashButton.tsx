import { useTranslation } from 'react-i18next';
import { isSentryEnabled, lastSentryEventId } from '../../sentry';
import { requestReportProblem } from './reportProblem';
import '../i18n/register';

/**
 * "Report a problem" on an error screen: opens the dialog with the Sentry event of the crash the person is looking at
 * already attached. Draws nothing unless error reporting is switched on (SENTRY_DSN).
 */
export function ReportCrashButton({ eventId, className }: { eventId?: string; className?: string }) {
  const { t } = useTranslation('app');
  if (!isSentryEnabled()) return null;
  return (
    <button
      type="button"
      onClick={() => requestReportProblem({ eventId: eventId || lastSentryEventId() })}
      className={
        className ?? 'rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800'
      }
    >
      {t('feedback.reportCrash')}
    </button>
  );
}
