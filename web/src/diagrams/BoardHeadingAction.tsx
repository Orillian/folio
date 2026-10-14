import { useEffect, useReducer, useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { Heading } from 'lucide-react';
import { elementSceneBounds, sceneToContainerPoint } from './reactionsModel';
import { applyMakeHeading, headingTarget } from './boardHeading';
import './i18n/register';

/**
 * The button centre sits this far right of, and below, the bottom-right corner of the
 * selected text: one slot further right than the reaction button (BoardReactions.tsx),
 * which owns the slot straight outside the corner and the popup under it.
 */
const BUTTON_OFFSET_X_PX = 54;
const BUTTON_OFFSET_Y_PX = 26;
/** Excalidraw's selection colour, so the button reads as part of the selected shape's frame. */
const SELECTION_COLOR = '#6965db';

export interface BoardHeadingActionProps {
  api: ExcalidrawImperativeAPI | null;
  containerRef: RefObject<HTMLElement | null>;
  /** May this tab edit the scene right now (write permission AND the Edit mode)? Otherwise no button. */
  canEdit: boolean;
}

/**
 * "Make heading" button next to a selected free text block that has a first line and a body
 * (see `headingTarget`): splits the first line into a larger, grouped heading element.
 * An HTML layer over the canvas like the reaction button, re-positioned (one render per
 * frame) on every Excalidraw change so it follows pan, zoom and moves.
 */
export function BoardHeadingAction({ api, containerRef, canEdit }: BoardHeadingActionProps) {
  const { t } = useTranslation('diagrams');
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!api || typeof api.onChange !== 'function') return;
    const schedule = () => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        rerender();
      });
    };
    const unsubscribe = api.onChange(schedule);
    schedule();
    return () => {
      unsubscribe();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [api]);

  if (!canEdit || !api || typeof api.onChange !== 'function' || typeof api.getAppState !== 'function') return null;
  const container = containerRef.current;
  if (!container) return null;

  const appState = api.getAppState();
  const target = headingTarget(api.getSceneElements(), appState);
  if (!target) return null;

  const bounds = elementSceneBounds(target);
  const corner = sceneToContainerPoint({ x: bounds.right, y: bounds.bottom }, appState, container.getBoundingClientRect());
  if (corner.x < -200 || corner.y < -100 || corner.x > appState.width + 200 || corner.y > appState.height + 100) return null;

  const label = t('board.heading.make');
  return (
    <div className="pointer-events-none absolute inset-0 z-[3] overflow-hidden" data-board-heading-layer>
      <button
        type="button"
        data-board-heading-action
        aria-label={label}
        title={label}
        onClick={() => applyMakeHeading(api, target.id)}
        className="pointer-events-auto absolute flex h-[22px] w-[22px] items-center justify-center rounded-full border bg-white text-neutral-600 shadow-sm hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
        style={{
          left: corner.x + BUTTON_OFFSET_X_PX - 11,
          top: corner.y + BUTTON_OFFSET_Y_PX - 11,
          borderColor: SELECTION_COLOR,
        }}
      >
        <Heading size={14} />
      </button>
    </div>
  );
}
