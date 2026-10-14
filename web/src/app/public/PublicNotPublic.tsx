import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n/register';

export interface PublicNotPublicProps {
  /** Why the site is not shown: it is not (or no longer) public, or it could not be loaded at all. */
  reason: 'not-public' | 'load-failed';
  /** Where to sign in (the same space inside the app), when it is known. */
  signInHref?: string;
  onRetry?: () => void;
}

/** What a visitor sees at a public URL whose space is private, unpublished or gone — with a way into the app for people who do have an account. */
export function PublicNotPublic({ reason, signInHref, onRetry }: PublicNotPublicProps) {
  const { t } = useTranslation('app');
  useEffect(() => {
    const original = document.title;
    document.title = t('publicSite.notPublic.title');
    return () => {
      document.title = original;
    };
  }, [t]);

  return (
    <div className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-3 bg-white p-8 text-center dark:bg-neutral-950">
      <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
        {t(reason === 'not-public' ? 'publicSite.notPublic.title' : 'publicSite.loadFailed')}
      </h1>
      {reason === 'not-public' && <p className="max-w-sm text-sm text-neutral-500 dark:text-neutral-400">{t('publicSite.notPublic.hint')}</p>}
      {reason === 'load-failed' && onRetry && (
        <button type="button" onClick={onRetry} className="text-sm text-blue-600 underline underline-offset-2 dark:text-blue-400">
          {t('auth.retry')}
        </button>
      )}
      {signInHref && (
        <a href={signInHref} className="text-sm text-blue-600 underline underline-offset-2 dark:text-blue-400">
          {t('publicSite.signIn')}
        </a>
      )}
    </div>
  );
}
