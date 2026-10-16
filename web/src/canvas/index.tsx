/**
 * Public surface of the canvas module (Obsidian `.canvas`, JSON Canvas 1.0):
 * CanvasPane is the light shell every surface mounts — the page route, the
 * share link, the public site. It shows the error page for a file that is not
 * a readable canvas, the "skipped while reading" note, and lazy-loads the
 * renderer itself (CanvasView.tsx) only when there is something to draw.
 */
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';
import type { CanvasViewProps } from './CanvasView';
import './i18n/register';

export type { CanvasViewProps } from './CanvasView';
export { spaceFileUrl } from './renderModel';

const loadCanvasView = () => import('./CanvasView');
const LazyCanvasView = lazy(loadCanvasView);

export function CanvasPane(props: CanvasViewProps) {
  const { t } = useTranslation('canvas');
  const { payload } = props;
  const [showWarnings, setShowWarnings] = useState(false);
  if (!payload.document) {
    return (
      <div className="flex h-full items-start justify-center p-8">
        <div role="alert" className="max-w-lg rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
          <div className="mb-1 flex items-center gap-2 font-semibold">
            <TriangleAlert size={16} aria-hidden="true" />
            {t('errorTitle')}
          </div>
          {payload.error && <p className="mb-2 font-mono text-xs break-words">{payload.error}</p>}
          <p>{t('errorHint')}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="relative h-full w-full">
      <Suspense fallback={<div className="p-8 text-sm text-neutral-400">{t('loading')}</div>}>
        <LazyCanvasView {...props} />
      </Suspense>
      {payload.warnings.length > 0 && (
        <div className="absolute top-2 left-2 z-10 max-w-[min(28rem,calc(100%-1rem))] rounded-md border border-amber-300 bg-amber-50/95 px-3 py-1.5 text-xs text-amber-900 shadow-sm dark:border-amber-700 dark:bg-amber-950/90 dark:text-amber-100">
          <button type="button" className="flex items-center gap-1.5 font-medium" onClick={() => setShowWarnings((v) => !v)} aria-expanded={showWarnings}>
            <TriangleAlert size={13} aria-hidden="true" />
            {t('warningsTitle', { count: payload.warnings.length })}
          </button>
          {showWarnings && (
            <ul className="mt-1 list-disc pl-5">
              {payload.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Warms the renderer's chunk (e.g. when a canvas row is hovered). */
export function preloadCanvasView(): void {
  void loadCanvasView();
}
