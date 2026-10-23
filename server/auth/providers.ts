/**
 * Single sign-on providers (migrations 054, 056, docs/AUTH.md): where they come
 * from and how they are stored. Two kinds: OpenID Connect (oidc.ts) and
 * SAML 2.0 (saml.ts, settings in `saml_config`).
 *
 * Two sources, one table (`auth_providers`):
 *  - the environment — FOLIO_OIDC_<SLUG>_ISSUER / _CLIENT_ID / _CLIENT_SECRET /
 *    _NAME / _DOMAINS / _JIT / _JIT_SPACES / _ENFORCE / _SCOPES /
 *    _EMAIL_CLAIM / _NAME_CLAIM / _GROUPS_CLAIM; FOLIO_SAML_<SLUG>_METADATA_URL |
 *    _METADATA | _SSO_URL (+ _ENTITY_ID / _CERT / _SP_ENTITY_ID / _NAMEID_FORMAT /
 *    _EMAIL_AUTHORITATIVE / _ALLOW_IDP_INITIATED / _EMAIL_ATTR / _NAME_ATTR /
 *    _GROUPS_ATTR and the same _NAME / _DOMAINS / _JIT / _JIT_SPACES / _ENFORCE); for group sync
 *    (groupSync.ts) _GROUP_SYNC / _GROUP_SYNC_MODE / _GROUP_MAP / _GROUP_CREATE / _GROUP_ALLOW on either kind; plus the legacy
 *    GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_ALLOWED_DOMAINS, which
 *    become the `google` provider. These rows are upserted at boot
 *    (syncEnvProviders), are read-only in the admin UI, and their client
 *    secret is NEVER written to the database — it is read from the
 *    environment at sign-in time;
 *  - the admin screen /admin/auth — the client secret is encrypted with
 *    FOLIO_SECRET (server/secretCrypto.ts, AES-256-GCM) and never returned by
 *    any API (AuthProviderInfo only says whether one is set).
 *
 * A provider row that came from the environment and whose variables are gone
 * is disabled, not deleted: its user_identities rows reference it.
 */
import type { AuthProviderInfo, SamlConfigInput, SamlProviderConfig, SpaceRole, SsoClaimMapping, SsoGroupSync, SsoProviderKind } from '../../shared/contracts.js';
import { spaceRoleSchema } from '../../shared/contracts.js';
import { mergeSamlConfig, normalizeSamlConfig, validateSamlConfig } from './samlConfig.js';
import { query, queryOne } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { decryptSecret, encryptSecret, hasSecretConfigured } from '../secretCrypto.js';
import { DEFAULT_GROUP_SYNC, groupSyncFromEnv, groupsColumnValue, normalizeGroupSync, normalizeGroupsClaim } from './groupSyncConfig.js';

export const GOOGLE_ISSUER = 'https://accounts.google.com';

