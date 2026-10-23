import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchLatestBundleId, isStaleBuild, loadedBundleId } from '../build-version';
import { getConnectivity } from '../offline/connectivity';
import '../i18n/register';

/** How often a visible tab asks the server which build it has. */
const CHECK_EVERY_MS = 10 * 60_000;
/** Never twice within this, however many focus events arrive. */
const MIN_GAP_MS = 60_000;

/**
 * Watches for a deploy that happened under an open tab. Checks when the tab becomes visible again, when the
 * connection returns and every few minutes while it is open; once the server's build differs from the one running,
 * stops checking and offers a reload. Draws nothing until then (and never in development, where there is no build).
 */
export function useStaleBuild(): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const loaded = loadedBundleId();
    if (!loaded) return;
    let last = 0;
    let done = false;
    const check = async (): Promise<void> => {
      if (done || document.visibilityState === 'hidden' || navigator.onLine === false || getConnectivity() === 'offline') return;
      const now = Date.now();
      if (now - last < MIN_GAP_MS) return;
      last = now;
      const latest = await fetchLatestBundleId();
      if (done || !isStaleBuild(loaded, latest)) return;
      done = true;
      setStale(true);
    };
    const onVisible = (): void => void check();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS);
    return () => {
      done = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      window.clearInterval(timer);
    };
  }, []);
  return stale;
}

/** "A new version is available — reload": a small banner in the corner, shown once the open tab is behind the server. */
export function NewVersionNotice() {
  const { t } = useTranslation('app');
  const stale = useStaleBuild();
  const [dismissed, setDismissed] = useState(false);
  if (!stale || dismissed) return null;
  return (
    <div
      role="status"
      data-report-exclude=""
      className="fixed bottom-4 left-4 z-[100] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 shadow-lg dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <span>{t('newVersion.message')}</span>
      <button type="button" onClick={() => window.location.reload()} className="font-medium text-blue-600 underline underline-offset-2 dark:text-blue-400">
        {t('newVersion.reload')}
      </button>
      <button type="button" onClick={() => setDismissed(true)} aria-label={t('newVersion.dismiss')} className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200">
        ×
      </button>
    </div>
  );
}
