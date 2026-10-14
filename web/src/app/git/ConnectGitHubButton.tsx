import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { GitCredentialInfo } from '@shared/contracts';
import { api } from '../api';
import '../i18n/register';

/** Server route that starts the OAuth round-trip (server/auth/githubConnect.ts). */
export const GITHUB_CONNECT_START_PATH = '/api/auth/github-connect/start';

/** Every value the server can put in `?gitConnect=` on the way back. */
export const GIT_CONNECT_RESULTS = ['ok', 'denied', 'state', 'exchange', 'scope', 'save', 'session', 'disabled', 'demo'] as const;
export type GitConnectResult = (typeof GIT_CONNECT_RESULTS)[number];

export function githubConnectStartUrl(returnTo: string): string {
  return `${GITHUB_CONNECT_START_PATH}?returnTo=${encodeURIComponent(returnTo)}`;
}

/** true when the instance has a GitHub OAuth App configured (FolioConfig.githubOAuth). Shares the ['config'] query with CreateSpaceDialog's prefill. */
export function useGitHubOAuthEnabled(): boolean {
  const config = useQuery({ queryKey: ['config'], queryFn: api.getConfig, retry: false });
  return config.data?.githubOAuth === true;
}

export function hasGitHubComCredential(credentials: GitCredentialInfo[] | undefined): boolean {
  return (credentials ?? []).some((cred) => cred.host === 'github.com');
}

/** The GitHub mark (brand icon; lucide no longer ships brand icons). */
function GitHubMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export interface ConnectGitHubButtonProps {
  /** 'block' — the full-width button in "Git access"; 'inline' — a small link-style button inside the space dialogs. */
  variant?: 'block' | 'inline';
}

/**
 * "Connect with GitHub": a full-page redirect to GitHub's consent screen and
 * back to the current path, where UserMenu reopens "Git access" with the
 * result (see gitConnectReturn.ts). Any open dialog is left behind on
 * purpose — after the round-trip the saved github.com credential is simply
 * there the next time the dialog is opened.
 */
export function ConnectGitHubButton({ variant = 'block' }: ConnectGitHubButtonProps) {
  const { t } = useTranslation('app');
  const go = () => window.location.assign(githubConnectStartUrl(window.location.pathname));

  if (variant === 'inline') {
    return (
      <button
        type="button"
        onClick={go}
        className="-mt-1 flex items-center gap-1.5 self-start text-xs text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
      >
        <GitHubMark size={12} />
        {t('git.credentials.github.connect')}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={go}
      className="flex items-center justify-center gap-2 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
    >
      <GitHubMark />
      {t('git.credentials.github.connect')}
    </button>
  );
}
