import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, Copy, KeyRound } from 'lucide-react';
import type { AuthProviderInfo, ScimStatusInfo } from '@shared/contracts';
import { api } from '../../api';
import { useApiErrorText } from '../../errorText';
import { formatDateTime } from '../../formatDate';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';

const BUTTON = 'rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800';

/** The audit screen filtered to SCIM events. */
export const SCIM_AUDIT_LINK = '/admin/audit?action=scim.';

/**
 * A provider card's "SCIM provisioning" section (server/scim/routes.ts): the base URL to paste at the identity
 * provider, the bearer token (generated or rotated here, shown once), the last sync, how many people and groups
 * the provider manages, and a link to the SCIM audit events. While SCIM is on, JIT account creation is off.
 */
export function ScimPanel({ provider }: { provider: AuthProviderInfo }) {
  const { t, i18n } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'rotate' | 'revoke' | null>(null);
  const key = ['admin', 'auth-providers', provider.id, 'scim'] as const;
  const status = useQuery({ queryKey: key, queryFn: () => api.getScimStatus(provider.id), enabled: open, retry: false });

  const afterChange = (next: ScimStatusInfo) => {
    queryClient.setQueryData(key, next);
    void queryClient.invalidateQueries({ queryKey: ['admin', 'auth-providers'], exact: true });
  };
  const generate = useMutation({
    mutationFn: () => api.createScimToken(provider.id),
    onSuccess: (created) => {
      setConfirm(null);
      setNewToken(created.token);
      afterChange(created.status);
      if (created.jitDisabled) showToast(t('scimAdmin.jitTurnedOff'));
    },
    onError: (err) => showToast(errorText(err, 'scimAdmin.saveFailed')),
  });
  const revoke = useMutation({
    mutationFn: () => api.revokeScimToken(provider.id),
    onSuccess: (next) => {
      setConfirm(null);
      setNewToken(null);
      afterChange(next);
    },
    onError: (err) => showToast(errorText(err, 'scimAdmin.saveFailed')),
  });
  const enabled = status.data?.enabled ?? provider.scimEnabled ?? false;

  return (
    <div className="mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-sm font-medium text-neutral-800 dark:text-neutral-200"
      >
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        {t('scimAdmin.title')}
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-normal ${enabled ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300' : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'}`}
        >
          {enabled ? t('ssoAdmin.enabled') : t('ssoAdmin.disabled')}
        </span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('scimAdmin.intro')}</p>
          {status.isPending && <p className="text-xs text-neutral-400">{t('ui.loading')}</p>}
          {status.isError && <p className="text-xs text-red-600 dark:text-red-400">{t('scimAdmin.loadFailed')}</p>}
          {status.data && (
            <>
              <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[10rem_1fr]">
                <dt className="text-neutral-500">{t('scimAdmin.baseUrl')}</dt>
                <CopyValue value={status.data.baseUrl} />
                <dt className="text-neutral-500">{t('scimAdmin.token')}</dt>
                <dd className="text-neutral-800 dark:text-neutral-200">
                  {status.data.token
                    ? t('scimAdmin.tokenActive', { prefix: status.data.token.prefix, date: formatDateTime(status.data.token.createdAt, i18n.language) })
                    : t('scimAdmin.noToken')}
                </dd>
                <dt className="text-neutral-500">{t('scimAdmin.lastSync')}</dt>
                <dd className="text-neutral-800 dark:text-neutral-200">{status.data.lastSyncAt ? formatDateTime(status.data.lastSyncAt, i18n.language) : t('scimAdmin.never')}</dd>
                <dt className="text-neutral-500">{t('scimAdmin.provisioned')}</dt>
                <dd className="text-neutral-800 dark:text-neutral-200">
                  {t('scimAdmin.users', { count: status.data.users })} · {t('scimAdmin.groups', { count: status.data.groups })}
                </dd>
              </dl>
              {newToken && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950">
                  <p className="mb-1 text-amber-900 dark:text-amber-200">{t('scimAdmin.shownOnce')}</p>
                  <CopyValue value={newToken} as="div" />
                </div>
              )}
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{enabled ? t('scimAdmin.jitNote') : t('scimAdmin.jitNoteOff')}</p>
              {status.data.jitIgnored && <p className="text-xs text-amber-700 dark:text-amber-400">{t('scimAdmin.jitIgnored')}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={`${BUTTON} inline-flex items-center gap-1.5`} disabled={generate.isPending} onClick={() => (enabled ? setConfirm('rotate') : generate.mutate())}>
                  <KeyRound size={13} aria-hidden="true" /> {enabled ? t('scimAdmin.rotate') : t('scimAdmin.generate')}
                </button>
                {enabled && (
                  <button type="button" className="rounded-md px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950" onClick={() => setConfirm('revoke')}>
                    {t('scimAdmin.revoke')}
                  </button>
                )}
                <Link to={SCIM_AUDIT_LINK} className="text-xs text-neutral-600 underline hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100">
                  {t('scimAdmin.auditLink')}
                </Link>
              </div>
            </>
          )}
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm === 'rotate' ? t('scimAdmin.rotateTitle') : t('scimAdmin.revokeTitle')}
          destructive
          confirmLabel={confirm === 'rotate' ? t('scimAdmin.rotate') : t('scimAdmin.revoke')}
          busy={generate.isPending || revoke.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => (confirm === 'rotate' ? generate.mutate() : revoke.mutate())}
        >
          {confirm === 'rotate' ? t('scimAdmin.rotateBody') : t('scimAdmin.revokeBody')}
        </ConfirmDialog>
      )}
    </div>
  );
}

function CopyValue({ value, as = 'dd' }: { value: string; as?: 'dd' | 'div' }) {
  const { t } = useTranslation('app');
  const [copied, setCopied] = useState(false);
  const Tag = as;
  return (
    <Tag className="flex min-w-0 items-center gap-1">
      <code className="truncate rounded bg-neutral-100 px-1.5 py-0.5 font-mono dark:bg-neutral-800" title={value}>
        {value}
      </code>
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
    </Tag>
  );
}
