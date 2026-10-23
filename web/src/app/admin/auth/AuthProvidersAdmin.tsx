import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import type { AuthProviderBody, AuthProviderInfo, SamlNameIdFormat, SpaceRole, SsoGroupSync, SsoProviderKind, SsoTestResult } from '@shared/contracts';
import { api, ApiError } from '../../api';
import { useApiErrorText } from '../../errorText';
import { useDocumentTitle } from '../../hooks';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { LabeledInput } from '../../ui/LabeledInput';
import { Modal } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';
import '../../i18n/register';
import { ScimPanel } from './ScimPanel';

const KEY = ['admin', 'auth-providers'] as const;

/** "docs:editor, eng" -> { docs: 'editor', eng: 'viewer' }; the inverse for the form. */
export function parseSpacesField(raw: string): Record<string, SpaceRole> {
  const out: Record<string, SpaceRole> = {};
  for (const part of raw.split(',')) {
    const [slug, role] = part.split(':').map((s) => s.trim());
    if (!slug) continue;
    out[slug] = role === 'admin' || role === 'editor' ? role : 'viewer';
  }
  return out;
}
export function formatSpacesField(spaces: Record<string, SpaceRole>): string {
  return Object.entries(spaces)
    .map(([slug, role]) => `${slug}:${role}`)
    .join(', ');
}

/** "Engineering = eng" per line (or comma separated) -> { Engineering: 'eng' }; the inverse for the form. Lines without a valid Folio group slug are dropped. */
export function parseGroupMapField(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(/[\n,]/)) {
    const at = part.lastIndexOf('=');
    if (at < 1) continue;
    const idp = part.slice(0, at).trim();
    const target = part.slice(at + 1).trim();
    if (idp && /^[a-z0-9][a-z0-9-]{0,62}$/.test(target)) out[idp] = target;
  }
  return out;
}
export function formatGroupMapField(mapping: Record<string, string>): string {
  return Object.entries(mapping)
    .map(([idp, slug]) => `${idp} = ${slug}`)
    .join('\n');
}

/** Where "Test connection" starts: the protocol's start URL with ?test=1. */
export function testUrlFor(p: Pick<AuthProviderInfo, 'slug' | 'kind'>): string {
  return `/api/auth/${p.kind === 'saml' ? 'saml' : 'oidc'}/${encodeURIComponent(p.slug)}/start?test=1`;
}

/**
 * `/admin/auth` — instance admin: single sign-on providers (OpenID Connect and SAML 2.0, docs/AUTH.md). Add, edit,
 * enable or disable, delete; "Test connection" runs a real sign-in in a popup and shows the claims / attributes the
 * provider sent, with nothing created or linked. Providers defined by environment variables are read-only here. The server checks
 * instance admin on every endpoint (403 -> "no access").
 */
