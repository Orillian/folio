import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Copy } from 'lucide-react';
import {
  publicDomainSchema,
  publicSubdomainSchema,
  type PublicPrimaryHost,
  type SpacePublicSettings,
  type SpacePublicSettingsResponse,
  type SpaceVisibility,
} from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';
import { VisibilityConfirmDialog } from '../admin/access/VisibilityConfirmDialog';
import { VISIBILITY_OPTIONS, makeVisibilityLabelKey, visibilityLabelKey } from '../admin/access/logic';
import '../i18n/register';

export interface PublishSpaceDialogProps {
  space: string;
  onClose: () => void;
}

/** Query key of the dialog's settings; MembersDialog invalidates it when it changes the visibility from its own row, and the space settings page shares it. */
export const publicSettingsKey = (space: string) => ['space-public-settings', space] as const;
const settingsKey = publicSettingsKey;

const PRIMARY_HOSTS: readonly PublicPrimaryHost[] = ['auto', 'path', 'subdomain', 'domain'];
const PRIMARY_HOST_LABEL: Record<PublicPrimaryHost, string> = {
  auto: 'publish.primaryHostAuto',
  path: 'publish.primaryHostPath',
  subdomain: 'publish.primaryHostSubdomain',
  domain: 'publish.primaryHostDomain',
};

const VISIBILITY_HINTS: Record<SpaceVisibility, string> = {
  private: 'publish.visibility.privateHint',
  instance: 'publish.visibility.instanceHint',
  public: 'publish.visibility.publicHint',
};

/** The text of the plain confirm (no access matrix to list people from — only instance admins can read it). */
const CONFIRM_KEYS: Record<SpaceVisibility, { title: string; body: string }> = {
  private: { title: 'members.visibility.confirmPrivateTitle', body: 'members.visibility.confirmPrivateBody' },
  instance: { title: 'members.visibility.confirmInstanceTitle', body: 'members.visibility.confirmInstanceBody' },
  public: { title: 'members.visibility.confirmPublicTitle', body: 'members.visibility.confirmPublicBody' },
};

/** What the visitor typed, turned into the contract's value: blank is `null`; a pasted `https://docs.acme.com/x` keeps only the host. */
function normalizeHost(value: string): string {
  return value.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
}

function sameSettings(a: SpacePublicSettings, b: SpacePublicSettings): boolean {
  return (
    a.subdomain === b.subdomain &&
    a.domain === b.domain &&
    a.allowDownload === b.allowDownload &&
    a.allowAssistant === b.allowAssistant &&
    a.indexing === b.indexing &&
    a.primaryHost === b.primaryHost
  );
}

/**
 * "Publish as website" (space admins; the API is gated the same way). Two parts:
 *   1. who can read the space — private / instance-wide / public, each change confirmed (publishing
 *      says out loud that anyone on the internet can read it);
 *   2. once it is public, how it is reached and what visitors may do: the path URL (always), an
 *      optional subdomain (only where the operator configured PUBLIC_SITES_DOMAIN), an optional
 *      custom domain (needs a CNAME and a proxy route — the hint says which), and the two opt-ins
 *      (download, ask Folio AI).
 * Visibility is saved by its own PATCH on confirm; the rest by one PUT on Save.
 */
