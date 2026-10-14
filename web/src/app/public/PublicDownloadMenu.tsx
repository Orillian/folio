import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Download, FileCode, FileText, FileType } from 'lucide-react';
import { ApiError, api } from '../api';
import { useApiErrorText } from '../errorText';
import { Menu } from '../ui/Menu';
import { downloadBlob } from '../../diagrams/download';
import { fallbackExportFilename, filenameFromDisposition, isChromiumUnavailable } from '../export/pageExport';
import '../i18n/register';

type PublicExportFormat = 'md' | 'pdf' | 'docx';

const FORMATS: readonly PublicExportFormat[] = ['md', 'pdf', 'docx'];

const FORMAT_ICONS: Record<PublicExportFormat, ReactNode> = {
  md: <FileCode size={14} aria-hidden="true" />,
  pdf: <FileText size={14} aria-hidden="true" />,
  docx: <FileType size={14} aria-hidden="true" />,
};

export interface PublicDownloadMenuProps {
  /** The space's slug. */
  space: string;
  pageId: string;
  /** Page path/title: only used to name the file when the response carries no Content-Disposition. */
  pagePath?: string;
  title?: string;
}

type Feedback = { tone: 'warning' | 'error'; text: string };

/** Clears a previous export's message every time the panel opens (the Menu keeps this component mounted but only renders the panel while open). */
function Panel({ onOpen, children }: { onOpen: () => void; children: ReactNode }) {
  useEffect(() => {
    onOpen();
  }, [onOpen]);
  return <div className="w-64 p-1">{children}</div>;
}

/**
 * Download of the current page as Markdown / PDF / DOCX from a public site, with the export menu's
 * "include child pages" option. Offered only when the space allows downloads. A fetch + blob rather
 * than a bare `<a download>`: the route answers 429 when rate limited and 404 when downloads are
 * off, and a link would show the visitor that as a blank JSON page instead of a sentence.
 */
export function PublicDownloadMenu({ space, pageId, pagePath, title }: PublicDownloadMenuProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const [pending, setPending] = useState<PublicExportFormat | null>(null);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const resetPanel = useCallback(() => setFeedback(null), []);

  function describeFailure(error: unknown, format: PublicExportFormat): string {
    if (format === 'pdf' && isChromiumUnavailable(error)) return t('publicSite.download.pdfUnavailable');
    if (error instanceof ApiError && error.status === 404) return t('publicSite.download.disabled');
    return errorText(error, 'export.failed');
  }

  async function run(format: PublicExportFormat, close: () => void) {
    setPending(format);
    setFeedback(null);
    try {
      const res = await fetch(api.publicExportUrl(space, pageId, format, includeChildren), { credentials: 'same-origin' });
      if (!res.ok) {
        let message = res.statusText || `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          // Not JSON — keep the status text.
        }
        throw new ApiError(res.status, message);
      }
      const truncated = res.headers.get('X-Folio-Export-Truncated');
      downloadBlob(
        await res.blob(),
        filenameFromDisposition(res.headers.get('Content-Disposition')) ?? fallbackExportFilename({ path: pagePath, title }, format),
      );
      if (truncated && truncated !== 'false') {
        // A 200 with a valid file that is only part of the document: say so instead of closing quietly.
        setFeedback({ tone: 'warning', text: t('publicSite.download.truncated') });
      } else {
        close();
      }
    } catch (error) {
      console.error(`public export (${format}) failed`, error);
      setFeedback({ tone: 'error', text: describeFailure(error, format) });
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;

  return (
    <Menu triggerLabel={t('publicSite.download.button')} align="right" trigger={<Download size={15} aria-hidden="true" />}>
      {(close) => (
        <Panel onOpen={resetPanel}>
          <div className="px-1.5 pb-1 pt-1.5 text-xs font-medium text-neutral-400 dark:text-neutral-500">
            {t('publicSite.download.button')}
          </div>
          {FORMATS.map((format) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => void run(format, close)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {FORMAT_ICONS[format]}
              <span className="truncate">{pending === format ? t('export.exporting') : t(`export.format.${format}`)}</span>
            </button>
          ))}
          <label className="mt-1 flex cursor-pointer items-start gap-2 rounded-md px-2.5 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={includeChildren}
              disabled={busy}
              onChange={(e) => setIncludeChildren(e.target.checked)}
            />
            <span>
              <span className="block text-neutral-700 dark:text-neutral-300">{t('export.includeChildren')}</span>
              <span className="block text-neutral-400 dark:text-neutral-500">{t('export.includeChildrenHint')}</span>
            </span>
          </label>
          {feedback && (
            <div
              role="alert"
              className={`mt-1 flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-xs ${
                feedback.tone === 'error'
                  ? 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'
                  : 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
              }`}
            >
              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{feedback.text}</span>
            </div>
          )}
        </Panel>
      )}
    </Menu>
  );
}