export function AuthProvidersAdmin() {
  const { t } = useTranslation('app');
  useDocumentTitle(t('ssoAdmin.title'));
  const list = useQuery({ queryKey: KEY, queryFn: api.listAuthProviders, retry: false });
  const [editing, setEditing] = useState<AuthProviderInfo | 'new' | null>(null);
  const [testResult, setTestResult] = useState<{ slug: string; result: SsoTestResult } | null>(null);

  // The popup (server/auth/oidc.ts renderTestResult) posts its result here.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; result?: SsoTestResult; slug?: string } | null;
      if (data?.type === 'folio-sso-test' && data.result) setTestResult((prev) => ({ slug: prev?.slug ?? '', result: data.result! }));
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  function runTest(p: AuthProviderInfo) {
    setTestResult({ slug: p.slug, result: { ok: false, error: t('ssoAdmin.testWaiting') } });
    window.open(testUrlFor(p), 'folio-sso-test', 'width=520,height=680');
  }

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
        <h1 className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('ssoAdmin.title')}</h1>
        <div className="flex-1" />
        {list.data && (
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            <Plus size={14} aria-hidden="true" /> {t('ssoAdmin.add')}
          </button>
        )}
      </header>
      <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 md:p-6">
        {list.isPending && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}
        {list.isError &&
          (list.error instanceof ApiError && list.error.status === 403 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('admin.noAccess')}</p>
          ) : (
            <p className="text-sm text-red-600 dark:text-red-400">{t('ssoAdmin.loadFailed')}</p>
          ))}
        {list.data && (
          <>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('ssoAdmin.intro')}</p>
            {!list.data.secretConfigured && <p className="text-xs text-amber-700 dark:text-amber-400">{t('ssoAdmin.noFolioSecret')}</p>}
            {list.data.providers.length === 0 && <p className="text-sm text-neutral-400">{t('ssoAdmin.empty')}</p>}
            {list.data.providers.map((p) => (
              <ProviderCard key={p.id} provider={p} onEdit={() => setEditing(p)} onTest={() => runTest(p)} />
            ))}
          </>
        )}
        {testResult && (
          <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('ssoAdmin.testTitle', { slug: testResult.slug })}</h2>
              <div className="flex-1" />
              <button type="button" onClick={() => setTestResult(null)} className="text-xs text-neutral-500 hover:underline">
                {t('ui.close')}
              </button>
            </div>
            {testResult.result.ok ? (
              <>
                <p className="mb-2 text-sm text-green-700 dark:text-green-400">{t('ssoAdmin.testOk')}</p>
                <pre className="mb-2 overflow-x-auto rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-900">{JSON.stringify(testResult.result.mapped, null, 2)}</pre>
                <details>
                  <summary className="cursor-pointer text-xs text-neutral-500">{t('ssoAdmin.testClaims')}</summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-900">{JSON.stringify(testResult.result.claims, null, 2)}</pre>
                </details>
              </>
            ) : (
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{testResult.result.error}</p>
            )}
          </section>
        )}
      </main>
      {editing && <ProviderDialog provider={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ProviderCard({ provider: p, onEdit, onTest }: { provider: AuthProviderInfo; onEdit: () => void; onTest: () => void }) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const readOnly = p.source === 'env';
  const toggle = useMutation({
    mutationFn: () => api.updateAuthProvider(p.id, { enabled: !p.enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
    onError: (err) => showToast(errorText(err, 'ssoAdmin.saveFailed')),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAuthProvider(p.id),
    onSuccess: () => {
      setConfirmDelete(false);
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (err) => showToast(errorText(err, 'ssoAdmin.deleteFailed')),
  });
  const badge = 'rounded-full px-2 py-0.5 text-xs';

  return (
    <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{p.displayName}</h2>
        <code className="text-xs text-neutral-500">{p.slug}</code>
        <span className={`${badge} bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300`}>{p.kind === 'saml' ? 'SAML' : 'OIDC'}</span>
        <span className={`${badge} ${p.enabled ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300' : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'}`}>
          {p.enabled ? t('ssoAdmin.enabled') : t('ssoAdmin.disabled')}
        </span>
        {readOnly && <span className={`${badge} bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300`}>{t('ssoAdmin.fromEnv')}</span>}
        {p.enforceSso && <span className={`${badge} bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300`}>{t('ssoAdmin.enforced')}</span>}
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('ssoAdmin.identities', { count: p.identities })}</span>
      </div>
      <dl className="mb-3 grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[10rem_1fr]">
        {p.kind === 'saml' && p.samlSp ? (
          <>
            <dt className="text-neutral-500">{p.saml?.idpEntityId || !p.saml?.metadataUrl ? t('ssoAdmin.saml.idpEntityId') : t('ssoAdmin.saml.metadataUrl')}</dt>
            <dd className="break-all font-mono text-neutral-800 dark:text-neutral-200">{p.issuer || '—'}</dd>
            <dt className="text-neutral-500">{t('ssoAdmin.saml.spEntityId')}</dt>
            <CopyCell value={p.samlSp.entityId} />
            <dt className="text-neutral-500">{t('ssoAdmin.saml.acsUrl')}</dt>
            <CopyCell value={p.samlSp.acsUrl} />
            <dt className="text-neutral-500">{t('ssoAdmin.saml.spMetadataUrl')}</dt>
            <CopyCell value={p.samlSp.metadataUrl} />
          </>
        ) : (
          <>
            <dt className="text-neutral-500">{t('ssoAdmin.field.issuer')}</dt>
            <dd className="break-all font-mono text-neutral-800 dark:text-neutral-200">{p.issuer}</dd>
            <dt className="text-neutral-500">{t('ssoAdmin.field.clientId')}</dt>
            <dd className="break-all font-mono text-neutral-800 dark:text-neutral-200">
              {p.clientId || '—'} {p.hasClientSecret ? `· ${t('ssoAdmin.secretSet')}` : `· ${t('ssoAdmin.secretNone')}`}
            </dd>
            <dt className="text-neutral-500">{t('ssoAdmin.redirectUri')}</dt>
            <CopyCell value={p.redirectUri} />
          </>
        )}
        <dt className="text-neutral-500">{t('ssoAdmin.field.domains')}</dt>
        <dd className="text-neutral-800 dark:text-neutral-200">{p.allowedDomains.length ? p.allowedDomains.join(', ') : t('ssoAdmin.anyDomain')}</dd>
        <dt className="text-neutral-500">{t('ssoAdmin.field.jit')}</dt>
        <dd className="text-neutral-800 dark:text-neutral-200">
          {p.scimEnabled ? t('scimAdmin.jitOffScim') : p.jitEnabled ? t('ssoAdmin.jitOn') : t('ssoAdmin.jitOff')}
          {p.jitEnabled && Object.keys(p.jitDefaultSpaces).length > 0 && ` · ${formatSpacesField(p.jitDefaultSpaces)}`}
        </dd>
        <dt className="text-neutral-500">{t('ssoAdmin.groupSync.title')}</dt>
        <dd className="text-neutral-800 dark:text-neutral-200">
          {p.groupSync.enabled
            ? `${t('ssoAdmin.groupSync.on')} · ${p.claimMapping.groups ?? 'groups'} · ${p.groupSync.mode === 'mapping' ? t('ssoAdmin.groupSync.modeMapping') : t('ssoAdmin.groupSync.modeName')}`
            : t('ssoAdmin.groupSync.off')}
        </dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onTest} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">
          {t('ssoAdmin.test')}
        </button>
        {!readOnly && (
          <>
            <button type="button" onClick={onEdit} className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">
              <Pencil size={13} aria-hidden="true" /> {t('ssoAdmin.edit')}
            </button>
            <button
              type="button"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate()}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {p.enabled ? t('ssoAdmin.disable') : t('ssoAdmin.enable')}
            </button>
          </>
        )}
        {(!readOnly || !p.enabled) && (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
          >
            <Trash2 size={13} aria-hidden="true" /> {t('ssoAdmin.delete')}
          </button>
        )}
      </div>
      {readOnly && <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">{t('ssoAdmin.envHint')}</p>}
      <ScimPanel provider={p} />
      {confirmDelete && (
        <ConfirmDialog
          title={t('ssoAdmin.deleteTitle', { name: p.displayName })}
          destructive
          confirmLabel={t('ssoAdmin.delete')}
          busy={remove.isPending}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => remove.mutate()}
        >
          {t('ssoAdmin.deleteBody', { count: p.identities })}
        </ConfirmDialog>
      )}
    </section>
  );
}

function CopyCell({ value }: { value: string }) {
  return (
    <dd className="flex min-w-0 items-center gap-1">
      <code className="truncate rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800" title={value}>
        {value}
      </code>
      <CopyButton value={value} />
    </dd>
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

function Checkbox({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="text-neutral-800 dark:text-neutral-200">{label}</span>
        {hint && <span className="block text-xs text-neutral-500 dark:text-neutral-400">{hint}</span>}
      </span>
    </label>
  );
}

function LabeledTextarea({ label, value, onChange, placeholder, rows = 4 }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-600 dark:text-neutral-400">{label}</span>
      <textarea
        value={value}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 font-mono text-xs text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:text-neutral-100"
      />
    </label>
  );
}

function ProviderDialog({ provider, onClose }: { provider: AuthProviderInfo | null; onClose: () => void }) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<SsoProviderKind>(provider?.kind ?? 'oidc');
  const isSaml = kind === 'saml';
  const saml = provider?.saml;
  const [metadataUrl, setMetadataUrl] = useState(saml?.metadataUrl ?? '');
  const [metadataXml, setMetadataXml] = useState(saml?.metadataXml ?? '');
  const [idpEntityId, setIdpEntityId] = useState(saml?.idpEntityId ?? '');
  const [ssoUrl, setSsoUrl] = useState(saml?.ssoUrl ?? '');
  const [idpCert, setIdpCert] = useState(saml?.idpCert ?? '');
  const [spEntityId, setSpEntityId] = useState(saml?.spEntityId ?? '');
  const [nameIdFormat, setNameIdFormat] = useState<SamlNameIdFormat>(saml?.nameIdFormat ?? 'persistent');
  const [emailAuthoritative, setEmailAuthoritative] = useState(saml?.emailAuthoritative ?? false);
  const [allowIdpInitiated, setAllowIdpInitiated] = useState(saml?.allowIdpInitiated ?? false);
  const [displayName, setDisplayName] = useState(provider?.displayName ?? '');
  const [slug, setSlug] = useState(provider?.slug ?? '');
  const [issuer, setIssuer] = useState(provider?.issuer ?? '');
  const [clientId, setClientId] = useState(provider?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [scopes, setScopes] = useState(provider?.scopes ?? 'openid email profile');
  const [domains, setDomains] = useState((provider?.allowedDomains ?? []).join(', '));
  const [jitEnabled, setJitEnabled] = useState(provider?.jitEnabled ?? false);
  const [jitSpaces, setJitSpaces] = useState(formatSpacesField(provider?.jitDefaultSpaces ?? {}));
  const [enforceSso, setEnforceSso] = useState(provider?.enforceSso ?? false);
  const [emailClaim, setEmailClaim] = useState(provider?.claimMapping.email ?? 'email');
  const [nameClaim, setNameClaim] = useState(provider?.claimMapping.name ?? 'name');
  const [groupsClaim, setGroupsClaim] = useState(provider?.claimMapping.groups ?? 'groups');
  const [syncEnabled, setSyncEnabled] = useState(provider?.groupSync.enabled ?? false);
  const [syncMode, setSyncMode] = useState<SsoGroupSync['mode']>(provider?.groupSync.mode ?? 'name');
  const [syncMapping, setSyncMapping] = useState(formatGroupMapField(provider?.groupSync.mapping ?? {}));
  const [syncCreate, setSyncCreate] = useState(provider?.groupSync.createMissing ?? false);
  const [syncAllow, setSyncAllow] = useState(provider?.groupSync.allow ?? '');

  const save = useMutation({
    mutationFn: () => {
      const common = {
        slug: slug.trim(),
        displayName: displayName.trim(),
        allowedDomains: domains
          .split(/[\s,]+/)
          .map((d) => d.trim().replace(/^@/, ''))
          .filter(Boolean),
        jitEnabled,
        jitDefaultSpaces: parseSpacesField(jitSpaces),
        enforceSso,
        claimMapping: { email: emailClaim.trim() || undefined, name: nameClaim.trim() || undefined, groups: groupsClaim.trim() || undefined },
        groupSync: { enabled: syncEnabled, mode: syncMode, mapping: parseGroupMapField(syncMapping), createMissing: syncCreate, allow: syncAllow.trim() },
      };
      const body: AuthProviderBody = isSaml
        ? {
            ...common,
            ...(provider ? {} : { kind: 'saml' as const }),
            saml: {
              metadataUrl: metadataUrl.trim(),
              metadataXml: metadataXml.trim(),
              idpEntityId: idpEntityId.trim(),
              ssoUrl: ssoUrl.trim(),
              idpCert: idpCert.trim(),
              spEntityId: spEntityId.trim(),
              nameIdFormat,
              emailAuthoritative,
              allowIdpInitiated,
            },
          }
        : {
            ...common,
            issuer: issuer.trim(),
            clientId: clientId.trim(),
            scopes: scopes.trim() || undefined,
            ...(clientSecret ? { clientSecret } : {}),
          };
      return provider ? api.updateAuthProvider(provider.id, body) : api.createAuthProvider(body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!save.isPending) save.mutate();
  }

  return (
    <Modal
      title={provider ? t('ssoAdmin.editTitle', { name: provider.displayName }) : t('ssoAdmin.addTitle')}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
            {t('ui.cancel')}
          </button>
          <button
            type="submit"
            form="sso-provider-form"
            disabled={save.isPending}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {save.isPending ? t('ssoAdmin.saving') : t('ssoAdmin.save')}
          </button>
        </>
      }
    >
      <form id="sso-provider-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        {!provider && (
          <fieldset className="flex flex-wrap items-center gap-4 text-sm sm:col-span-2">
            <legend className="mb-1 text-neutral-600 dark:text-neutral-400">{t('ssoAdmin.field.kind')}</legend>
            {(['oidc', 'saml'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="radio" name="sso-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
                <span className="text-neutral-800 dark:text-neutral-200">{t(`ssoAdmin.kind.${k}`)}</span>
              </label>
            ))}
          </fieldset>
        )}
        <LabeledInput label={t('ssoAdmin.field.name')} required value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Keycloak" />
        <LabeledInput
          label={t('ssoAdmin.field.slug')}
          required
          pattern="[a-z0-9][a-z0-9-]{0,39}"
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          placeholder="keycloak"
        />
        {isSaml ? (
          <>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 sm:col-span-2">{t('ssoAdmin.saml.idpHint')}</p>
            <div className="sm:col-span-2">
              <LabeledInput label={t('ssoAdmin.saml.metadataUrl')} type="url" value={metadataUrl} onChange={(e) => setMetadataUrl(e.target.value)} placeholder="https://idp.example.com/metadata.xml" />
            </div>
            <div className="sm:col-span-2">
              <LabeledTextarea label={t('ssoAdmin.saml.metadataXml')} value={metadataXml} onChange={setMetadataXml} placeholder="<md:EntityDescriptor …>" />
            </div>
            <LabeledInput label={t('ssoAdmin.saml.idpEntityId')} value={idpEntityId} onChange={(e) => setIdpEntityId(e.target.value)} placeholder="https://sts.windows.net/<tenant>/" />
            <LabeledInput label={t('ssoAdmin.saml.ssoUrl')} type="url" value={ssoUrl} onChange={(e) => setSsoUrl(e.target.value)} placeholder="https://idp.example.com/sso/saml" />
            <div className="sm:col-span-2">
              <LabeledTextarea label={t('ssoAdmin.saml.idpCert')} value={idpCert} onChange={setIdpCert} placeholder="-----BEGIN CERTIFICATE-----" />
            </div>
            <LabeledInput label={t('ssoAdmin.saml.spEntityId')} value={spEntityId} onChange={(e) => setSpEntityId(e.target.value)} placeholder={provider?.samlSp?.metadataUrl ?? t('ssoAdmin.saml.spEntityIdDefault')} />
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-600 dark:text-neutral-400">{t('ssoAdmin.saml.nameIdFormat')}</span>
              <select
                value={nameIdFormat}
                onChange={(e) => setNameIdFormat(e.target.value as SamlNameIdFormat)}
                className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              >
                {(['persistent', 'email', 'unspecified'] as const).map((f) => (
                  <option key={f} value={f}>
                    {t(`ssoAdmin.saml.nameId.${f}`)}
                  </option>
                ))}
              </select>
            </label>
            <LabeledInput label={t('ssoAdmin.field.domains')} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com, example.org" />
            <LabeledInput label={t('ssoAdmin.saml.emailAttr')} value={emailClaim} onChange={(e) => setEmailClaim(e.target.value)} />
            <LabeledInput label={t('ssoAdmin.saml.nameAttr')} value={nameClaim} onChange={(e) => setNameClaim(e.target.value)} />
            <LabeledInput label={t('ssoAdmin.saml.groupsAttr')} value={groupsClaim} onChange={(e) => setGroupsClaim(e.target.value)} />
            <p className="text-xs text-neutral-500 dark:text-neutral-400 sm:col-span-2">{t('ssoAdmin.saml.attrHint')}</p>
          </>
        ) : (
          <>
            <div className="sm:col-span-2">
              <LabeledInput label={t('ssoAdmin.field.issuer')} required type="url" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://sso.example.com/realms/acme" />
            </div>
            <LabeledInput label={t('ssoAdmin.field.clientId')} required value={clientId} onChange={(e) => setClientId(e.target.value)} />
            <LabeledInput
              label={t('ssoAdmin.field.clientSecret')}
              type="password"
              autoComplete="new-password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={provider?.hasClientSecret ? t('ssoAdmin.secretKeep') : ''}
            />
            <LabeledInput label={t('ssoAdmin.field.scopes')} value={scopes} onChange={(e) => setScopes(e.target.value)} />
            <LabeledInput label={t('ssoAdmin.field.domains')} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com, example.org" />
            <LabeledInput label={t('ssoAdmin.field.emailClaim')} value={emailClaim} onChange={(e) => setEmailClaim(e.target.value)} />
            <LabeledInput label={t('ssoAdmin.field.nameClaim')} value={nameClaim} onChange={(e) => setNameClaim(e.target.value)} />
            <LabeledInput label={t('ssoAdmin.field.groupsClaim')} value={groupsClaim} onChange={(e) => setGroupsClaim(e.target.value)} />
            <div />
          </>
        )}
        <div className="flex flex-col gap-2 sm:col-span-2">
          {provider?.scimEnabled ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('scimAdmin.jitNote')}</p>
          ) : (
            <Checkbox label={t('ssoAdmin.field.jit')} hint={t('ssoAdmin.jitHint')} checked={jitEnabled} onChange={setJitEnabled} />
          )}
          {jitEnabled && (
            <LabeledInput label={t('ssoAdmin.field.jitSpaces')} value={jitSpaces} onChange={(e) => setJitSpaces(e.target.value)} placeholder="docs:viewer, engineering:editor" />
          )}
          <Checkbox label={t('ssoAdmin.field.enforce')} hint={t('ssoAdmin.enforceHint')} checked={enforceSso} onChange={setEnforceSso} />
          {isSaml && (
            <>
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
                <Checkbox label={t('ssoAdmin.saml.emailAuthoritative')} hint={t('ssoAdmin.saml.emailAuthoritativeHint')} checked={emailAuthoritative} onChange={setEmailAuthoritative} />
              </div>
              <Checkbox label={t('ssoAdmin.saml.allowIdpInitiated')} hint={t('ssoAdmin.saml.allowIdpInitiatedHint')} checked={allowIdpInitiated} onChange={setAllowIdpInitiated} />
            </>
          )}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{isSaml ? t('ssoAdmin.saml.linkHint') : t('ssoAdmin.linkHint')}</p>
        </div>
        <fieldset className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800 sm:col-span-2">
          <legend className="px-1 text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('ssoAdmin.groupSync.title')}</legend>
          <Checkbox label={t('ssoAdmin.groupSync.enable')} hint={t('ssoAdmin.groupSync.enableHint', { claim: groupsClaim.trim() || 'groups' })} checked={syncEnabled} onChange={setSyncEnabled} />
          {syncEnabled && (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-neutral-600 dark:text-neutral-400">{t('ssoAdmin.groupSync.mode')}</span>
                <select
                  value={syncMode}
                  onChange={(e) => setSyncMode(e.target.value as SsoGroupSync['mode'])}
                  className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
                >
                  <option value="name">{t('ssoAdmin.groupSync.modeName')}</option>
                  <option value="mapping">{t('ssoAdmin.groupSync.modeMapping')}</option>
                </select>
              </label>
              {syncMode === 'mapping' && (
                <LabeledTextarea label={t('ssoAdmin.groupSync.mapping')} value={syncMapping} onChange={setSyncMapping} placeholder={'Engineering = eng\n3f2a… = admins'} rows={4} />
              )}
              <Checkbox label={t('ssoAdmin.groupSync.createMissing')} hint={t('ssoAdmin.groupSync.createMissingHint')} checked={syncCreate} onChange={setSyncCreate} />
              <LabeledInput label={t('ssoAdmin.groupSync.allow')} value={syncAllow} onChange={(e) => setSyncAllow(e.target.value)} placeholder="folio-, /^team-/" />
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('ssoAdmin.groupSync.hint')}</p>
            </>
          )}
        </fieldset>
        {save.isError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400 sm:col-span-2">
            {errorText(save.error, 'ssoAdmin.saveFailed')}
          </p>
        )}
      </form>
    </Modal>
  );
}
