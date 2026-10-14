import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useDocumentTitle } from '../hooks';
import '../i18n/register';

export interface NotFoundProps {
  message?: string;
}

/**
 * Generic 404 view: bad page id, unresolved space, or a garbage URL. It says
 * nothing about rights and offers no "request access" — a thing that does
 * not exist cannot be asked for. A 403 (it exists, the caller may not see
 * it) is NoAccess's job.
 */
export function NotFound({ message }: NotFoundProps) {
  const { t } = useTranslation('app');
  useDocumentTitle(t('routes.notFound.title'));
  return (
    <div className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-5xl font-bold text-neutral-300 dark:text-neutral-700">404</div>
      <p className="max-w-sm text-sm text-neutral-500 dark:text-neutral-400">{message ?? t('routes.notFound.pageNotFound')}</p>
      <Link
        to="/"
        className="text-sm text-blue-600 underline underline-offset-2 dark:text-blue-400"
      >
        {t('admin.backHome')}
      </Link>
    </div>
  );
}
