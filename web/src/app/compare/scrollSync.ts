import { useEffect, type RefObject } from 'react';

/**
 * Proportional scroll sync between the columns of the compare view.
 *
 * What scrolls differs by column: a version column scrolls its body; a live page scrolls inside the editor
 * (`.folio-editor__reading` in reading mode, CodeMirror's `.cm-scroller` in live / source); a table or a board has
 * its own. So the scroller of a column is whichever of those has something to scroll right now (`scrollerOf`), and
 * the listener sits on the container in the capture phase — scroll events do not bubble, but they do pass the capture
 * phase of every ancestor.
 *
 * Feedback loop: setting a column's scrollTop fires that column's own scroll event, which would set the others back.
 * Every element WE move is remembered in `moved`; its next scroll event is ours and is swallowed once. A move that
 * changes nothing (already there, or clamped to the same place) fires no event, so it is never remembered.
 */
const SCROLLERS = '.folio-editor__reading, .cm-scroller, [data-compare-body]';

function canScroll(el: HTMLElement): boolean {
  return el.scrollHeight - el.clientHeight > 1;
}

/** The element of a column that scrolls the content now: the innermost candidate with overflow, else the body itself. */
export function scrollerOf(column: HTMLElement): HTMLElement {
  const candidates = Array.from(column.querySelectorAll<HTMLElement>(SCROLLERS));
  return candidates.reverse().find(canScroll) ?? candidates[candidates.length - 1] ?? column;
}

export function useScrollSync(containerRef: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;
    const moved = new WeakSet<HTMLElement>();

    function onScroll(event: Event) {
      const source = event.target;
      if (!(source instanceof HTMLElement) || !container) return;
      if (moved.has(source)) {
        moved.delete(source);
        return;
      }
      const column = source.closest<HTMLElement>('[data-compare-column]');
      if (!column || !source.matches(SCROLLERS)) return;
      const range = source.scrollHeight - source.clientHeight;
      const ratio = range > 0 ? source.scrollTop / range : 0;
      for (const other of Array.from(container.querySelectorAll<HTMLElement>('[data-compare-column]'))) {
        if (other === column) continue;
        const target = scrollerOf(other);
        const next = Math.round(ratio * Math.max(0, target.scrollHeight - target.clientHeight));
        if (Math.abs(target.scrollTop - next) < 1) continue;
        moved.add(target);
        target.scrollTop = next;
        // The browser may clamp the value to where it already is, which fires nothing: do not leave a stale mark.
        if (Math.abs(target.scrollTop - next) > 1) moved.delete(target);
      }
    }

    container.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => container.removeEventListener('scroll', onScroll, { capture: true });
  }, [containerRef, enabled]);
}
