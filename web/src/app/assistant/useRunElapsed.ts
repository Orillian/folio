import { useEffect, useState } from 'react';
import type { AssistantRunStep } from '@shared/contracts';
import { STALE_AFTER_MS } from './runStream';

/**
 * Seconds since the last run event while the run is active and has been silent for STALE_AFTER_MS, else null.
 * Any new step or piece of reply text (the arguments change) restarts the clock. One timer pair exists only
 * while a run is active, and only the 1 s interval ticks once the gap is stale; both are cleared on every
 * change and on unmount.
 */
export function useRunElapsed(active: boolean, step: AssistantRunStep | null, streamText: string): number | null {
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    setElapsed(null);
    if (!active) return undefined;
    const lastEventAt = Date.now();
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      const tick = (): void => setElapsed(Math.floor((Date.now() - lastEventAt) / 1000));
      tick();
      interval = setInterval(tick, 1000);
    }, STALE_AFTER_MS);
    return () => {
      clearTimeout(timeout);
      if (interval !== undefined) clearInterval(interval);
    };
  }, [active, step, streamText]);

  return active ? elapsed : null;
}