export function PublishSpaceDialog({ space, onClose }: PublishSpaceDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const showToast = useToast();

  const { data: spacesData } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const spaceName = spacesData?.spaces.find((s) => s.slug === space)?.name ?? space;

  const settingsQuery = useQuery({ queryKey: settingsKey(space), queryFn: () => api.getSpacePublicSettings(space), retry: false });
  const response = settingsQuery.data;
  const visibility: SpaceVisibility = response?.visibility ?? 'private';
  const isPublic = visibility === 'public';

  // The access matrix only lets the confirm name who LOSES access when going private; it is instance-admin
  // only, so a space admin's 403 simply means the plain confirm below is used.
  const matrixQuery = useQuery({ queryKey: ['access', 'matrix'], queryFn: api.getAccessMatrix, retry: false, staleTime: 60_000 });

  const [visibilityTarget, setVisibilityTarget] = useState<SpaceVisibility | null>(null);
  const setVisibility = useMutation({
    mutationFn: (next: SpaceVisibility) => api.setSpaceVisibility(space, { visibility: next }),
    onSuccess: () => {
      setVisibilityTarget(null);
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['access'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'spaces'] });
      queryClient.invalidateQueries({ queryKey: settingsKey(space) });
      showToast(t('members.visibility.changed'), 'info');
    },
    onError: (err) => {
      setVisibilityTarget(null);
      showToast(errorText(err, 'access.spaces.visibilityFailed'));
    },
  });

  // The form, seeded from the server and re-seeded whenever it answers again (load, save).
  const [subdomain, setSubdomain] = useState('');
  const [domain, setDomain] = useState('');
  const [allowDownload, setAllowDownload] = useState(false);
  const [allowAssistant, setAllowAssistant] = useState(false);
  const [indexing, setIndexing] = useState(true);
  const [primaryHost, setPrimaryHost] = useState<PublicPrimaryHost>('auto');
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    if (!response) return;
    setSubdomain(response.settings.subdomain ?? '');
    setDomain(response.settings.domain ?? '');
    setAllowDownload(response.settings.allowDownload);
    setAllowAssistant(response.settings.allowAssistant);
    setIndexing(response.settings.indexing);
    setPrimaryHost(response.settings.primaryHost);
  }, [response]);

  const subdomainText = subdomain.trim();
  const domainText = normalizeHost(domain);
  const parsedSubdomain = subdomainText ? publicSubdomainSchema.safeParse(subdomainText) : null;
  const parsedDomain = domainText ? publicDomainSchema.safeParse(domainText) : null;
  const subdomainInvalid = parsedSubdomain !== null && !parsedSubdomain.success;
  const domainInvalid = parsedDomain !== null && !parsedDomain.success;

  // A primary address that is not (or no longer) filled in falls back to 'auto' instead of being sent as a dangling choice.
  const effectivePrimaryHost: PublicPrimaryHost =
    (primaryHost === 'subdomain' && !subdomainText) || (primaryHost === 'domain' && !domainText) ? 'auto' : primaryHost;

  const draft: SpacePublicSettings = useMemo(
    () => ({
      subdomain: parsedSubdomain?.success ? parsedSubdomain.data : null,
      domain: parsedDomain?.success ? parsedDomain.data : null,
      allowDownload,
      allowAssistant,
      indexing,
      primaryHost: effectivePrimaryHost,
    }),
    [parsedSubdomain, parsedDomain, allowDownload, allowAssistant, indexing, effectivePrimaryHost],
  );
  const dirty = response ? !sameSettings(draft, response.settings) : false;

  const save = useMutation({
    mutationFn: () => api.updateSpacePublicSettings(space, draft),
    onSuccess: (saved: SpacePublicSettingsResponse) => {
      setSaveError(null);
      queryClient.setQueryData(settingsKey(space), saved);
      showToast(t('publish.saved'), 'info');
    },
    // 'subdomain is already taken' / 'domain is already in use' / 400 invalid are mapped in errorText.ts.
    onError: (err) => setSaveError(errorText(err, 'publish.saveFailed')),
  });

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      showToast(t('share.linkCopied'), 'info');
    } catch {
      showToast(t('share.copyFailed'));
    }
  }

  const sitesDomain = response?.sitesDomain ?? null;
  const fieldClass =
    'w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-800 outline-none focus:border-neutral-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100';

  return (
    <Modal
      title={t('publish.title', { space: spaceName })}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {t('ui.close')}
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={!isPublic || !dirty || subdomainInvalid || domainInvalid || save.isPending}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            {save.isPending ? t('ui.pleaseWait') : t('publish.save')}
          </button>
        </>
      }
    >
      {settingsQuery.isLoading && <p className="text-neutral-400">{t('ui.loading')}</p>}
      {settingsQuery.isError && (
        <p className="text-red-600 dark:text-red-400">
          {errorText(settingsQuery.error, 'publish.loadFailed')}{' '}
          <button type="button" onClick={() => void settingsQuery.refetch()} className="underline underline-offset-2">
            {t('auth.retry')}
          </button>
        </p>
      )}

      {response && (
        <div className="space-y-6">
          <section aria-labelledby="publish-visibility">
            <h3 id="publish-visibility" className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              {t('publish.visibility.heading')}
            </h3>
            <div role="radiogroup" aria-labelledby="publish-visibility" className="space-y-1.5">
              {VISIBILITY_OPTIONS.map((option) => (
                <label
                  key={option}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 ${
                    option === visibility
                      ? 'border-neutral-400 bg-neutral-50 dark:border-neutral-500 dark:bg-neutral-800/60'
                      : 'border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/40'
                  }`}
                >
                  <input
                    type="radio"
                    name="publish-visibility"
                    value={option}
                    checked={option === visibility}
                    onChange={() => {
                      if (option !== visibility) setVisibilityTarget(option);
                    }}
                    className="mt-1"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-100">{t(visibilityLabelKey(option))}</span>
                    <span className="block text-xs text-neutral-500 dark:text-neutral-400">{t(VISIBILITY_HINTS[option])}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section aria-labelledby="publish-site" className={isPublic ? undefined : 'opacity-60'}>
            <h3 id="publish-site" className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              {t('publish.site.heading')}
            </h3>
            {!isPublic && <p className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">{t('publish.site.needsPublic')}</p>}

            <div className="space-y-4">
              <div>
                <label htmlFor="publish-path-url" className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                  {t('publish.site.pathUrl')}
                </label>
                <UrlRow id="publish-path-url" url={response.urls.path} disabled={!isPublic} onCopy={copy} copyLabel={t('ui.copy')} fieldClass={fieldClass} />
              </div>

              {sitesDomain !== null && (
                <div>
                  <label htmlFor="publish-subdomain" className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                    {t('publish.site.subdomain')}
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      id="publish-subdomain"
                      value={subdomain}
                      disabled={!isPublic}
                      onChange={(e) => setSubdomain(e.target.value)}
                      placeholder={t('publish.site.subdomainPlaceholder')}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      aria-invalid={subdomainInvalid}
                      className={fieldClass}
                    />
                    <span className="shrink-0 text-sm text-neutral-500 dark:text-neutral-400">.{sitesDomain}</span>
                  </div>
                  {subdomainInvalid && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t('publish.site.subdomainInvalid')}</p>}
                  {response.urls.subdomain && !dirty && (
                    <div className="mt-1.5">
                      <UrlRow url={response.urls.subdomain} disabled={!isPublic} onCopy={copy} copyLabel={t('ui.copy')} fieldClass={fieldClass} />
                    </div>
                  )}
                </div>
              )}

              <div>
                <label htmlFor="publish-domain" className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                  {t('publish.site.domain')}
                </label>
                <input
                  id="publish-domain"
                  value={domain}
                  disabled={!isPublic}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="docs.example.com"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={domainInvalid}
                  className={fieldClass}
                />
                {domainInvalid && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t('publish.site.domainInvalid')}</p>}
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('publish.site.domainHint', { mainHost: response.mainHost })}</p>
                {response.urls.domain && !dirty && (
                  <div className="mt-1.5">
                    <UrlRow url={response.urls.domain} disabled={!isPublic} onCopy={copy} copyLabel={t('ui.copy')} fieldClass={fieldClass} />
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <label className="flex cursor-pointer items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                  <input
                    type="checkbox"
                    checked={allowDownload}
                    disabled={!isPublic}
                    onChange={(e) => setAllowDownload(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>{t('publish.site.allowDownload')}</span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                  <input
                    type="checkbox"
                    checked={allowAssistant}
                    disabled={!isPublic}
                    onChange={(e) => setAllowAssistant(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>{t('publish.site.allowAssistant')}</span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                  <input
                    type="checkbox"
                    checked={indexing}
                    disabled={!isPublic}
                    onChange={(e) => setIndexing(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>{t('publish.indexing')}</span>
                </label>
              </div>

              <div>
                <label htmlFor="publish-primary-host" className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                  {t('publish.primaryHost')}
                </label>
                <select
                  id="publish-primary-host"
                  value={effectivePrimaryHost}
                  disabled={!isPublic}
                  onChange={(e) => setPrimaryHost(e.target.value as PublicPrimaryHost)}
                  className={fieldClass}
                >
                  {PRIMARY_HOSTS.map((host) => (
                    <option
                      key={host}
                      value={host}
                      disabled={(host === 'subdomain' && !subdomainText) || (host === 'domain' && !domainText)}
                    >
                      {t(PRIMARY_HOST_LABEL[host])}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('publish.primaryHostHint')}</p>
              </div>

              <Link
                to={`/s/${encodeURIComponent(space)}/settings?tab=site`}
                onClick={onClose}
                className="inline-block text-sm text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
              >
                {t('publish.appearanceLink')}
              </Link>

              {saveError && (
                <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {saveError}
                </p>
              )}
            </div>
          </section>
        </div>
      )}

      {visibilityTarget &&
        (matrixQuery.data ? (
          <VisibilityConfirmDialog
            matrix={matrixQuery.data}
            space={space}
            spaceName={spaceName}
            next={visibilityTarget}
            current={visibility}
            busy={setVisibility.isPending}
            onCancel={() => setVisibilityTarget(null)}
            onConfirm={() => setVisibility.mutate(visibilityTarget)}
          />
        ) : (
          <ConfirmDialog
            title={t(CONFIRM_KEYS[visibilityTarget].title, { space: spaceName })}
            confirmLabel={t(makeVisibilityLabelKey(visibilityTarget))}
            busy={setVisibility.isPending}
            onCancel={() => setVisibilityTarget(null)}
            onConfirm={() => setVisibility.mutate(visibilityTarget)}
          >
            {t(CONFIRM_KEYS[visibilityTarget].body)}
          </ConfirmDialog>
        ))}
    </Modal>
  );
}

/** A read-only URL with its Copy button. */
function UrlRow({
  id,
  url,
  disabled,
  onCopy,
  copyLabel,
  fieldClass,
}: {
  id?: string;
  url: string;
  disabled: boolean;
  onCopy: (url: string) => void;
  copyLabel: string;
  fieldClass: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input id={id} readOnly value={url} disabled={disabled} onFocus={(e) => e.currentTarget.select()} className={`${fieldClass} font-mono text-xs`} />
      <button
        type="button"
        onClick={() => onCopy(url)}
        disabled={disabled}
        aria-label={`${copyLabel}: ${url}`}
        className="flex shrink-0 items-center gap-1 rounded-md border border-neutral-300 px-2 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        <Copy size={13} aria-hidden="true" /> {copyLabel}
      </button>
    </div>
  );
}
