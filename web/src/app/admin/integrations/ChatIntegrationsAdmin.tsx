import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, Copy, Download, Trash2, X } from 'lucide-react';
import type { AdminChatLinkInfo, ChatPlatform, ChatPlatformStatus } from '@shared/contracts';
import { api, ApiError } from '../../api';
import { useApiErrorText } from '../../errorText';
import { formatRelativeDate } from '../../history';
import { useDocumentTitle } from '../../hooks';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import '../../i18n/register';

const STATUS_KEY = ['admin', 'chat-integrations'] as const;
const LINKS_KEY = ['admin', 'chat-links'] as const;
const PLATFORM_LABEL: Record<ChatPlatform, string> = { slack: 'Slack', teams: 'Microsoft Teams' };

/**
 * `/admin/integrations` — instance admin: link previews in Slack and Microsoft Teams. Per platform:
 * configured or not (which environment variables are present — never their values), the URLs to
 * paste into the platform's settings, the domains previews are registered for, the Slack manifest
 * and the Teams app package to download, and how many people connected. Below, every link, with a
 * disconnect. The server checks instance admin on every endpoint (403 → "no access" here).
 */
export function ChatIntegrationsAdmin() {
  const { t } = useTranslation('app');
  useDocumentTitle(t('chatAdmin.title'));
  const status = useQuery({ queryKey: STATUS_KEY, queryFn: api.getChatIntegrations, retry: false });

  return (
    <div className="h-full overflow-y-auto bg-white dark:bg-neutral-950">
      <header className="flex h-14 items-center gap-2 border-b border-neutral-200 px-3 dark:border-neutral-800 md:gap-3 md:px-4">
        <Link
          to="/"
          aria-label={t('ui.back')}
          className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 max-md:min-h-10 max-md:min-w-10 dark:hover:bg-neutral-800"
        >
          <ArrowLeft size={17} />
        </Link>
        <h1 className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('chatAdmin.title')}</h1>
      </header>
      <main className="mx-auto flex max-w-4xl flex-col gap-6 p-4 md:p-6">
        {status.isPending && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}
        {status.isError &&
          (status.error instanceof ApiError && status.error.status === 403 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('admin.noAccess')}</p>
          ) : (
            <p className="text-sm text-red-600 dark:text-red-400">{t('chatAdmin.loadFailed')}</p>
          ))}
        {status.data && (
          <>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('chatAdmin.intro')}</p>
            <PlatformCard platform="slack" status={status.data.slack} />
            <PlatformCard platform="teams" status={status.data.teams} />
            <LinkedPeople />
          </>
        )}
      </main>
    </div>
  );
}

function PlatformCard({ platform, status }: { platform: ChatPlatform; status: ChatPlatformStatus }) {
  const { t } = useTranslation('app');
  const download =
    platform === 'slack'
      ? { href: '/api/admin/integrations/chat/slack-manifest.yaml', file: 'folio-slack-manifest.yaml', label: t('chatAdmin.slackManifest'), enabled: true }
      : { href: '/api/admin/integrations/chat/teams-package.zip', file: 'folio-teams-app.zip', label: t('chatAdmin.teamsPackage'), enabled: status.env.FOLIO_TEAMS_APP_ID === true };
  return (
    <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{PLATFORM_LABEL[platform]}</h2>
        <span
          className={
            status.configured
              ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800 dark:bg-green-950 dark:text-green-300'
              : 'rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'
          }
        >
          {status.configured ? t('chatAdmin.configured') : t('chatAdmin.notConfigured')}
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('chatAdmin.linkedUsers', { count: status.linkedUsers })}</span>
      </div>

      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">{t('chatAdmin.env')}</h3>
      <ul className="mb-3 grid gap-1 sm:grid-cols-2">
        {Object.entries(status.env).map(([name, present]) => (
          <li key={name} className="flex items-center gap-1.5 font-mono text-xs text-neutral-700 dark:text-neutral-300">
            {present ? <Check size={13} className="text-green-600" aria-label={t('chatAdmin.present')} /> : <X size={13} className="text-neutral-400" aria-label={t('chatAdmin.missing')} />}
            {name}
          </li>
        ))}
      </ul>

      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">{t('chatAdmin.endpoints')}</h3>
      <dl className="mb-3 flex flex-col gap-1.5">
        {Object.entries(status.endpoints).map(([key, url]) => (
          <div key={key} className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
            <dt className="shrink-0 text-xs text-neutral-500 sm:w-48">{t(`chatAdmin.endpoint.${key}`, { defaultValue: key })}</dt>
            <dd className="flex min-w-0 items-center gap-1">
              <code className="truncate rounded bg-neutral-100 px-1.5 py-0.5 text-xs dark:bg-neutral-800">{url}</code>
              <CopyButton value={url} />
            </dd>
          </div>
        ))}
      </dl>

      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">{t('chatAdmin.domains')}</h3>
      <p className="mb-3 font-mono text-xs text-neutral-700 dark:text-neutral-300">{status.domains.join(', ')}</p>

      {download.enabled ? (
        <a
          href={download.href}
          download={download.file}
          className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <Download size={14} aria-hidden="true" /> {download.label}
        </a>
      ) : (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('chatAdmin.teamsPackageNeedsId')}</p>
      )}
    </section>
  );
}

function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation('app');
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      aria-label={t('chatAdmin.copy')}
      title={t('chatAdmin.copy')}
      className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function LinkedPeople() {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [removing, setRemoving] = useState<AdminChatLinkInfo | null>(null);
  const links = useQuery({ queryKey: LINKS_KEY, queryFn: api.listAdminChatLinks, retry: false });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAdminChatLink(id),
    onSuccess: () => {
      setRemoving(null);
      void queryClient.invalidateQueries({ queryKey: LINKS_KEY });
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onError: (err) => showToast(errorText(err, 'chatAdmin.disconnectFailed')),
  });

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('chatAdmin.people')}</h2>
      {links.data && links.data.links.length === 0 && <p className="text-sm text-neutral-400">{t('chatAdmin.noPeople')}</p>}
      {links.data && links.data.links.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {links.data.links.map((link) => (
            <li key={link.id} className="flex items-center gap-2 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-neutral-900 dark:text-neutral-100">
                  {link.userName} <span className="text-neutral-500">· {link.userEmail}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                  <span>{PLATFORM_LABEL[link.platform]}</span>
                  {link.platformUserName && <span>· {link.platformUserName}</span>}
                  <span>· {t('tokens.createdAt', { date: formatRelativeDate(link.createdAt) })}</span>
                  <span>· {link.lastUsedAt ? t('tokens.lastUsedAt', { date: formatRelativeDate(link.lastUsedAt) }) : t('tokens.neverUsed')}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRemoving(link)}
                aria-label={t('chatAdmin.disconnectNamed', { name: link.userName })}
                title={t('tokens.connected.disconnect')}
                className="shrink-0 rounded p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {removing && (
        <ConfirmDialog
          title={t('chatAdmin.confirmTitle')}
          destructive
          confirmLabel={t('tokens.connected.disconnect')}
          busy={remove.isPending}
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing.id)}
        >
          {t('chatAdmin.confirmBody', { name: removing.userName, platform: PLATFORM_LABEL[removing.platform] })}
        </ConfirmDialog>
      )}
    </section>
  );
}
