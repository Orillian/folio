import { Lock, SearchX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../i18n/register';

export interface EmbeddedNoticeProps {
  kind: 'notFound' | 'noAccess';
}

/**
 * The compact twin of NotFound / NoAccess for a page drawn inside another surface (a column of the compare view):
 * the same two answers (404: not there; 403: there, but not yours), without the full-screen layout, the tab title
 * or the "request access" button — the shared link is read by people with different rights, and one column the
 * reader cannot open must not look like a failure of the whole view.
 */
export function EmbeddedNotice({ kind }: EmbeddedNoticeProps) {
  const { t } = useTranslation('app');
  const Icon = kind === 'noAccess' ? Lock : SearchX;
  return (
    <div role="status" className="flex h-full min-h-40 flex-col items-center justify-center gap-2 p-6 text-center">
      <Icon size={32} className="text-neutral-300 dark:text-neutral-700" aria-hidden="true" />
      <p className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
        {kind === 'noAccess' ? t('routes.noAccess.title') : t('routes.notFound.title')}
      </p>
      <p className="max-w-xs text-xs text-neutral-500 dark:text-neutral-400">
        {kind === 'noAccess' ? t('routes.noAccess.generic') : t('routes.page.notFound')}
      </p>
    </div>
  );
}