export interface AuthProvider {
  id: string;
  slug: string;
  kind: SsoProviderKind;
  source: 'db' | 'env';
  displayName: string;
  issuer: string;
  clientId: string;
  /** Decrypted (db) or read from the environment (env); undefined = a public client (PKCE only). */
  clientSecret: string | undefined;
  hasClientSecret: boolean;
  scopes: string;
  claimMapping: Required<SsoClaimMapping>;
  /** Mapping of the provider's groups claim to Folio groups at sign-in (groupSync.ts). */
  groupSync: SsoGroupSync;
  allowedDomains: string[];
  jitEnabled: boolean;
  jitDefaultSpaces: Record<string, SpaceRole>;
  enforceSso: boolean;
  enabled: boolean;
  /** The `google` provider built from GOOGLE_* keeps its old callback URL (/api/auth/google/callback), so existing Google Cloud clients keep working. */
  legacyGoogle: boolean;
  /** kind 'saml' only (null for OIDC). */
  saml: SamlProviderConfig | null;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_SCOPES = 'openid email profile';
export const DEFAULT_CLAIM_MAPPING: Required<SsoClaimMapping> = { email: 'email', name: 'name', groups: 'groups' };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Comma/space-separated domain list: trimmed, lower-cased, de-duplicated, a leading `@` dropped. */
export function parseDomainList(raw: string | undefined): string[] {
  const domains = (raw ?? '')
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  return Array.from(new Set(domains));
}

/** The domain part of an email, lower-case; '' when there is none. */
export function emailDomain(email: string | null | undefined): string {
  const at = (email ?? '').lastIndexOf('@');
  return at === -1 ? '' : (email ?? '').slice(at + 1).trim().toLowerCase();
}

export function domainAllowed(provider: Pick<AuthProvider, 'allowedDomains'>, email: string | null | undefined): boolean {
  const domain = emailDomain(email);
  return domain !== '' && provider.allowedDomains.includes(domain);
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/** "docs:viewer, eng:editor" -> { docs: 'viewer', eng: 'editor' } (unknown roles dropped). */
export function parseJitSpaces(raw: string | undefined): Record<string, SpaceRole> {
  const out: Record<string, SpaceRole> = {};
  for (const part of (raw ?? '').split(',')) {
    const [slug, role] = part.split(':').map((s) => s?.trim());
    const parsed = spaceRoleSchema.safeParse(role || 'viewer');
    if (slug && parsed.success) out[slug] = parsed.data;
  }
  return out;
}

function normalizeMapping(raw: unknown): Required<SsoClaimMapping> {
  const m = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = (key: keyof SsoClaimMapping) => (typeof m[key] === 'string' && (m[key] as string).trim() ? (m[key] as string).trim() : DEFAULT_CLAIM_MAPPING[key]);
  return { email: pick('email'), name: pick('name'), groups: pick('groups') };
}

function normalizeJitSpaces(raw: unknown): Record<string, SpaceRole> {
  const out: Record<string, SpaceRole> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [slug, role] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = spaceRoleSchema.safeParse(role);
    if (parsed.success) out[slug] = parsed.data;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface EnvProvider {
  kind: SsoProviderKind;
  slug: string;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string | undefined;
  scopes: string;
  claimMapping: Required<SsoClaimMapping>;
  groupSync: SsoGroupSync;
  allowedDomains: string[];
  jitEnabled: boolean;
  jitDefaultSpaces: Record<string, SpaceRole>;
  enforceSso: boolean;
  legacyGoogle: boolean;
  saml: SamlProviderConfig | null;
}

/**
 * Every provider the environment defines, keyed by slug. FOLIO_OIDC_GOOGLE_* wins over the legacy GOOGLE_* pair;
 * an OIDC provider wins over a SAML one with the same slug.
 */
export function readEnvProviders(env: NodeJS.ProcessEnv = process.env): Map<string, EnvProvider> {
  const out = new Map<string, EnvProvider>();
  for (const key of Object.keys(env)) {
    const match = /^FOLIO_OIDC_([A-Z0-9_]+)_ISSUER$/.exec(key);
    if (!match) continue;
    const prefix = `FOLIO_OIDC_${match[1]}_`;
    const slug = match[1].toLowerCase().replace(/_/g, '-');
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) continue;
    const issuer = env[key]?.trim();
    const clientId = env[`${prefix}CLIENT_ID`]?.trim();
    if (!issuer || !clientId) continue;
    out.set(slug, {
      kind: 'oidc',
      slug,
      displayName: env[`${prefix}NAME`]?.trim() || slug,
      issuer,
      clientId,
      clientSecret: env[`${prefix}CLIENT_SECRET`] || undefined,
      scopes: env[`${prefix}SCOPES`]?.trim() || DEFAULT_SCOPES,
      claimMapping: normalizeMapping({
        email: env[`${prefix}EMAIL_CLAIM`],
        name: env[`${prefix}NAME_CLAIM`],
        groups: env[`${prefix}GROUPS_CLAIM`],
      }),
      groupSync: groupSyncFromEnv(env, prefix),
      allowedDomains: parseDomainList(env[`${prefix}DOMAINS`]),
      jitEnabled: parseBool(env[`${prefix}JIT`], false),
      jitDefaultSpaces: parseJitSpaces(env[`${prefix}JIT_SPACES`]),
      enforceSso: parseBool(env[`${prefix}ENFORCE`], false),
      legacyGoogle: false,
      saml: null,
    });
  }
  const samlPrefixes = new Set<string>();
  for (const key of Object.keys(env)) {
    const match = /^FOLIO_SAML_([A-Z0-9_]+?)_(METADATA_URL|METADATA|SSO_URL)$/.exec(key);
    if (match && env[key]?.trim()) samlPrefixes.add(match[1]);
  }
  for (const name of samlPrefixes) {
    const prefix = `FOLIO_SAML_${name}_`;
    const slug = name.toLowerCase().replace(/_/g, '-');
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) continue;
    if (out.has(slug)) {
      // eslint-disable-next-line no-console
      console.warn(`[sso] FOLIO_SAML_${name}_* ignored: an OpenID Connect provider "${slug}" is defined too`);
      continue;
    }
    const format = env[`${prefix}NAMEID_FORMAT`]?.trim().toLowerCase();
    out.set(slug, {
      kind: 'saml',
      slug,
      displayName: env[`${prefix}NAME`]?.trim() || slug,
      issuer: '',
      clientId: '',
      clientSecret: undefined,
      scopes: DEFAULT_SCOPES,
      claimMapping: normalizeMapping({
        email: env[`${prefix}EMAIL_ATTR`],
        name: env[`${prefix}NAME_ATTR`],
        groups: env[`${prefix}GROUPS_ATTR`],
      }),
      groupSync: groupSyncFromEnv(env, prefix),
      allowedDomains: parseDomainList(env[`${prefix}DOMAINS`]),
      jitEnabled: parseBool(env[`${prefix}JIT`], false),
      jitDefaultSpaces: parseJitSpaces(env[`${prefix}JIT_SPACES`]),
      enforceSso: parseBool(env[`${prefix}ENFORCE`], false),
      legacyGoogle: false,
      saml: normalizeSamlConfig({
        metadataUrl: env[`${prefix}METADATA_URL`],
        metadataXml: env[`${prefix}METADATA`],
        idpEntityId: env[`${prefix}ENTITY_ID`],
        ssoUrl: env[`${prefix}SSO_URL`],
        // A certificate in an env var often has its newlines escaped.
        idpCert: env[`${prefix}CERT`]?.replace(/\\n/g, '\n'),
        spEntityId: env[`${prefix}SP_ENTITY_ID`],
        nameIdFormat: format,
        emailAuthoritative: parseBool(env[`${prefix}EMAIL_AUTHORITATIVE`], false),
        allowIdpInitiated: parseBool(env[`${prefix}ALLOW_IDP_INITIATED`], false),
      }),
    });
  }
  const googleId = env.GOOGLE_CLIENT_ID?.trim();
  const googleSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!out.has('google') && googleId && googleSecret) {
    const domains = parseDomainList(env.GOOGLE_ALLOWED_DOMAINS);
    out.set('google', {
      kind: 'oidc',
      slug: 'google',
      displayName: 'Google',
      issuer: GOOGLE_ISSUER,
      clientId: googleId,
      clientSecret: googleSecret,
      scopes: DEFAULT_SCOPES,
      claimMapping: DEFAULT_CLAIM_MAPPING,
      groupSync: DEFAULT_GROUP_SYNC,
      allowedDomains: domains,
      // Same behaviour as before SSO: anyone in GOOGLE_ALLOWED_DOMAINS gets an account on first sign-in; an empty
      // list lets nobody new in (closed by default — a personal Google account must never self-register).
      jitEnabled: domains.length > 0,
      jitDefaultSpaces: {},
      enforceSso: parseBool(env.GOOGLE_ENFORCE_SSO, false),
      legacyGoogle: true,
      saml: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

interface ProviderRow {
  id: string;
  slug: string;
  kind: 'oidc' | 'saml';
  source: 'db' | 'env';
  display_name: string;
  issuer: string;
  client_id: string;
  client_secret_enc: Buffer | null;
  scopes: string;
  claim_mapping: unknown;
  group_sync: unknown;
  allowed_domains: string[];
  jit_enabled: boolean;
  jit_default_spaces: unknown;
  enforce_sso: boolean;
  enabled: boolean;
  saml_config: unknown;
  created_at: string;
  updated_at: string;
}

function rowToProvider(row: ProviderRow, env: Map<string, EnvProvider>): AuthProvider {
  const fromEnv = row.source === 'env' ? env.get(row.slug) : undefined;
  let clientSecret: string | undefined;
  if (row.source === 'env') clientSecret = fromEnv?.clientSecret;
  else if (row.client_secret_enc) {
    try {
      clientSecret = decryptSecret(row.client_secret_enc);
    } catch {
      // FOLIO_SECRET changed or missing: the provider shows as configured, sign-in fails with a logged error.
      clientSecret = undefined;
    }
  }
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    source: row.source,
    displayName: row.display_name,
    issuer: row.issuer,
    clientId: row.client_id,
    clientSecret,
    hasClientSecret: row.source === 'env' ? Boolean(fromEnv?.clientSecret) : row.client_secret_enc !== null,
    scopes: row.scopes,
    claimMapping: normalizeMapping(row.claim_mapping),
    groupSync: normalizeGroupSync(row.group_sync),
    allowedDomains: row.allowed_domains ?? [],
    jitEnabled: row.jit_enabled,
    jitDefaultSpaces: normalizeJitSpaces(row.jit_default_spaces),
    enforceSso: row.enforce_sso,
    // An env row whose variables are gone is never usable, whatever its stored flag says.
    enabled: row.enabled && (row.source !== 'env' || fromEnv !== undefined),
    legacyGoogle: fromEnv?.legacyGoogle ?? false,
    saml: row.kind === 'saml' ? normalizeSamlConfig(fromEnv?.saml ?? row.saml_config) : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

let syncPromise: Promise<void> | null = null;

/**
 * Upserts every environment-defined provider into auth_providers (source 'env', no secret stored) and disables the
 * env rows whose variables are gone. A row created in the admin UI with the same slug is taken over by the
 * environment (logged). Runs once per process (boot, or the first lookup); tests call it again after changing env.
 */
export async function syncEnvProviders(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const defined = readEnvProviders(env);
  for (const p of defined.values()) {
    const existing = await queryOne<{ source: string }>('SELECT source FROM auth_providers WHERE slug = $1', [p.slug]);
    if (existing?.source === 'db') {
      // eslint-disable-next-line no-console
      console.warn(`[sso] provider "${p.slug}" is defined in the environment; the environment now overrides the one saved in the admin UI`);
    }
    // A SAML row shows the IdP entity ID (or the metadata URL) as its issuer and the SP entity ID override as client_id.
    const issuer = p.kind === 'saml' ? p.saml!.idpEntityId || p.saml!.metadataUrl : p.issuer;
    const clientId = p.kind === 'saml' ? p.saml!.spEntityId : p.clientId;
    await query(
      `INSERT INTO auth_providers (slug, kind, source, display_name, issuer, client_id, client_secret_enc, scopes, claim_mapping,
                                   allowed_domains, jit_enabled, jit_default_spaces, enforce_sso, enabled, saml_config, group_sync)
       VALUES ($1, $11, 'env', $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, true, $12::jsonb, $13::jsonb)
       ON CONFLICT (slug) DO UPDATE SET
         kind = EXCLUDED.kind, source = 'env', display_name = EXCLUDED.display_name, issuer = EXCLUDED.issuer,
         client_id = EXCLUDED.client_id, client_secret_enc = NULL, scopes = EXCLUDED.scopes,
         claim_mapping = EXCLUDED.claim_mapping, allowed_domains = EXCLUDED.allowed_domains,
         jit_enabled = EXCLUDED.jit_enabled, jit_default_spaces = EXCLUDED.jit_default_spaces,
         enforce_sso = EXCLUDED.enforce_sso, enabled = true, saml_config = EXCLUDED.saml_config, group_sync = EXCLUDED.group_sync, updated_at = now()`,
      [
        p.slug,
        p.displayName,
        issuer,
        clientId,
        p.scopes,
        JSON.stringify(p.claimMapping),
        p.allowedDomains,
        p.jitEnabled,
        JSON.stringify(p.jitDefaultSpaces),
        p.enforceSso,
        p.kind,
        p.saml ? JSON.stringify(p.saml) : null,
        JSON.stringify(p.groupSync),
      ],
    );
  }
  await query(`UPDATE auth_providers SET enabled = false, updated_at = now() WHERE source = 'env' AND enabled AND NOT (slug = ANY($1::text[]))`, [
    [...defined.keys()],
  ]);
}

function ensureSynced(): Promise<void> {
  if (!syncPromise) {
    syncPromise = syncEnvProviders().catch((err) => {
      syncPromise = null;
      throw err;
    });
  }
  return syncPromise;
}

/** Test-only: forget that the environment was synced, so the next lookup re-reads it. */
export function __resetProviderSyncForTests(): void {
  syncPromise = null;
}

export async function listProviders(): Promise<AuthProvider[]> {
  await ensureSynced();
  const env = readEnvProviders();
  const rows = await query<ProviderRow>('SELECT * FROM auth_providers ORDER BY created_at, slug');
  return rows.map((r) => rowToProvider(r, env));
}

export async function listEnabledProviders(): Promise<AuthProvider[]> {
  return (await listProviders()).filter((p) => p.enabled);
}

export async function getProviderBySlug(slug: string): Promise<AuthProvider | undefined> {
  await ensureSynced();
  const row = await queryOne<ProviderRow>('SELECT * FROM auth_providers WHERE slug = $1', [slug]);
  return row ? rowToProvider(row, readEnvProviders()) : undefined;
}

export async function getProviderById(id: string): Promise<AuthProvider | undefined> {
  await ensureSynced();
  const row = await queryOne<ProviderRow>('SELECT * FROM auth_providers WHERE id::text = $1', [id]);
  return row ? rowToProvider(row, readEnvProviders()) : undefined;
}

/** The enabled provider whose allowed_domains list this email's domain — an enforcing one first, then the first created. */
export async function providerForEmail(email: string): Promise<AuthProvider | undefined> {
  const domain = emailDomain(email);
  if (!domain) return undefined;
  const matching = (await listEnabledProviders()).filter((p) => p.allowedDomains.includes(domain));
  return matching.find((p) => p.enforceSso) ?? matching[0];
}

/** The enabled provider that ENFORCES single sign-on for this email's domain, if any. */
export async function enforcedProviderForEmail(email: string): Promise<AuthProvider | undefined> {
  const domain = emailDomain(email);
  if (!domain) return undefined;
  return (await listEnabledProviders()).find((p) => p.enforceSso && p.allowedDomains.includes(domain));
}

export interface ProviderInput {
  /** Fixed at creation (default 'oidc'). */
  kind?: SsoProviderKind;
  slug: string;
  displayName: string;
  /** OIDC: required. SAML: ignored (derived from `saml`). */
  issuer?: string;
  clientId?: string;
  /** undefined = keep (patch) / none (create); '' = clear. */
  clientSecret?: string;
  scopes?: string;
  claimMapping?: SsoClaimMapping;
  groupSync?: SsoGroupSync;
  allowedDomains?: string[];
  jitEnabled?: boolean;
  jitDefaultSpaces?: Record<string, SpaceRole>;
  enforceSso?: boolean;
  enabled?: boolean;
  /** SAML: the settings (a patch merges them: omitted fields kept, '' clears). */
  saml?: SamlConfigInput;
}

/** SAML: the merged, validated settings and the issuer / client_id columns derived from them. 400 on an unusable config. */
async function samlColumns(current: SamlProviderConfig | null, patch: SamlConfigInput | undefined): Promise<{ saml: SamlProviderConfig; issuer: string; clientId: string }> {
  const saml = mergeSamlConfig(current, patch);
  try {
    const { idpEntityId } = await validateSamlConfig(saml);
    return { saml, issuer: idpEntityId || saml.metadataUrl, clientId: saml.spEntityId };
  } catch (err) {
    throw badRequest(`SAML: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function encryptOrRefuse(secret: string): Buffer {
  if (!hasSecretConfigured()) throw badRequest('FOLIO_SECRET is not set: a client secret cannot be stored. Set FOLIO_SECRET, or define the provider in the environment.');
  return encryptSecret(secret);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export async function createProvider(input: ProviderInput): Promise<AuthProvider> {
  await ensureSynced();
  if (readEnvProviders().has(input.slug)) throw conflict(`provider "${input.slug}" is defined in the environment`);
  const kind = input.kind ?? 'oidc';
  let issuer: string;
  let clientId: string;
  let saml: SamlProviderConfig | null = null;
  let secretEnc: Buffer | null = null;
  if (kind === 'saml') {
    ({ saml, issuer, clientId } = await samlColumns(null, input.saml));
  } else {
    issuer = input.issuer?.trim() ?? '';
    clientId = input.clientId?.trim() ?? '';
    if (!issuer || !clientId) throw badRequest('an OpenID Connect provider needs an issuer URL and a client ID');
    secretEnc = input.clientSecret ? encryptOrRefuse(input.clientSecret) : null;
  }
  try {
    const row = await queryOne<ProviderRow>(
      `INSERT INTO auth_providers (slug, kind, source, display_name, issuer, client_id, client_secret_enc, scopes, claim_mapping,
                                   allowed_domains, jit_enabled, jit_default_spaces, enforce_sso, enabled, saml_config, group_sync)
       VALUES ($1, $13, 'db', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $14::jsonb, $15::jsonb)
       RETURNING *`,
      [
        input.slug,
        input.displayName.trim(),
        issuer,
        clientId,
        secretEnc,
        input.scopes?.trim() || DEFAULT_SCOPES,
        JSON.stringify(normalizeMapping(input.claimMapping)),
        input.allowedDomains ?? [],
        input.jitEnabled ?? false,
        JSON.stringify(input.jitDefaultSpaces ?? {}),
        input.enforceSso ?? false,
        input.enabled ?? true,
        kind,
        saml ? JSON.stringify(saml) : null,
        JSON.stringify(normalizeGroupSync(input.groupSync)),
      ],
    );
    return rowToProvider(row!, readEnvProviders());
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`a provider with the slug "${input.slug}" already exists`);
    throw err;
  }
}

/** Env providers are read-only (409). */
export async function updateProvider(id: string, patch: Partial<ProviderInput>): Promise<AuthProvider> {
  const current = await getProviderById(id);
  if (!current) throw notFound('provider');
  if (current.source === 'env') throw conflict('this provider is defined in the environment and cannot be edited here');
  if (patch.slug !== undefined && patch.slug !== current.slug && readEnvProviders().has(patch.slug)) {
    throw conflict(`provider "${patch.slug}" is defined in the environment`);
  }
  if (patch.kind !== undefined && patch.kind !== current.kind) throw badRequest('the kind of a provider (OIDC / SAML) cannot be changed: add a new one');
  let samlCols: { saml: SamlProviderConfig; issuer: string; clientId: string } | null = null;
  if (current.kind === 'saml') {
    samlCols = await samlColumns(current.saml, patch.saml);
    patch = { ...patch, issuer: samlCols.issuer, clientId: samlCols.clientId, clientSecret: undefined };
  }
  const secretChange = patch.clientSecret !== undefined;
  const secretEnc = patch.clientSecret ? encryptOrRefuse(patch.clientSecret) : null;
  try {
    const row = await queryOne<ProviderRow>(
      `UPDATE auth_providers SET
         slug = COALESCE($2, slug),
         display_name = COALESCE($3, display_name),
         issuer = COALESCE($4, issuer),
         client_id = COALESCE($5, client_id),
         client_secret_enc = CASE WHEN $6 THEN $7 ELSE client_secret_enc END,
         scopes = COALESCE($8, scopes),
         claim_mapping = COALESCE($9::jsonb, claim_mapping),
         allowed_domains = COALESCE($10::text[], allowed_domains),
         jit_enabled = COALESCE($11, jit_enabled),
         jit_default_spaces = COALESCE($12::jsonb, jit_default_spaces),
         enforce_sso = COALESCE($13, enforce_sso),
         enabled = COALESCE($14, enabled),
         saml_config = COALESCE($15::jsonb, saml_config),
         group_sync = COALESCE($16::jsonb, group_sync),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.slug ?? null,
        patch.displayName?.trim() ?? null,
        samlCols ? samlCols.issuer : patch.issuer?.trim() || null,
        samlCols ? samlCols.clientId : patch.clientId?.trim() || null,
        secretChange,
        secretEnc,
        patch.scopes?.trim() || null,
        patch.claimMapping ? JSON.stringify(normalizeMapping(patch.claimMapping)) : null,
        patch.allowedDomains ?? null,
        patch.jitEnabled ?? null,
        patch.jitDefaultSpaces ? JSON.stringify(patch.jitDefaultSpaces) : null,
        patch.enforceSso ?? null,
        patch.enabled ?? null,
        samlCols ? JSON.stringify(samlCols.saml) : null,
        patch.groupSync ? JSON.stringify(normalizeGroupSync(patch.groupSync)) : null,
      ],
    );
    return rowToProvider(row!, readEnvProviders());
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`a provider with the slug "${patch.slug}" already exists`);
    throw err;
  }
}

/** Deletes the provider and (cascade) every identity linked to it. An env provider that is still defined cannot be deleted. */
export async function deleteProvider(id: string): Promise<AuthProvider> {
  const current = await getProviderById(id);
  if (!current) throw notFound('provider');
  if (current.source === 'env' && readEnvProviders().has(current.slug)) {
    throw conflict('this provider is defined in the environment; remove its variables first');
  }
  // Memberships the provider put people into stay, as manual ones: nothing can sync (or remove) them any more.
  await query("UPDATE group_members SET source = 'local', source_provider_id = NULL WHERE source_provider_id = $1", [id]);
  await query('DELETE FROM auth_providers WHERE id = $1', [id]);
  return current;
}

export async function countIdentitiesByProvider(): Promise<Map<string, number>> {
  const rows = await query<{ provider_id: string; count: string }>('SELECT provider_id, COUNT(*) AS count FROM user_identities GROUP BY provider_id');
  return new Map(rows.map((r) => [r.provider_id, Number(r.count)]));
}

export function toProviderInfo(
  p: AuthProvider,
  redirectUri: string,
  identities: number,
  samlSp?: AuthProviderInfo['samlSp'],
): AuthProviderInfo {
  return {
    id: p.id,
    slug: p.slug,
    kind: p.kind,
    source: p.source,
    displayName: p.displayName,
    issuer: p.issuer,
    clientId: p.clientId,
    hasClientSecret: p.hasClientSecret,
    scopes: p.scopes,
    claimMapping: p.claimMapping,
    groupSync: p.groupSync,
    allowedDomains: p.allowedDomains,
    jitEnabled: p.jitEnabled,
    jitDefaultSpaces: p.jitDefaultSpaces,
    enforceSso: p.enforceSso,
    enabled: p.enabled,
    redirectUri,
    identities,
    ...(p.saml ? { saml: p.saml } : {}),
    ...(samlSp ? { samlSp } : {}),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

export interface UserIdentity {
  id: string;
  userId: string;
  providerId: string;
  issuer: string;
  subject: string;
  email: string | null;
  groups: unknown;
  lastLoginAt: string | null;
  createdAt: string;
}

interface IdentityRow {
  id: string;
  user_id: string;
  provider_id: string;
  issuer: string;
  subject: string;
  email: string | null;
  groups: unknown;
  last_login_at: string | null;
  created_at: string;
}

function rowToIdentity(r: IdentityRow): UserIdentity {
  return {
    id: r.id,
    userId: r.user_id,
    providerId: r.provider_id,
    issuer: r.issuer,
    subject: r.subject,
    email: r.email,
    groups: normalizeGroupsClaim(r.groups),
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function findIdentity(issuer: string, subject: string): Promise<UserIdentity | undefined> {
  const row = await queryOne<IdentityRow>('SELECT * FROM user_identities WHERE issuer = $1 AND subject = $2', [issuer, subject]);
  return row ? rowToIdentity(row) : undefined;
}

/** A SCIM placeholder (migration 059, server/scim/identities.ts: issuer 'urn:folio:scim:…') does not count: it is completed at sign-in. */
export async function userHasIdentityForProvider(userId: string, providerId: string): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM user_identities WHERE user_id = $1 AND provider_id = $2 AND issuer NOT LIKE 'urn:folio:scim:%') AS exists",
    [userId, providerId],
  );
  return row?.exists ?? false;
}

export async function listIdentitiesForUser(userId: string): Promise<UserIdentity[]> {
  const rows = await query<IdentityRow>('SELECT * FROM user_identities WHERE user_id = $1 ORDER BY created_at', [userId]);
  return rows.map(rowToIdentity);
}

export async function createIdentity(input: {
  userId: string;
  providerId: string;
  issuer: string;
  subject: string;
  email: string | null;
  groups: unknown;
}): Promise<UserIdentity> {
  try {
    const row = await queryOne<IdentityRow>(
      `INSERT INTO user_identities (user_id, provider_id, issuer, subject, email, groups, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING *`,
      [input.userId, input.providerId, input.issuer, input.subject, input.email, groupsColumnValue(input.groups)],
    );
    return rowToIdentity(row!);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('this identity is already linked to an account');
    throw err;
  }
}

/** Every sign-in refreshes what the provider last said: the email and the raw groups claim. */
export async function touchIdentity(id: string, email: string | null, groups: unknown): Promise<void> {
  await query('UPDATE user_identities SET email = COALESCE($2, email), groups = $3, last_login_at = now() WHERE id = $1', [
    id,
    email,
    groupsColumnValue(groups),
  ]);
}
