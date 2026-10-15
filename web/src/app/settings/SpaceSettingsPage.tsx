import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api';
import { useSpaceRole } from '../auth/AuthProvider';
import { canManageMembers } from '../auth/roles';
import { useApiErrorText } from '../errorText';
import { useDocumentTitle } from '../hooks';
import { Tabs } from '../ui/Tabs';
import { AppearanceTab } from './AppearanceTab';
import { PdfTab } from './PdfTab';
import { SiteTab } from './SiteTab';
import { TAB_KEYS, parseTab, type SettingsTab } from './appearanceLogic';
import { useAppearance } from './useAppearance';
import '../i18n/register';

/**
 * `/s/:space/settings` — "Site & PDF" (space admins). One page for everything about how the space
 * presents itself outside the app: the publication summary (kept in Folio) and the SEO form, the
 * public site's stylesheet with a live preview, and the PDF header, footer and print CSS. All
 * files live in `.folio/` in the repository and are saved one tab at a time, one commit per save.
 * The tab is `?tab=site|appearance|pdf`; unsaved edits survive moving between the tabs.
 */
export function SpaceSettingsPage() {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const { space = '' } = useParams<{ space: string }>();
  const role = useSpaceRole(space);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get('tab'));
  useDocumentTitle(t('spaceSettings.title'));

  const spaces = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const spaceName = spaces.data?.spaces.find((s) => s.slug === space)?.name ?? space;
  const allowed = canManageMembers(role);

  const controller = useAppearance(space);

  // Closing the tab or reloading with unsaved edits asks first.
  useEffect(() => {
    if (!controller.anyDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [controller.anyDirty]);

  if (!allowed) {
    if (spaces.isLoading) return <div className="p-8 text-sm text-neutral-400">{t('ui.loading')}</div>;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('spaceSettings.noAccess')}</p>
        <Link to={`/s/${encodeURIComponent(space)}`} className="text-sm text-blue-600 underline underline-offset-2 dark:text-blue-400">
          {t('spaceSettings.backToSpace')}
        </Link>
      </div>
    );
  }

  function selectTab(key: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', key);
      return next;
    });
  }

  const forbidden = controller.query.isError && controller.query.error instanceof ApiError && controller.query.error.status === 403;

  return (
    <div className="mx-auto w-full max-w-6xl p-4 md:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('spaceSettings.title')}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{spaceName}</p>
      </div>

      <Tabs
        className="mb-5"
        active={tab}
        onSelect={selectTab}
        items={TAB_KEYS.map((key: SettingsTab) => ({
          key,
          label: `${t(`spaceSettings.tabs.${key}`)}${controller.tabDirty(key) ? ' •' : ''}`,
        }))}
      />

      {controller.query.isLoading && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}
      {controller.query.isError && (
        <p className="mb-4 text-sm text-red-600 dark:text-red-400">
          {forbidden ? t('spaceSettings.filesForbidden') : errorText(controller.query.error, 'spaceSettings.loadFailed')}{' '}
          {!forbidden && (
            <button type="button" onClick={() => void controller.query.refetch()} className="underline underline-offset-2">
              {t('auth.retry')}
            </button>
          )}
        </p>
      )}

      {/* An instance admin who is not a space admin may still read and change the publication block. */}
      {forbidden && tab === 'site' && <SiteTab space={space} spaceName={spaceName} controller={controller} publishOnly />}
      {controller.data && tab === 'site' && <SiteTab space={space} spaceName={spaceName} controller={controller} />}
      {controller.data && tab === 'appearance' && <AppearanceTab space={space} controller={controller} />}
      {controller.data && tab === 'pdf' && <PdfTab space={space} controller={controller} />}
    </div>
  );
}
