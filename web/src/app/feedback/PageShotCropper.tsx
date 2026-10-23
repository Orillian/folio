import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { cropCanvas, cropSourceRect, REPORT_EXCLUDE_ATTR } from './pageShot';
import type { Rect } from './pageShot';
import '../i18n/register';

export interface PageShotCropperProps {
  /** The captured viewport. */
  canvas: HTMLCanvasElement;
  /** The image to attach (the whole capture or the selected part), or null when the person cancelled. */
  onDone: (result: HTMLCanvasElement | null) => void;
}

/**
 * The captured page shown full screen, exactly where the live page was, so a rectangle can be dragged over the part to
 * keep. "Whole page" keeps everything; Escape or Cancel keeps nothing.
 */
export function PageShotCropper({ canvas, onDone }: PageShotCropperProps) {
  const { t } = useTranslation('app');
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<Rect | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const slot = host.current;
    if (!slot) return;
    canvas.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none';
    slot.appendChild(canvas);
    return () => {
      canvas.remove();
    };
  }, [canvas]);

  function sourceRect(): Rect | null {
    const box = root.current?.getBoundingClientRect();
    if (!box || !selection) return null;
    return cropSourceRect(selection, { width: box.width, height: box.height }, canvas);
  }

  const valid = sourceRect() !== null;

  function keepSelection() {
    const rect = sourceRect();
    if (rect) onDone(cropCanvas(canvas, rect));
  }

  useEffect(() => {
    root.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDone(null);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDone]);

  function point(event: PointerEvent): { x: number; y: number } {
    const box = root.current!.getBoundingClientRect();
    return {
      x: Math.min(box.width, Math.max(0, event.clientX - box.left)),
      y: Math.min(box.height, Math.max(0, event.clientY - box.top)),
    };
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    start.current = point(event);
    setSelection({ ...start.current, width: 0, height: 0 });
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const from = start.current;
    if (!from) return;
    const to = point(event);
    setSelection({ x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y });
  }

  function onPointerUp() {
    start.current = null;
  }

  const shown = selection && {
    left: Math.min(selection.x, selection.x + selection.width),
    top: Math.min(selection.y, selection.y + selection.height),
    width: Math.abs(selection.width),
    height: Math.abs(selection.height),
  };

  const rootProps = { [REPORT_EXCLUDE_ATTR]: '' };
  return (
    <div
      {...rootProps}
      ref={root}
      role="dialog"
      aria-label={t('feedback.cropTitle')}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && valid) {
          e.preventDefault();
          keepSelection();
        }
      }}
      className="ph-no-capture fixed inset-0 z-[300] cursor-crosshair touch-none select-none overflow-hidden outline-none"
      data-testid="feedback-cropper"
    >
      <div ref={host} className="absolute inset-0" />
      {shown && shown.width > 0 && shown.height > 0 ? (
        <div
          className="pointer-events-none absolute border-2 border-white"
          style={{ left: shown.left, top: shown.top, width: shown.width, height: shown.height, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.6)' }}
        />
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-black/30" />
      )}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-3 flex max-w-[calc(100vw-1rem)] -translate-x-1/2 cursor-default flex-wrap items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-800 shadow-xl dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <span>{t('feedback.cropHint')}</span>
        <button type="button" disabled={!valid} onClick={keepSelection} className="rounded-md bg-neutral-900 px-2.5 py-1 font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900">
          {t('feedback.cropUse')}
        </button>
        <button type="button" onClick={() => onDone(canvas)} className="rounded-md border border-neutral-300 px-2.5 py-1 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">
          {t('feedback.cropWhole')}
        </button>
        <button type="button" onClick={() => onDone(null)} className="rounded-md px-2.5 py-1 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
          {t('ui.cancel')}
        </button>
      </div>
    </div>
  );
}
