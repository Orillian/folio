import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type { PagePropertiesPayload } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import { markSaving } from './propertiesLive';
import { editableProperties, toDisplayProperties, toWireProperties } from './propertyValues';
import type { Properties } from './propertyValues';
import '../i18n/register';

export const pagePropertiesKey = (pageId: string) => ['page-properties', pageId] as const;

/** A PUT answer shaped like the GET (the server may reply with the new state or with nothing at all). */
function isPayload(value: unknown): value is PagePropertiesPayload {
  return typeof value === 'object' && value !== null && typeof (value as { properties?: unknown }).properties === 'object';
}

export interface PagePropertiesState {
  /** The server's answer, or undefined while loading / when the page has none (an older server: no route). */
  data: PagePropertiesPayload | undefined;
  isLoading: boolean;
  /** What the panel shows: the server's front matter with the user's not-yet-confirmed edits on top. */
  properties: Properties;
  /** A save is on its way. */
  saving: boolean;
  /** The server refused the last save because the front matter changed since it was read (409). Editing stops until reload(). */
  conflict: boolean;
  /**
   * Saves the whole editable map in one PUT — optimistic: the new map is on screen at once and
   * stays there until the server answers. Saves made while one is in flight are coalesced into
   * the next PUT (the last map wins). Resolves true once the map is stored, false when it was not.
   */
  commit: (next: Properties) => Promise<boolean>;
  /** Drops the unsaved edits and reads the front matter again (the way out of a conflict). */
  reload: () => Promise<void>;
}

/**
 * Front matter of one page: GET /api/pages/:id/properties and its optimistic PUT.
 *
 * The panel hands over the complete map each time (a key missing from it is removed on the
 * server), so there is no per-key patching and no dirty state to merge. `etag`, when the
 * server sends one, is sent back with every PUT and refreshed from each answer; a 409 means
 * someone else changed the file in between and ends in a "reload" prompt, never in a silent
 * overwrite.
 *
 * Live (16.10.2026): another user's change arrives as a socket frame (propertiesLive.ts) and
 * refetches this query — after a save in flight here, never during it. The panel then shows the
 * fresh map; the row being typed into keeps its text (PropertyRow).
 */
export function usePageProperties(pageId: string, space: string, enabled = true): PagePropertiesState {
  const queryClient = useQueryClient();
  const showToast = useToast();
  const errorText = useApiErrorText();

  const query = useQuery({
    queryKey: pagePropertiesKey(pageId),
    queryFn: () => api.getPageProperties(pageId),
    enabled,
    // A server without the route (404) or a page the caller cannot read (403) is not worth retrying: the panel just stays away.
    retry: false,
    refetchOnWindowFocus: true,
  });

  const [optimistic, setOptimistic] = useState<Properties | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const serverRef = useRef<PagePropertiesPayload | undefined>(undefined);
  serverRef.current = query.data;
  const inFlight = useRef(false);
  const queued = useRef<Properties | null>(null);
  const waiters = useRef<((ok: boolean) => void)[]>([]);
  const conflictRef = useRef(false);
  // The page changed under a mounted hook (same component, other page): nothing of the old one may leak in.
  const pageRef = useRef(pageId);

  useEffect(() => {
    pageRef.current = pageId;
    setOptimistic(null);
    setSaving(false);
    setConflict(false);
    conflictRef.current = false;
    queued.current = null;
  }, [pageId]);

  const settle = useCallback((ok: boolean) => {
    const pending = waiters.current;
    waiters.current = [];
    for (const resolve of pending) resolve(ok);
  }, []);

  const flush = useCallback(
    async (first: Properties) => {
      inFlight.current = true;
      setSaving(true);
      const id = pageId;
      // Another user's change arriving now waits for this save (propertiesLive.ts): a GET racing the PUT must not win.
      markSaving(id, true);
      let current = first;
      try {
        for (;;) {
          const server = serverRef.current;
          const original = server?.properties ?? {};
          const wire = editableProperties(toWireProperties(current, original), server?.readOnly ?? ['id']);
          const answer = await api.updatePageProperties(id, {
            properties: wire,
            ...(server?.etag !== undefined ? { etag: server.etag } : {}),
          });
          // The PUT answer carries the new state when the server sends it; otherwise read it back (a fresh etag, too).
          const fresh = isPayload(answer) ? answer : await api.getPageProperties(id);
          queryClient.setQueryData(pagePropertiesKey(id), fresh);
          serverRef.current = fresh;
          if (queued.current) {
            current = queued.current;
            queued.current = null;
            continue;
          }
          break;
        }
        if (pageRef.current === id) setOptimistic(null);
        // Front matter feeds the tree (order, status, icon), the tag list, the picker's known keys and the page chrome.
        void queryClient.invalidateQueries({ queryKey: ['page', id] });
        void queryClient.invalidateQueries({ queryKey: ['tree', space] });
        void queryClient.invalidateQueries({ queryKey: ['space-tags', space] });
        void queryClient.invalidateQueries({ queryKey: ['property-types', space] });
        settle(true);
      } catch (err) {
        queued.current = null;
        if (err instanceof ApiError && err.status === 409) {
          conflictRef.current = true;
          if (pageRef.current === id) setConflict(true);
        } else {
          if (pageRef.current === id) setOptimistic(null);
          showToast(errorText(err, 'properties.saveFailed'));
        }
        settle(false);
      } finally {
        inFlight.current = false;
        markSaving(id, false);
        if (pageRef.current === id) setSaving(false);
      }
    },
    [pageId, space, queryClient, showToast, errorText, settle],
  );

  const commit = useCallback(
    (next: Properties) => {
      if (conflictRef.current) return Promise.resolve(false);
      setOptimistic(next);
      const done = new Promise<boolean>((resolve) => waiters.current.push(resolve));
      if (inFlight.current) queued.current = next;
      else void flush(next);
      return done;
    },
    [flush],
  );

  const reload = useCallback(async () => {
    conflictRef.current = false;
    queued.current = null;
    setConflict(false);
    setOptimistic(null);
    await query.refetch();
  }, [query]);

  return {
    data: query.data,
    isLoading: query.isLoading,
    properties: optimistic ?? toDisplayProperties(query.data?.properties ?? {}),
    saving,
    conflict,
    commit,
    reload,
  };
}
