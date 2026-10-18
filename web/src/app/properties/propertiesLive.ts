import type { QueryClient } from '@tanstack/react-query';
import type { PagePropertiesPayload } from '../api';

/**
 * The client half of the live "the properties of this page changed" signal
 * (server/propertiesSignal.ts explains the whole mechanism). The server sends
 * `{ type: 'page-properties', space, pageId, etag }` over the `/events` socket
 * NotificationsHost keeps open — only to sessions that may read that page — or
 * `{ type: 'page-properties', space }` when many pages of a space changed at
 * once. This file turns it into refetches:
 *
 *  - the page's properties (`['page-properties', id]`, usePageProperties) and
 *    its chrome (`['page', id]`: title from `title:`, icon, cover) — only when
 *    this tab has them cached, and not when the cached `etag` already is the
 *    frame's (the tab that made the change holds the PUT's answer);
 *  - every base view of the space (`['base', id, view, limit, space]`): a base
 *    lists properties of many pages, so a change to any page may show in it.
 *    Coalesced: one refetch per space per BASE_REFRESH_DELAY_MS.
 *
 * NEVER UNDER THE USER'S HANDS. A refetch replaces the server half of the
 * panel's state; what the user is doing is not part of it:
 *  - a save of this page in flight (usePageProperties marks it, markSaving):
 *    the refetch waits until the save is done — a GET that started before
 *    the PUT landed must not overwrite its answer;
 *  - a field being typed into keeps its text (PropertyRow useFieldCommit): the
 *    other rows update, the edited one shows "someone else changed this" and
 *    Enter keeps the user's value, Esc takes theirs. The next save sends the
 *    whole fresh map plus the user's key, so non-conflicting keys merge —
 *    nobody's change to another key is lost.
 *
 * Invalidation (not "put the data in the cache") for the same reasons as the
 * tree (sidebar/treeLive.ts): the frame carries no values, the refetch goes
 * through the access-checked GET, and only queries on screen refetch.
 */

export const BASE_REFRESH_DELAY_MS = 300;

/** Page ids with a properties save in flight in this tab (a count: two panels of one page may save at once). */
const saving = new Map<string, number>();
/** Frames that arrived during a save: refetched when the last save of that page ends. */
const deferred = new Set<string>();
const baseWaits = new Map<QueryClient, Map<string, ReturnType<typeof setTimeout>>>();
/** The query client of the last frame, for a deferred refetch (one client per tab). */
let lastClient: QueryClient | null = null;

const propertiesKey = (pageId: string) => ['page-properties', pageId] as const;

function refreshPage(queryClient: QueryClient, pageId: string): void {
  void queryClient.invalidateQueries({ queryKey: propertiesKey(pageId) });
  void queryClient.invalidateQueries({ queryKey: ['page', pageId] });
}

/** usePageProperties: a save of `pageId` started (true) or ended (false). */
export function markSaving(pageId: string, isSaving: boolean): void {
  const n = (saving.get(pageId) ?? 0) + (isSaving ? 1 : -1);
  if (n > 0) {
    saving.set(pageId, n);
    return;
  }
  saving.delete(pageId);
  if (deferred.delete(pageId) && lastClient) refreshPage(lastClient, pageId);
}

function requestBaseRefresh(queryClient: QueryClient, space: string): void {
  let waits = baseWaits.get(queryClient);
  if (!waits) {
    waits = new Map();
    baseWaits.set(queryClient, waits);
  }
  const pending = waits;
  if (pending.has(space)) return;
  pending.set(
    space,
    setTimeout(() => {
      pending.delete(space);
      if (pending.size === 0) baseWaits.delete(queryClient);
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'base' && query.queryKey[4] === space });
    }, BASE_REFRESH_DELAY_MS),
  );
}

export interface PagePropertiesFrame {
  type: 'page-properties';
  space: string;
  pageId?: string;
  etag?: string | null;
}

/** One `page-properties` frame from the `/events` socket. A malformed one (a newer server) is ignored. */
export function applyPagePropertiesFrame(queryClient: QueryClient, event: PagePropertiesFrame): void {
  if (typeof event.space !== 'string' || !event.space) return;
  lastClient = queryClient;
  requestBaseRefresh(queryClient, event.space);
  if (typeof event.pageId === 'string' && event.pageId) {
    const pageId = event.pageId;
    const cached = queryClient.getQueryData<PagePropertiesPayload>(propertiesKey(pageId));
    // Not open here (never loaded): the GET on opening reads the truth.
    if (!cached) return;
    if (event.etag !== undefined && cached.etag === event.etag) return;
    if (saving.has(pageId)) deferred.add(pageId);
    else refreshPage(queryClient, pageId);
    return;
  }
  // Many pages of the space: every properties panel on screen re-reads (the key carries no space; only active queries refetch).
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ['page-properties'] })) {
    const pageId = query.queryKey[1];
    if (typeof pageId !== 'string') continue;
    if (saving.has(pageId)) deferred.add(pageId);
    else void queryClient.invalidateQueries({ queryKey: propertiesKey(pageId) });
  }
}

/** The socket came back after a break: whatever is open may have changed meanwhile. */
export function refreshAllPageProperties(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['page-properties'] });
  void queryClient.invalidateQueries({ queryKey: ['base'] });
}

/** Forget the base refreshes that have not fired yet — the host unmounting. */
export function cancelPendingBaseRefreshes(): void {
  for (const waits of baseWaits.values()) for (const timer of waits.values()) clearTimeout(timer);
  baseWaits.clear();
}

/** Everything back to the start — tests. */
export function resetPropertiesLive(): void {
  cancelPendingBaseRefreshes();
  saving.clear();
  deferred.clear();
  lastClient = null;
}
