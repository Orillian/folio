import { loadedBundleId } from './build-version';
import { getConnectivity } from './offline/connectivity';

/**
 * A deploy replaces every hashed chunk under /assets/ — a tab left open
 * across that deploy can ask for a chunk (a mermaid diagram type, TableGrid,
 * BoardCanvas, ...) that's simply gone. The browsers word the resulting
 * failure differently, but it's always the same situation: the loaded
 * bundle is stale, and a reload fetches the new one. Vite fires its own
 * `vite:preloadError` window event for exactly this case (see main.tsx),
 * but the same failure can also surface as a plain rejected `import()` —
 * e.g. inside mermaid's own lazy diagram-type loading (diagrams/MermaidBlock)
 * or a `lazy()` component's error boundary (editor/mermaid-visual.tsx) — so
 * detection lives here as a standalone check, not tied to that one event.
 *
 * server/spaFallback.ts's companion fix (an `/assets/*` miss now answers 404
 * instead of index.html+200) is what makes the browser word it this way at
 * all, rather than trying to execute HTML as a module and producing some
 * third, even less legible error.
 */

const STALE_CHUNK_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
];

/** True for any of the known "the bundle on disk moved on without us" browser messages. */
export function isStaleChunkError(error: unknown): boolean {
  return STALE_CHUNK_PATTERNS.some((pattern) => pattern.test(messageOf(error)));
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  // vite:preloadError's `event.payload` is itself typically an Error, but
  // guard the general CustomEvent/unknown shape too.
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return '';
}

/**
 * Reload bookkeeping, kept in sessionStorage so it survives the reload it
 * guards: `{ <key>: <time of the reload for it> }`. The key is the failing
 * chunk's path (or, when the browser does not name it, the running build).
 *
 * It is deliberately NOT cleared when the shell renders. It used to be
 * (main.tsx wiped the flag after the first render), and that made a chunk
 * that stays missing loop forever: reload, the shell renders, the flag is
 * gone, the same lazy chunk fails again, reload, ... (16.10.2026). Entries
 * expire by time instead: one reload per key per RELOAD_WINDOW_MS.
 */
const RELOAD_LOG = 'folio:stale-chunk-reloads';
export const RELOAD_WINDOW_MS = 60_000;
/** Whatever the keys, no more reloads than this inside the window — a safety net against many different chunks failing in turn. */
const MAX_RELOADS_IN_WINDOW = 3;
/** How long a reload that has been asked for counts as "on its way" — the page is leaving, nothing else should react. */
const PENDING_MS = 5_000;

type ReloadLog = Record<string, number>;
let memoryLog: ReloadLog = {};
let pendingUntil = 0;
const reported = new Set<string>();

function readLog(now: number): ReloadLog {
  let log: ReloadLog = memoryLog;
  try {
    const raw = sessionStorage.getItem(RELOAD_LOG);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) log = { ...memoryLog, ...(parsed as ReloadLog) };
    }
  } catch {
    // sessionStorage unavailable or garbled — fall back to what this document remembers.
  }
  const fresh: ReloadLog = {};
  for (const [key, at] of Object.entries(log)) {
    if (typeof at === 'number' && now - at < RELOAD_WINDOW_MS && at <= now + RELOAD_WINDOW_MS) fresh[key] = at;
  }
  return fresh;
}

function writeLog(log: ReloadLog): void {
  memoryLog = log;
  try {
    sessionStorage.setItem(RELOAD_LOG, JSON.stringify(log));
  } catch {
    // ignore — see readLog()
  }
}

/** Forgets everything this module remembers, as a freshly loaded page would. Tests only. */
export function resetStaleChunkStateForTests(): void {
  memoryLog = {};
  pendingUntil = 0;
  reported.clear();
  try {
    sessionStorage.removeItem(RELOAD_LOG);
  } catch {
    // ignore
  }
}

/**
 * What the failure is about: the chunk's path when the browser's message
 * names it (Chrome and Firefox do), else the build this tab is running
 * (Safari's "Importing a module script failed" names nothing).
 */
export function staleChunkKey(error: unknown): string {
  const match = /(?:https?:)?\/\/[^\s'")]+|\/assets\/[^\s'")]+/.exec(messageOf(error));
  if (match) {
    try {
      return `chunk:${new URL(match[0], window.location.href).pathname}`;
    } catch {
      return `chunk:${match[0]}`;
    }
  }
  return `build:${loadedBundleId() ?? 'unknown'}`;
}

function isOffline(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return getConnectivity() === 'offline';
}

let quiet = 0;

/**
 * A dynamic import made ahead of need (offline mode warms up the board
 * editor while there still is a network). Its failure is nobody's problem:
 * no reload, no rejection — `undefined`, and the real import, when someone
 * actually needs the module, gets its own attempt and its own error.
 */
export async function quietImport<T>(load: () => Promise<T>): Promise<T | undefined> {
  quiet += 1;
  try {
    return await load();
  } catch {
    return undefined;
  } finally {
    quiet -= 1;
  }
}

/**
 * If `error` looks like a stale-chunk failure, reloads the page and returns
 * `true` — the caller should stop, the page is on its way out. At most one
 * reload per failing chunk (or build) per RELOAD_WINDOW_MS. Returns `false`
 * because `error` isn't a stale-chunk error, or because a reload for it
 * already happened a moment ago and didn't help (a chunk that is really gone,
 * a server problem) — the caller should show its own error instead of
 * looping forever.
 */
export function tryReloadForStaleChunk(error: unknown): boolean {
  if (!isStaleChunkError(error)) return false;
  // Offline, the very same browser message means something else entirely:
  // the chunk is not stale, it is unreachable. A reload then does not fetch a
  // newer bundle — it replaces a working application with the browser's
  // "no internet" page, taking the author's offline work off the screen with
  // it (the owner, 29.09.2026: "an attempt to create a board offline led to
  // everything disappearing"). Same for an import made in the background
  // (`quietImport`): nobody asked for it, so nobody's page reloads over it.
  if (quiet > 0 || isOffline()) return false;
  const now = Date.now();
  // Several failures arrive together (vite:preloadError, then the boundary that
  // caught the same rejection): the second must not read the first one's
  // reload as "it already failed once" and put an error screen up over a page
  // that is already leaving.
  if (now < pendingUntil) return true;
  const key = staleChunkKey(error);
  const log = readLog(now);
  if (log[key] !== undefined || Object.keys(log).length >= MAX_RELOADS_IN_WINDOW) return false;
  log[key] = now;
  writeLog(log);
  pendingUntil = now + PENDING_MS;
  window.location.reload();
  return true;
}

/**
 * Whether this stale-chunk failure has not been reported yet: the first call
 * for a chunk (or build) says yes, the rest no. An error screen can render
 * several times for one broken chunk (retries, remounts) and should land in
 * Sentry once.
 */
export function shouldReportStaleChunk(error: unknown): boolean {
  if (!isStaleChunkError(error)) return true;
  const key = staleChunkKey(error);
  if (reported.has(key)) return false;
  reported.add(key);
  return true;
}

/** Vite's own signal for a failed/aborted dynamic import or CSS preload — see the module doc comment. */
export function installStaleChunkListener(): void {
  // Vite types this event itself (VitePreloadErrorEvent): `payload` is the
  // rejected import()'s error, which is what the detector wants.
  window.addEventListener('vite:preloadError', (event) => {
    tryReloadForStaleChunk(event.payload ?? event);
  });
}
