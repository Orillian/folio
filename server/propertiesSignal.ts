/**
 * "The properties of this page changed" — the live signal (16.10.2026).
 *
 * THE PROBLEM. The properties panel (web usePageProperties) is a react-query
 * cache entry: Dana adds `priority: high`, Marcus — the same page open — saw
 * it only after a reload (the focus refetch was the only fallback).
 *
 * THE MECHANISM, end to end (the sidebar tree's signal, server/treeSignal.ts,
 * is the model — same bus, same socket, same coalescing):
 *
 *   1. WHERE IT IS EMITTED — a trigger on pages_index.frontmatter
 *      (db/migrations/049_page_properties_notify.sql): every properties write
 *      ends in the index — the panel's / a base cell's PUT for every page kind
 *      (front matter, a table's / form's own block, a sidecar), MCP
 *      set_page_properties, a tag rename, a markdown PUT that carries a block,
 *      scanSpace after a git sync. `pg_notify('folio_page_properties',
 *      {schema, space, id})`, only when the jsonb really changed.
 *   2. HOW IT TRAVELS — the tree signal's LISTEN connection (treeSignal.ts
 *      listens on both channels and hands these notes here).
 *   3. COALESCING — per SPACE, with treeSignal's createCoalescer: the page ids
 *      noted in one window are flushed together. A burst of more than
 *      MAX_PAGES_PER_FLUSH pages (a git pull, a tag renamed on 300 pages)
 *      becomes ONE space-wide frame instead of one per page.
 *   4. WHO RECEIVES IT — per page: the open `/events` sessions that may read
 *      the space AND the page itself (notifications/audience.ts, the same
 *      filter as the shared page timer). A reader of the space who cannot open
 *      a restricted page gets nothing about it. The space-wide frame carries no
 *      page id at all, so it goes to the space's readers.
 *   5. WHAT TRAVELS — `{ type: 'page-properties', space, pageId, etag }`:
 *      never a value. `etag` is what GET /api/pages/:id/properties answers now;
 *      the tab that made the change already holds it and skips the refetch.
 *      Every other tab with that page open re-reads the properties through the
 *      normal GET (which checks access again), and never over a field its user
 *      is editing (web/src/app/properties/propertiesLive.ts).
 *
 * FAILURE MODES. A dropped LISTEN connection is re-established by treeSignal;
 * after it, every space gets one space-wide frame (changes during the gap are
 * not replayed). A failing fan-out is logged and dropped: the focus refetch
 * still catches up.
 */
import * as audience from './notifications/audience.js';
import * as notificationSocket from './notifications/socket.js';
import { readPageProperties } from './properties.js';
import * as storage from './storage.js';

/** The NOTIFY channel the trigger of migration 049 writes to. */
export const PROPERTIES_SIGNAL_CHANNEL = 'folio_page_properties';

/** More pages than this changed in one flush of a space: one space-wide frame instead of one per page. */
export const MAX_PAGES_PER_FLUSH = 25;

/**
 * The production timings (treeSignal.ts COALESCER_DEFAULTS explains each). Shorter than the tree's: a property edit
 * is one row, and the person across the table is waiting for it.
 */
export const PROPERTIES_COALESCER_DEFAULTS = {
  quietMs: 150,
  busyQuietMs: 400,
  maxWaitMs: 1500,
  minGapMs: 1000,
  maxGapMs: 4000,
  calmMs: 10_000,
} as const;

/** Page ids noted per space since its last flush; 'all' = the whole space (a resync). */
const pending = new Map<string, Set<string> | 'all'>();

/** A note from the trigger: `id` of `space` changed. The caller then notes `space` in its coalescer. */
export function recordChange(space: string, id: string): void {
  const current = pending.get(space);
  if (current === 'all') return;
  if (current) {
    current.add(id);
    return;
  }
  pending.set(space, new Set([id]));
}

/** Everything in `space` may have changed (the listener was away). */
export function recordSpace(space: string): void {
  pending.set(space, 'all');
}

export function clearPending(): void {
  pending.clear();
}

/** The coalescer's flush for `space`: one frame per changed page to the sessions that may read it. Never throws. */
export async function flushSpace(space: string): Promise<void> {
  const ids = pending.get(space);
  pending.delete(space);
  if (!ids) return;
  try {
    const readers = await audience.sessionsThatCanReadSpace(space);
    if (readers.size === 0) return;
    if (ids === 'all' || ids.size > MAX_PAGES_PER_FLUSH) {
      notificationSocket.sendToSessions(readers, { type: 'page-properties', space });
      return;
    }
    for (const id of ids) {
      const entry = await storage.getEntry(id);
      // Gone (deleted) or moved to another space in between: the tree signal tells that story.
      if (!entry || entry.space !== space) continue;
      const allowed = await audience.sessionsThatCanReadPage(entry, readers);
      if (allowed.size === 0) continue;
      let etag: string | null = null;
      try {
        etag = (await readPageProperties(entry, false)).etag;
      } catch {
        // Unreadable right now: no etag means "refetch" to every tab.
      }
      notificationSocket.sendToSessions(allowed, { type: 'page-properties', space, pageId: id, etag });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[properties-signal] could not fan out a change in "${space}": ${(err as Error).message}`);
  }
}
