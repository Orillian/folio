/**
 * Excalidraw 0.18's Help dialog ("?", bottom right) has no props or slots for its links: it sends "Found an issue?"
 * to github.com/excalidraw/excalidraw/issues (so people reported Folio problems to Excalidraw) and advertises
 * Excalidraw's blog and YouTube. So the dialog is adjusted from the outside:
 *   - the issue link opens Folio's own "Report a problem" dialog instead of navigating (this file, wired in BoardCanvas);
 *   - the blog and YouTube links are hidden, and the issue link too while error reporting is off (styles.css, keyed on
 *     `html[data-folio-report="on"]`, which initSentry sets), so there is never a dead or foreign link;
 *   - the documentation link and the keyboard shortcuts stay.
 */
import { requestReportProblem } from '../app/feedback/reportProblem';

const ISSUES_HREF = /^https?:\/\/github\.com\/excalidraw\/excalidraw\/issues\/?$/i;

/** The "Found an issue?" link of Excalidraw's Help dialog when the event came from it, else null. */
export function helpDialogIssueLink(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null;
  const link = target.closest('.HelpDialog a.HelpDialog__btn[href]');
  return link instanceof HTMLAnchorElement && ISSUES_HREF.test(link.getAttribute('href') ?? '') ? link : null;
}

/**
 * Click handler for the board container (capture phase, so it runs before the link navigates). Returns true when the
 * click was the issue link: it never navigates; with error reporting on it opens our dialog and then closes Excalidraw's.
 */
export function interceptHelpDialogClick(
  event: { target: EventTarget | null; preventDefault: () => void; stopPropagation: () => void },
  closeHelp: () => void,
): boolean {
  if (!helpDialogIssueLink(event.target)) return false;
  event.preventDefault();
  event.stopPropagation();
  if (requestReportProblem()) closeHelp();
  return true;
}
