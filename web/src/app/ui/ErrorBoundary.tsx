import { Component, type ErrorInfo, type ReactNode } from 'react';
import { captureError } from '../../sentry';
import { isStaleChunkError, shouldReportStaleChunk, tryReloadForStaleChunk } from '../stale-chunk';

export interface ErrorBoundaryProps {
  /** What to show instead of the subtree that threw. `reset` renders the subtree again. */
  fallback: (error: unknown, reset: () => void, eventId?: string) => ReactNode;
  /** A change of this value clears the error by itself — the route, the page id. */
  resetKey?: unknown;
  children: ReactNode;
}

interface State {
  error: unknown;
  failed: boolean;
  /** The Sentry event of this error, for "Report a problem" on the fallback; unset while reporting is off. */
  eventId?: string;
}

/**
 * React takes the WHOLE tree down when a render throws and nothing catches
 * it — sidebar, header, everything (the owner, 29.09.2026: "an attempt to
 * create a board offline led to everything disappearing": a lazily loaded module
 * that cannot be fetched without a network rejects inside `lazy()`, which
 * is a render error). This keeps the damage to the part that failed.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (isStaleChunkError(error)) {
      // A chunk the server no longer has: the first time, reload (once per chunk per minute, stale-chunk.ts) and
      // report nothing — the page is leaving and the new build very likely has it. When the reload already
      // happened and the chunk is still missing this is a real fault: report it, once, and keep the error screen.
      if (tryReloadForStaleChunk(error)) return;
      // eslint-disable-next-line no-console
      console.error('[folio] chunk failed to load:', error);
      if (!shouldReportStaleChunk(error)) return;
      const eventId = captureError(error);
      if (eventId) this.setState({ eventId });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[folio] render failed:', error, info.componentStack);
    // Reported only when the operator switched error reporting on (web/src/sentry); a no-op otherwise.
    const eventId = captureError(error);
    if (eventId) this.setState({ eventId });
  }

  componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.reset();
  }

  reset = (): void => {
    this.setState({ error: null, failed: false, eventId: undefined });
  };

  render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.state.error, this.reset, this.state.eventId) : this.props.children;
  }
}
