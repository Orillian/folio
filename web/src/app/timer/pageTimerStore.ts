import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { SPACE_TIMER_KEY_PREFIX, type PageTimerActionBody, type PageTimerResponse, type PageTimerState } from '@shared/contracts';
import { api } from '../api';
import { clockOffset } from './timerMath';

/**
 * The client half of the shared page timer (server/pageTimer.ts explains the
 * mechanism). The state of every timer this tab has looked at lives in the
 * react-query cache under `['page-timer', key]` — the same trick as the
 * notification feed — where `key` is the page id, or `space:<slug>` for a
 * folder listing:
 *
 *   - GET on mount (a latecomer reads the current state once) and again after
 *     the `/events` socket reopens or the window regains focus (the fallbacks
 *     for a silent socket);
 *   - the `{ type: 'timer' }` frame from NotificationsHost writes the new
 *     state straight into the cache (`applyTimerFrame`);
 *   - a click's own response is written too, so the person who clicked does
 *     not wait for the frame.
 *
 * Ordering: every response and frame carries a revision (`rev`) that only
 * grows on the server; the one with the smaller `rev` is dropped, so two quick
 * clicks fanned out in the wrong order cannot bring an old state back.
 *
 * `offsetMs` is the clock offset measured when the state arrived (see
 * timerMath.ts); with it every device counts down to the same real moment.
 */
export interface PageTimerCache {
  timer: PageTimerState | null;
  rev: number;
  canControl: boolean;
  offsetMs: number;
}

export interface TimerTarget {
  /** Absent: the timer of a folder listing (the space's own). */
  pageId?: string;
  space: string;
}

export const timerKeyOf = (target: TimerTarget): string => target.pageId ?? `${SPACE_TIMER_KEY_PREFIX}${target.space}`;
export const pageTimerQueryKey = (key: string) => ['page-timer', key] as const;

/** A response, with the clock offset measured against the local moment it was received (`receivedAt`; for a fetch, the middle of the round trip). */
export function cacheFromResponse(res: PageTimerResponse, receivedAt: number): PageTimerCache {
  return { timer: res.timer, rev: res.rev, canControl: res.canControl, offsetMs: clockOffset(res.serverNow, receivedAt) };
}

function newer(current: PageTimerCache | undefined, next: PageTimerCache): PageTimerCache {
  return current && current.rev > next.rev ? current : next;
}

/** A `{ type: 'timer' }` frame. Frames for a timer this tab never loaded are ignored: there is nobody to show it to, and the GET on arrival reads the truth. */
export function applyTimerFrame(queryClient: QueryClient, frame: { key: string; timer: PageTimerState | null; rev: number; serverNow: number }, receivedAt = Date.now()): void {
  if (typeof frame.key !== 'string' || typeof frame.rev !== 'number' || typeof frame.serverNow !== 'number') return;
  const queryKey = pageTimerQueryKey(frame.key);
  const current = queryClient.getQueryData<PageTimerCache>(queryKey);
  if (!current) return;
  queryClient.setQueryData<PageTimerCache>(queryKey, newer(current, { ...current, timer: frame.timer, rev: frame.rev, offsetMs: clockOffset(frame.serverNow, receivedAt) }));
}

/** The socket came back after a break: every loaded timer may have changed. */
export function refreshAllTimers(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['page-timer'] });
}

export function usePageTimer(target: TimerTarget | null) {
  const queryClient = useQueryClient();
  const key = target ? timerKeyOf(target) : null;
  const query = useQuery({
    queryKey: pageTimerQueryKey(key ?? ''),
    enabled: target !== null,
    queryFn: async (): Promise<PageTimerCache> => {
      const sentAt = Date.now();
      const res = await api.getPageTimer(target!);
      // The server stamped `serverNow` somewhere in the round trip: the middle is the best guess.
      const cached = cacheFromResponse(res, (sentAt + Date.now()) / 2);
      return newer(queryClient.getQueryData<PageTimerCache>(pageTimerQueryKey(key ?? '')), cached);
    },
    // A latecomer must read the state on every arrival, and again when the window wakes up (a sleeping laptop misses frames).
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    retry: false,
    // A cached copy of a page left a while ago must not be shown as current.
    gcTime: 60_000,
  });

  const act = useMutation({
    mutationFn: async (body: PageTimerActionBody): Promise<PageTimerCache> => {
      const sentAt = Date.now();
      const res = await api.postPageTimer(target!, body);
      return cacheFromResponse(res, (sentAt + Date.now()) / 2);
    },
    onSuccess: (next) => {
      if (key) queryClient.setQueryData<PageTimerCache>(pageTimerQueryKey(key), (current) => newer(current, next));
    },
  });

  return { key, data: query.data, act };
}
