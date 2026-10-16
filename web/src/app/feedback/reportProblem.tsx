import { useEffect, useState } from 'react';
import { isSentryEnabled } from '../../sentry';
import { ReportProblemDialog } from './ReportProblemDialog';

/**
 * Opens the "Report a problem" dialog from anywhere (an error screen, Excalidraw's help dialog) without threading a
 * callback through the tree. `ReportProblemHost`, mounted once under the router, shows it.
 */
export interface ReportProblemRequest {
  /** The Sentry event of the error being reported; the report is linked to it. */
  eventId?: string;
}

type Listener = (request: ReportProblemRequest) => void;
const listeners = new Set<Listener>();

/** Asks the host to open the dialog. Returns false (and does nothing) while error reporting is not switched on. */
export function requestReportProblem(request: ReportProblemRequest = {}): boolean {
  if (!isSentryEnabled() || listeners.size === 0) return false;
  for (const listener of [...listeners]) listener(request);
  return true;
}

export function ReportProblemHost() {
  const [request, setRequest] = useState<ReportProblemRequest | null>(null);
  useEffect(() => {
    const listener: Listener = (next) => setRequest(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return request ? <ReportProblemDialog eventId={request.eventId} onClose={() => setRequest(null)} /> : null;
}
