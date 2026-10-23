/**
 * Group sync settings of a provider (migration 057) and the pure helpers around
 * them: parsing the stored value and the environment, reading the groups claim,
 * the allowlist, slugs. No database here, so providers.ts can import it; the
 * sync itself is in groupSync.ts.
 */
import { createHash } from 'node:crypto';
import type { SsoGroupSync } from '../../shared/contracts.js';

export const DEFAULT_GROUP_SYNC: SsoGroupSync = { enabled: false, mode: 'name', mapping: {}, createMissing: false, allow: '' };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/** The stored jsonb (or anything) as a valid SsoGroupSync: unknown shapes fall back to the defaults, bad mapping entries are dropped. */
export function normalizeGroupSync(raw: unknown): SsoGroupSync {
  const m = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const mapping: Record<string, string> = {};
  if (typeof m.mapping === 'object' && m.mapping !== null) {
    for (const [idp, target] of Object.entries(m.mapping as Record<string, unknown>)) {
      if (idp.trim() && typeof target === 'string' && SLUG_RE.test(target)) mapping[idp.trim()] = target;
    }
  }
  return {
    enabled: m.enabled === true,
    mode: m.mode === 'mapping' ? 'mapping' : 'name',
    mapping,
    createMissing: m.createMissing === true,
    allow: typeof m.allow === 'string' ? m.allow.trim().slice(0, 300) : '',
  };
}

/** "Engineering=eng, 3f2a-uuid=admins" -> { Engineering: 'eng', '3f2a-uuid': 'admins' } (entries with an invalid group slug dropped). */
export function parseGroupMap(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? '').split(/[,\n]/)) {
    const at = part.lastIndexOf('=');
    if (at < 1) continue;
    const idp = part.slice(0, at).trim();
    const target = part.slice(at + 1).trim();
    if (idp && SLUG_RE.test(target)) out[idp] = target;
  }
  return out;
}

/** FOLIO_OIDC_<SLUG>_GROUP_SYNC / _GROUP_SYNC_MODE / _GROUP_MAP / _GROUP_CREATE / _GROUP_ALLOW. */
export function groupSyncFromEnv(env: NodeJS.ProcessEnv, prefix: string): SsoGroupSync {
  const mapping = parseGroupMap(env[`${prefix}GROUP_MAP`]);
  const modeRaw = env[`${prefix}GROUP_SYNC_MODE`]?.trim().toLowerCase();
  return normalizeGroupSync({
    enabled: parseBool(env[`${prefix}GROUP_SYNC`]) ?? false,
    // A map without an explicit mode means "use the map".
    mode: modeRaw === 'name' || modeRaw === 'mapping' ? modeRaw : Object.keys(mapping).length > 0 ? 'mapping' : 'name',
    mapping,
    createMissing: parseBool(env[`${prefix}GROUP_CREATE`]) ?? false,
    allow: env[`${prefix}GROUP_ALLOW`] ?? '',
  });
}

/**
 * A groups claim in one shape. OIDC gives an array; SAML gives a bare string when the attribute has a single value
 * ("sales" rather than ["sales"]). A string becomes a one-element list (a blank one, an empty list); an array, an
 * absent claim and anything unusable (an object, a number: group sync reports it as invalid) pass through unchanged.
 */
export function normalizeGroupsClaim(raw: unknown): unknown {
  if (typeof raw === 'string') return raw.trim() ? [raw.trim()] : [];
  return raw;
}

/** The value for user_identities.groups (jsonb): the normalised claim as JSON, or SQL NULL when the provider sent none. */
export function groupsColumnValue(raw: unknown): string | null {
  const groups = normalizeGroupsClaim(raw);
  return groups === undefined ? null : JSON.stringify(groups);
}

/**
 * The values of a groups claim: an array of strings (or one string). `undefined`/`null` (the claim is absent — Entra
 * leaves it out for a person in no group) is an empty list; anything else (an object, a number) is `null` = unusable.
 * Blank and over-long values are dropped, duplicates removed.
 */
export function extractGroupValues(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : null;
  if (!list) return null;
  const out = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (value && value.length <= 300) out.add(value);
  }
  return [...out];
}

/** The allowlist as a predicate: '' = everything, `/re/` = regular expression, otherwise comma-separated prefixes (case-insensitive). An invalid regex matches nothing. */
export function allowPredicate(allow: string): (value: string) => boolean {
  const text = allow.trim();
  if (!text) return () => true;
  const re = /^\/(.+)\/$/.exec(text);
  if (re) {
    try {
      const rx = new RegExp(re[1]);
      return (value) => rx.test(value);
    } catch {
      return () => false;
    }
  }
  const prefixes = text
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  return (value) => prefixes.some((p) => value.toLowerCase().startsWith(p));
}

/** A group slug from an IdP value (diacritics stripped, `[a-z0-9-]`); a value with no Latin letters or digits gets a stable `idp-<hash>`. */
export function slugifyGroupValue(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return slug || `idp-${createHash('sha256').update(value).digest('hex').slice(0, 10)}`;
}
