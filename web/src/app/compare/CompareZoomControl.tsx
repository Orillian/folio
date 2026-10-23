import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Minus, Plus } from 'lucide-react';
import { DEFAULT_ZOOM, ZOOM_STEPS, stepZoom, zoomKeyAction } from './compareZoom';
import '../i18n/register';

export interface CompareZoomControlProps {
  zoom: number;
  onChange: (zoom: number) => void;
}

/**
 * The floating zoom control at the bottom centre of the compare view (the same chip as the compare tray): "−", the
 * current percentage (a click resets to 100%), "+". One value for every column.
 *
 * Ctrl/Cmd with "-", "=" / "+" or "0" does the same while the view is open; the browser's own page zoom is
 * suppressed for those keys, or the whole window — header and chrome included — would scale along with the columns.
 */
export function CompareZoomControl({ zoom, onChange }: CompareZoomControlProps) {
  const { t } = useTranslation('app');

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const action = zoomKeyAction(event.key);
      if (!action) return;
      event.preventDefault();
      onChange(action === 'reset' ? DEFAULT_ZOOM : stepZoom(zoom, action === 'in' ? 1 : -1));
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoom, onChange]);

  const button =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-neutral-700 hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent dark:text-neutral-200 dark:hover:bg-neutral-800';
  return (
    <div
      role="group"
      aria-label={t('compare.zoom.group')}
      data-report-exclude=""
      className="pointer-events-auto fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-neutral-200 bg-white p-1 text-sm font-medium text-neutral-800 shadow-lg dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <button type="button" onClick={() => onChange(stepZoom(zoom, -1))} disabled={zoom <= ZOOM_STEPS[0]} aria-label={t('compare.zoom.out')} title={t('compare.zoom.out')} className={button}>
        <Minus size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => onChange(DEFAULT_ZOOM)}
        aria-label={t('compare.zoom.reset')}
        title={t('compare.zoom.reset')}
        className={`${button} min-w-[3.25rem] text-xs tabular-nums`}
      >
        {zoom}%
      </button>
      <button type="button" onClick={() => onChange(stepZoom(zoom, 1))} disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} aria-label={t('compare.zoom.in')} title={t('compare.zoom.in')} className={button}>
        <Plus size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
