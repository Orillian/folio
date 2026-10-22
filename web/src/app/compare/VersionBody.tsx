import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { PageDoc } from '@shared/contracts';
import { api, ApiError } from '../api';
import { Markdown } from '../../markdown';
import { HistoryFilePreview, HistorySvgPreview } from '../header/HistoryPanel';
import { EmbeddedNotice } from '../routes/EmbeddedNotice';
import { FormPageView } from '../routes/FormPageView';
import { diffLines, exceedsDiffLimit } from '../settings/lineDiff';
import { highlightChanges } from './compareDiff';
import '../i18n/register';

/** What a version column compares itself with: the leftmost column's text (absent text: nothing to compare — a board, a file). */
export interface CompareBase {
  markdown: string | undefined;
  loading: boolean;
}

export interface VersionBodyProps {
  pageId: string;
  sha: string;
  /** The page as the server describes it now (kind, path, space); undefined until it is known. */
  page: PageDoc | undefined;
  /** Null: nothing to compare with — this IS the base column, or highlighting is off. */
  base: CompareBase | null;
}

/**
 * A page as it was at one commit, read-only: the history panel's own previews for boards and files, the Markdown
 * renderer for a document, the file's text for the kinds without a read-only renderer here (a table, a canvas, an
 * artifact, a base), the form itself for a form. With `base` the text is marked up against it.
 */
export function VersionBody({ pageId, sha, page, base }: VersionBodyProps) {
  const { t } = useTranslation('app');
  const { data, isLoading, error } = useQuery({
    // The history panel's own key: opening a version there and comparing it here fetches it once.
    queryKey: ['history', pageId, sha],
    queryFn: () => api.getPageHistoryVersion(pageId, sha),
  });

  if (isLoading) return <p className="p-4 text-sm text-neutral-400">{t('history.panel.loadingVersion')}</p>;
  if (error instanceof ApiError && error.status === 403) return <EmbeddedNotice kind="noAccess" />;
  if (error instanceof ApiError && error.status === 404) return <EmbeddedNotice kind="notFound" />;
  if (error || !data) return <p className="p-4 text-sm text-red-600 dark:text-red-400">{t('history.panel.contentLoadFailed')}</p>;

  if (data.svg !== undefined) return <div className="p-3"><HistorySvgPreview svg={data.svg} /></div>;
  if (data.file) return <div className="p-3"><HistoryFilePreview pageId={pageId} sha={sha} file={data.file} /></div>;
  if (data.markdown === undefined) return <p className="p-4 text-sm text-neutral-400">{t('history.panel.versionEmpty')}</p>;

  const kind = page?.kind ?? 'doc';
  if (kind === 'form') {
    return (
      <div className="p-3">
        <FormPageView pageId={pageId} space={page?.space} markdown={data.markdown} canEdit={false} submitDisabled />
      </div>
    );
  }
  if (kind === 'doc') return <VersionMarkdown markdown={data.markdown} page={page} base={base} />;
  return <VersionText markdown={data.markdown} base={base} />;
}

/** The one-line state of the highlighting above a column: loading / nothing to compare / too big / no differences / how many. */
function HighlightNote({ children }: { children: string }) {
  return <p className="border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">{children}</p>;
}

function VersionMarkdown({ markdown, page, base }: { markdown: string; page: PageDoc | undefined; base: CompareBase | null }) {
  const { t } = useTranslation('app');
  const baseText = base?.markdown;
  const highlight = useMemo(() => (baseText === undefined ? null : highlightChanges(baseText, markdown)), [baseText, markdown]);

  const plain = (
    <div className="px-4 py-3 text-[13px] [&_.folio-markdown]:max-w-none">
      <Markdown markdown={markdown} space={page?.space ?? ''} pagePath={page?.path ?? ''} />
    </div>
  );
  if (!base) return plain;
  if (base.loading) return <><HighlightNote>{t('compare.highlight.loading')}</HighlightNote>{plain}</>;
  if (!highlight) return <><HighlightNote>{t('compare.highlight.noBase')}</HighlightNote>{plain}</>;
  if (highlight.tooLarge) return <><HighlightNote>{t('compare.highlight.tooLarge')}</HighlightNote>{plain}</>;

  const identical = highlight.changedBlocks === 0 && highlight.removedGroups === 0;
  return (
    <>
      <HighlightNote>
        {identical ? t('compare.highlight.identical') : t('compare.highlight.summary', { changed: highlight.changedBlocks, removed: highlight.removedGroups })}
      </HighlightNote>
      {/* Each segment is its own Markdown: drop the page padding .folio-markdown carries, or every chunk gets 40px/96px gaps. */}
      <div className="px-6 pb-24 pt-10 text-[13px] [&_.folio-markdown]:max-w-none [&_.folio-markdown]:!p-0">
        {highlight.segments.map((segment, index) =>
          segment.kind === 'removed' ? (
            <div
              key={index}
              data-compare-removed=""
              title={t('compare.highlight.removed')}
              className="my-2 whitespace-pre-wrap break-words border-l-[3px] border-red-400 bg-red-50/60 py-1 pl-3 font-mono text-xs leading-5 text-red-900/70 line-through decoration-red-400/60 dark:border-red-500 dark:bg-red-950/25 dark:text-red-200/70"
            >
              {segment.lines.slice(0, 8).join('\n')}
              {segment.lines.length > 8 ? '\n…' : ''}
            </div>
          ) : (
            <div
              key={index}
              data-compare-changed={segment.kind === 'changed' ? '' : undefined}
              className={segment.kind === 'changed' ? '-ml-3 rounded-sm border-l-[3px] border-emerald-500 bg-emerald-50/70 py-1 pl-3 dark:border-emerald-500 dark:bg-emerald-950/30' : undefined}
            >
              <Markdown markdown={segment.text} space={page?.space ?? ''} pagePath={page?.path ?? ''} />
            </div>
          ),
        )}
      </div>
    </>
  );
}

/** A kind without a read-only renderer here: the file's own text, as a line diff against the base when there is one. */
function VersionText({ markdown, base }: { markdown: string; base: CompareBase | null }) {
  const { t } = useTranslation('app');
  const baseText = base?.markdown;
  const rows = useMemo(
    () => (baseText === undefined || exceedsDiffLimit(baseText, markdown) ? null : diffLines(baseText, markdown)),
    [baseText, markdown],
  );
  const mono = 'font-mono text-xs leading-5 whitespace-pre-wrap break-words';
  if (!rows) {
    return (
      <>
        {base && <HighlightNote>{t(base.loading ? 'compare.highlight.loading' : baseText === undefined ? 'compare.highlight.noBase' : 'compare.highlight.tooLarge')}</HighlightNote>}
        <pre className={`${mono} p-3 text-neutral-700 dark:text-neutral-300`}>{markdown}</pre>
      </>
    );
  }
  return (
    <div className={`${mono} py-2`}>
      {rows.map((row, index) => (
        <div
          key={index}
          className={`px-3 ${
            row.kind === 'add'
              ? 'bg-emerald-100 text-emerald-950 dark:bg-emerald-950/50 dark:text-emerald-100'
              : row.kind === 'del'
                ? 'bg-red-100 text-red-950 line-through opacity-70 dark:bg-red-950/50 dark:text-red-100'
                : 'text-neutral-600 dark:text-neutral-400'
          }`}
        >
          {row.text || ' '}
        </div>
      ))}
    </div>
  );
}
