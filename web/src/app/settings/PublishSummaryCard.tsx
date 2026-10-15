import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Database, ExternalLink } from 'lucide-react';
import type { PublicPrimaryHost, SpacePublicSettingsResponse } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import { visibilityLabelKey } from '../admin/access/logic';
import { PublishSpaceDialog, publicSettingsKey } from '../sidebar/PublishSpaceDialog';
import { Switch } from './Switch';
import '../i18n/register';

const PRIMARY_HOSTS: readonly PublicPrimaryHost[] = ['auto', 'path', 'subdomain', 'domain'];
const PRIMARY_HOST_LABEL: Record<PublicPrimaryHost, string> = {
  auto: 'publish.primaryHostAuto',
  path: 'publish.primaryHostPath',
  subdomain: 'publish.primaryHostSubdomain',
  domain: 'publish.primaryHostDomain',
};

export interface PublishSummaryCardProps {
  space: string;
  response: SpacePublicSettingsResponse | undefined;
  loading: boolean;
  failed: boolean;
}

/**
 * Who sees the site and where — kept in Folio's database, not in git (the badge says so). Read-mostly:
 * the addresses and visibility are read here and changed in the publish dialog ("Change…"); the two
 * switches that belong with SEO, indexing and the primary address, apply at once.
 */
export function PublishSummaryCard({ space, response, loading, failed }: PublishSummaryCardProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);

  const isPublic = response?.visibility === 'public';
  const update = useMutation({
    mutationFn: (patch: { indexing?: boolean; primaryHost?: PublicPrimaryHost }) => {
      if (!response) throw new Error('settings not loaded');
      return api.updateSpacePublicSettings(space, { ...response.settings, ...patch });
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(publicSettingsKey(space), saved);
      showToast(t('publish.saved'), 'info');
    },
    onError: (err) => showToast(errorText(err, 'publish.saveFailed')),
  });

  const addresses = useMemo(() => {
    if (!response) return [];
    return [
      { key: 'path', label: t('publish.site.pathUrl'), url: response.urls.path },
      response.urls.subdomain ? { key: 'subdomain', label: t('publish.site.subdomain'), url: response.urls.subdomain } : null,
      response.urls.domain ? { key: 'domain', label: t('publish.site.domain'), url: response.urls.domain } : null,
    ].filter((a): a is { key: string; label: string; url: string } => a !== null);
  }, [response, t]);

  return (
    <section aria-labelledby="settings-publication" className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="settings-publication" className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {t('spaceSettings.publication.title')}
        </h2>
        <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
          <Database size={11} aria-hidden="true" />
          {t('spaceSettings.publication.storedInFolio')}
        </span>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          disabled={!response}
          className="ml-auto rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {t('spaceSettings.publication.change')}
        </button>
      </div>

      {loading && <p className="mt-3 text-sm text-neutral-400">{t('ui.loading')}</p>}
      {failed && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{t('publish.loadFailed')}</p>}

      {response && (
        <div className="mt-3 space-y-4">
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            <span className="text-neutral-500 dark:text-neutral-400">{t('spaceSettings.publication.visibility')}: </span>
            <span className="font-medium">{t(visibilityLabelKey(response.visibility))}</span>
          </p>

          <div>
            <p className="mb-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">{t('spaceSettings.publication.addresses')}</p>
            <ul className="space-y-1">
              {addresses.map((a) => (
                <li key={a.key} className="flex flex-wrap items-center gap-x-2 text-sm">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">{a.label}</span>
                  {isPublic ? (
                    <a href={a.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-blue-600 hover:underline dark:text-blue-400">
                      {a.url}
                      <ExternalLink size={11} aria-hidden="true" />
                    </a>
                  ) : (
                    <span className="font-mono text-xs text-neutral-500">{a.url}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {!isPublic && <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('spaceSettings.publication.needsPublic')}</p>}

          <Switch
            checked={response.settings.indexing}
            disabled={!isPublic || update.isPending}
            onChange={(indexing) => update.mutate({ indexing })}
            label={t('publish.indexing')}
            hint={t('publish.indexingHint')}
          />

          <div>
            <label htmlFor="settings-primary-host" className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
              {t('publish.primaryHost')}
            </label>
            <select
              id="settings-primary-host"
              value={response.settings.primaryHost}
              disabled={!isPublic || update.isPending}
              onChange={(e) => update.mutate({ primaryHost: e.target.value as PublicPrimaryHost })}
              className="w-full max-w-sm rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-800 outline-none focus:border-neutral-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            >
              {PRIMARY_HOSTS.map((host) => (
                <option key={host} value={host} disabled={(host === 'subdomain' && !response.urls.subdomain) || (host === 'domain' && !response.urls.domain)}>
                  {t(PRIMARY_HOST_LABEL[host])}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('publish.primaryHostHint')}</p>
          </div>
        </div>
      )}

      {dialogOpen && <PublishSpaceDialog space={space} onClose={() => setDialogOpen(false)} />}
    </section>
  );
}
