import { ExternalLink, GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AppearanceFile, AppearanceFileState } from '@shared/contracts';
import { fallbackPath, repoFileUrl } from './appearanceLogic';
import '../i18n/register';

export interface RepoFileBadgeProps {
  file: AppearanceFile;
  /** The server's description of the file; absent while it loads. */
  state: AppearanceFileState | undefined;
  contentRoot: string;
  repoFileBaseUrl: string | null;
  /** Warnings the server reported for the STORED content (site.css shows live ones instead). */
  showWarnings?: boolean;
}

/** Where a file lives in the repository, with the link to it in the hosting UI. */
export function RepoFileBadge({ file, state, contentRoot, repoFileBaseUrl, showWarnings = true }: RepoFileBadgeProps) {
  const { t } = useTranslation('app');
  const path = state?.path ?? fallbackPath(contentRoot, file);
  const url = state?.exists ? repoFileUrl(repoFileBaseUrl, path) : null;
  const warnings = showWarnings ? (state?.warnings ?? []) : [];
  return (
    <div data-testid={`repo-badge-${file}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1 rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
          <GitBranch size={12} aria-hidden="true" />
          {path}
        </span>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
          >
            {t('spaceSettings.repoFile.open')}
            <ExternalLink size={11} aria-hidden="true" />
          </a>
        )}
        {state && !state.exists && state.source !== 'legacy' && <span className="text-neutral-500 dark:text-neutral-400">{t('spaceSettings.repoFile.notCreated')}</span>}
        {state?.source === 'legacy' && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">{t('spaceSettings.repoFile.legacy')}</span>
        )}
      </div>
      {warnings.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-amber-700 dark:text-amber-400">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
