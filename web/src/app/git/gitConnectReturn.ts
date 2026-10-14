import { GIT_CONNECT_RESULTS, type GitConnectResult } from './ConnectGitHubButton';

/**
 * Reading the `?gitConnect=<result>` the server appends after the "Connect
 * with GitHub" round-trip. Captured once, when this module is first
 * evaluated at app start — before any client-side redirect (e.g. "/" to a
 * space) could drop the query string — then removed from the address bar so
 * a reload does not show the toast again.
 */
export function parseGitConnectResult(search: string): GitConnectResult | null {
  const raw = new URLSearchParams(search).get('gitConnect');
  if (raw === null) return null;
  return (GIT_CONNECT_RESULTS as readonly string[]).includes(raw) ? (raw as GitConnectResult) : 'exchange';
}

let pending: GitConnectResult | null = typeof window === 'undefined' ? null : parseGitConnectResult(window.location.search);

/** The result waiting to be shown, if any. Does not consume it (safe to call from a state initializer, which StrictMode runs twice). */
export function peekGitConnectResult(): GitConnectResult | null {
  return pending ?? (typeof window === 'undefined' ? null : parseGitConnectResult(window.location.search));
}

/** Removes `gitConnect` from the address bar, keeping the rest of the URL and the router's history state. */
export function stripGitConnectParam(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has('gitConnect')) return;
  url.searchParams.delete('gitConnect');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

/** The result has been shown: forget it, so a remount does not show it again. */
export function clearGitConnectResult(): void {
  pending = null;
  stripGitConnectParam();
}
