/**
 * SCIM /Users (RFC 7643 §4.1, RFC 7644 §3). A SCIM User is a Folio account with an identity at the token's provider.
 *
 * What a provider's token may touch: only accounts linked to that provider (created over SCIM, adopted over SCIM,
 * or linked by signing in through it) — never another provider's people, never a system account, and it never
 * changes `is_admin`. Accounts have no password (the person signs in through the provider).
 *
 *  - POST: a new account (no password, not an admin) plus a placeholder identity (identities.ts). An existing
 *    account with the same email is ADOPTED only when its domain is in the provider's allowed domains, it is not
 *    an instance admin and it has no identity at another provider; otherwise 409 uniqueness.
 *  - PUT / PATCH: userName, externalId, name, displayName, the work / primary email, active. active:false
 *    deactivates through auth/store.updateUser, which revokes every session, token, OAuth grant and socket;
 *    active:true re-enables. The last active instance admin cannot be deactivated (409).
 *  - DELETE: deactivates (never deletes) and hides the account from SCIM; a later POST of the same person revives it.
 */
import { recordAudit } from '../audit.js';
import { query, queryOne } from '../db/pool.js';
import * as store from '../auth/store.js';
import * as providers from '../auth/providers.js';
import type { AuthProvider } from '../auth/providers.js';
import { scimBadRequest, scimConflict, scimNotFound } from './errors.js';
import type { FilterTerm } from './filter.js';
import { placeholderIssuer } from './identities.js';
import {
  LIST_RESPONSE_SCHEMA,
  USER_SCHEMA,
  parsePatch,
  parseScim,
  scimBoolean,
  scimUserSchema,
  stripCoreUrn,
  type ScimEmail,
  type ScimName,
} from './schemas.js';

export interface ScimContext {
  provider: AuthProvider;
  tokenId: string;
  /** <public URL>/scim/v2 */
  baseUrl: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  disabled: boolean;
  is_admin: boolean;
  created_at: string;
  identity_id: string;
  issuer: string;
  scim_external_id: string | null;
  scim_user_name: string | null;
  scim_attributes: { name?: ScimName; displayName?: string } | null;
  scim_updated_at: string | null;
  identity_created_at: string;
}

const USER_SELECT = `SELECT DISTINCT ON (u.id) u.id, u.email, u.name, u.disabled, u.is_admin, u.created_at,
       i.id AS identity_id, i.issuer, i.scim_external_id, i.scim_user_name, i.scim_attributes, i.scim_updated_at, i.created_at AS identity_created_at
  FROM user_identities i JOIN users u ON u.id = i.user_id
 WHERE i.provider_id = $1 AND i.scim_deleted_at IS NULL AND NOT u.is_system`;
const USER_ORDER = 'ORDER BY u.id, i.scim_provisioned DESC, i.created_at';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function iso(value: string | null | undefined): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

export function userLocation(ctx: Pick<ScimContext, 'baseUrl'>, id: string): string {
  return `${ctx.baseUrl}/Users/${id}`;
}

export function toScimUser(ctx: Pick<ScimContext, 'baseUrl'>, row: UserRow): Record<string, unknown> {
  const attrs = row.scim_attributes ?? {};
  const name = attrs.name && Object.values(attrs.name).some((v) => typeof v === 'string' && v) ? attrs.name : { formatted: row.name };
  const created = iso(row.identity_created_at) ?? iso(row.created_at)!;
  return {
    schemas: [USER_SCHEMA],
    id: row.id,
    ...(row.scim_external_id ? { externalId: row.scim_external_id } : {}),
    userName: row.scim_user_name ?? row.email,
    name,
    displayName: row.name,
    emails: [{ value: row.email, type: 'work', primary: true }],
    active: !row.disabled,
    meta: { resourceType: 'User', created, lastModified: iso(row.scim_updated_at) ?? created, location: userLocation(ctx, row.id) },
  };
}

async function findRow(ctx: ScimContext, id: string): Promise<UserRow | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  return queryOne<UserRow>(`${USER_SELECT} AND u.id = $2 ${USER_ORDER}`, [ctx.provider.id, id]);
}

async function requireRow(ctx: ScimContext, id: string): Promise<UserRow> {
  const row = await findRow(ctx, id);
  if (!row) throw scimNotFound('user');
  return row;
}

export async function getScimUser(ctx: ScimContext, id: string): Promise<Record<string, unknown>> {
  return toScimUser(ctx, await requireRow(ctx, id));
}

/** The users of `providerId` among `ids` (SCIM group members must be ones). */
export async function visibleUserIds(providerId: string, ids: readonly string[]): Promise<Set<string>> {
  const valid = ids.filter((id) => UUID_RE.test(id));
  if (valid.length === 0) return new Set();
  const rows = await query<{ id: string }>(
    `SELECT DISTINCT u.id FROM user_identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider_id = $1 AND i.scim_deleted_at IS NULL AND NOT u.is_system AND u.id = ANY($2::uuid[])`,
    [providerId, valid],
  );
  return new Set(rows.map((r) => r.id));
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface Page {
  startIndex: number;
  count: number;
}

export function listResponse(resources: unknown[], total: number, page: Page): Record<string, unknown> {
  return { schemas: [LIST_RESPONSE_SCHEMA], totalResults: total, startIndex: page.startIndex, itemsPerPage: resources.length, Resources: resources };
}

function userFilterSql(terms: FilterTerm[], params: unknown[]): string {
  const clauses: string[] = [];
  for (const term of terms) {
    params.push(term.value);
    const p = `$${params.length}`;
    switch (term.attr) {
      case 'username':
        clauses.push(`lower(COALESCE(i.scim_user_name, u.email::text)) = lower(${p}::text)`);
        break;
      case 'externalid':
        clauses.push(`i.scim_external_id = ${p}::text`);
        break;
      case 'id':
        clauses.push(`u.id::text = ${p}::text`);
        break;
      case 'emails.value':
        clauses.push(`lower(u.email::text) = lower(${p}::text)`);
        break;
      case 'active':
        clauses.push(`(NOT u.disabled) = ${p}::boolean`);
        break;
      default:
        throw scimBadRequest(`filtering Users on "${term.attr}" is not supported`, 'invalidFilter');
    }
  }
  return clauses.map((c) => ` AND ${c}`).join('');
}

export async function listScimUsers(ctx: ScimContext, terms: FilterTerm[], page: Page): Promise<Record<string, unknown>> {
  const params: unknown[] = [ctx.provider.id];
  const where = userFilterSql(terms, params);
  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(DISTINCT u.id) AS count FROM user_identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider_id = $1 AND i.scim_deleted_at IS NULL AND NOT u.is_system${where}`,
    params,
  );
  const total = Number(countRow?.count ?? 0);
  if (page.count === 0) return listResponse([], total, page);
  const rows = await query<UserRow>(
    `SELECT * FROM (${USER_SELECT}${where} ${USER_ORDER}) x ORDER BY x.created_at, x.id OFFSET $${params.length + 1} LIMIT $${params.length + 2}`,
    [...params, page.startIndex - 1, page.count],
  );
  return listResponse(
    rows.map((r) => toScimUser(ctx, r)),
    total,
    page,
  );
}

// ---------------------------------------------------------------------------
// The attributes Folio keeps
// ---------------------------------------------------------------------------

/** What a SCIM User says that Folio uses. `undefined` = not mentioned (PATCH). */
interface UserDoc {
  userName: string;
  externalId: string | null;
  displayName: string | null;
  name: ScimName;
  email: string | null;
  active: boolean;
}

/** The work email, else the primary one, else the first. */
function pickEmail(emails: readonly ScimEmail[] | null | undefined): string | null {
  if (!emails || emails.length === 0) return null;
  const isPrimary = (e: ScimEmail) => e.primary === true || (typeof e.primary === 'string' && e.primary.toLowerCase() === 'true');
  const chosen = emails.find((e) => e.type?.toLowerCase() === 'work') ?? emails.find(isPrimary) ?? emails[0];
  return chosen.value.trim() || null;
}

function cleanName(name: ScimName | null | undefined): ScimName {
  const out: ScimName = {};
  for (const key of ['formatted', 'givenName', 'familyName', 'middleName'] as const) {
    const v = name?.[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim();
  }
  return out;
}

/** The Folio display name: displayName, else name.formatted, else given + family, else the email. */
function folioName(doc: UserDoc, email: string): string {
  const parts = [doc.name.givenName, doc.name.familyName].filter(Boolean).join(' ');
  return (doc.displayName?.trim() || doc.name.formatted?.trim() || parts || email).slice(0, 200);
}

/** The account email: the chosen email, else the userName when it is one. 400 otherwise. */
function accountEmail(doc: UserDoc): string {
  const email = (doc.email ?? (EMAIL_RE.test(doc.userName) ? doc.userName : '')).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw scimBadRequest('the user needs an email: a work email in "emails", or an email-shaped userName');
  return email;
}

function assertDomainAllowed(provider: AuthProvider, email: string): void {
  if (provider.allowedDomains.length > 0 && !providers.domainAllowed(provider, email)) {
    throw scimBadRequest(`the email domain of ${email} is not in the allowed domains of the "${provider.slug}" provider`);
  }
}

function docFromInput(body: unknown): UserDoc {
  const input = parseScim(scimUserSchema, body);
  return {
    userName: input.userName,
    externalId: input.externalId?.trim() || null,
    displayName: input.displayName?.trim() || null,
    name: cleanName(input.name),
    email: pickEmail(input.emails),
    active: input.active === undefined || input.active === null ? true : scimBoolean(input.active),
  };
}

function docFromRow(row: UserRow): UserDoc {
  const attrs = row.scim_attributes ?? {};
  return {
    userName: row.scim_user_name ?? row.email,
    externalId: row.scim_external_id,
    displayName: attrs.displayName ?? row.name,
    name: cleanName(attrs.name),
    email: row.email,
    active: !row.disabled,
  };
}

function auditMeta(ctx: ScimContext, extra: Record<string, unknown>): Record<string, unknown> {
  return { provider: ctx.provider.slug, ...extra };
}

async function externalIdTaken(ctx: ScimContext, externalId: string | null, exceptUserId?: string): Promise<boolean> {
  if (!externalId) return false;
  const row = await queryOne<{ user_id: string }>('SELECT user_id FROM user_identities WHERE provider_id = $1 AND scim_external_id = $2 AND scim_deleted_at IS NULL', [ctx.provider.id, externalId]);
  return Boolean(row && row.user_id !== exceptUserId);
}

async function writeIdentity(identityId: string, doc: UserDoc, extra: { revive?: boolean } = {}): Promise<void> {
  try {
    await query(
      `UPDATE user_identities SET scim_provisioned = true, scim_external_id = $2, scim_user_name = $3, scim_attributes = $4::jsonb,
              scim_updated_at = now(), scim_deleted_at = CASE WHEN $5 THEN NULL ELSE scim_deleted_at END
        WHERE id = $1`,
      [identityId, doc.externalId, doc.userName, JSON.stringify({ name: doc.name, ...(doc.displayName ? { displayName: doc.displayName } : {}) }), extra.revive === true],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw scimConflict('another user of this provider already has this externalId');
    throw err;
  }
}

async function insertPlaceholder(ctx: ScimContext, userId: string, email: string, doc: UserDoc): Promise<string> {
  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO user_identities (user_id, provider_id, issuer, subject, email, scim_provisioned, scim_external_id, scim_user_name, scim_attributes, scim_updated_at)
       VALUES ($1::uuid, $2, $3, $1::text, $4, true, $5, $6, $7::jsonb, now()) RETURNING id`,
      [userId, ctx.provider.id, placeholderIssuer(ctx.provider.id), email, doc.externalId, doc.userName, JSON.stringify({ name: doc.name, ...(doc.displayName ? { displayName: doc.displayName } : {}) })],
    );
    return row!.id;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw scimConflict('another user of this provider already has this externalId');
    throw err;
  }
}

/** active:false / DELETE -> deactivated (all access revoked by updateUser); the last active instance admin is refused. */
async function setActive(ctx: ScimContext, userId: string, active: boolean, wasActive: boolean, extra: Record<string, unknown> = {}): Promise<void> {
  if (active === wasActive && !extra.deleted) return;
  if (!active) {
    if (await store.wouldRemoveLastActiveAdmin(userId, { disabled: true })) {
      throw scimConflict('this is the last active instance administrator of Folio: it cannot be deactivated over SCIM', 'mutability');
    }
    await store.updateUser(userId, { disabled: true }, { actorId: null });
    if (wasActive || extra.deleted) recordAudit(null, 'scim.user_disable', userId, auditMeta(ctx, extra));
  } else {
    await store.updateUser(userId, { disabled: false }, { actorId: null });
    recordAudit(null, 'scim.user_enable', userId, auditMeta(ctx, extra));
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createScimUser(ctx: ScimContext, body: unknown): Promise<Record<string, unknown>> {
  const doc = docFromInput(body);
  const email = accountEmail(doc);
  assertDomainAllowed(ctx.provider, email);

  const clash = await queryOne<{ id: string }>(
    `SELECT u.id FROM user_identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider_id = $1 AND i.scim_deleted_at IS NULL AND NOT u.is_system
        AND (lower(COALESCE(i.scim_user_name, u.email::text)) = lower($2) OR lower(u.email::text) = lower($3))
      LIMIT 1`,
    [ctx.provider.id, doc.userName, email],
  );
  if (clash) throw scimConflict(`a user with userName or email ${doc.userName} already exists for this provider`);
  if (await externalIdTaken(ctx, doc.externalId)) throw scimConflict('another user of this provider already has this externalId');

  const existing = await store.findStoredUserByEmail(email);
  let userId: string;
  let how: 'created' | 'adopted' | 'revived';
  if (existing) {
    if (existing.isSystem) throw scimConflict('this email belongs to a built-in account');
    const identities = await providers.listIdentitiesForUser(existing.id);
    const own = identities.find((i) => i.providerId === ctx.provider.id);
    if (own) {
      // Only a SCIM-deleted account reaches here (a visible one clashed above): revive it.
      await writeIdentity(own.id, doc, { revive: true });
      how = 'revived';
    } else {
      // Owner decision 22.10.2026/23.10.2026: take over an existing account only if its domain is allowed, it is not an
      // instance admin and not linked to another provider; otherwise 409. Taking over creates a placeholder that the
      // matching sign-in email completes (identities.ts 2b), so this gate is what keeps a stranger's account safe.
      if (identities.length > 0) throw scimConflict(`a Folio account with the email ${email} exists and belongs to another sign-in provider`);
      if (existing.isAdmin) {
        throw scimConflict(`a Folio account with the email ${email} exists and is an instance administrator: it is not taken over by SCIM. The person can link it by signing in through the provider once.`);
      }
      if (ctx.provider.allowedDomains.length === 0) {
        throw scimConflict(`a Folio account with the email ${email} already exists; list its domain in the provider's allowed domains to let SCIM take it over`);
      }
      await insertPlaceholder(ctx, existing.id, email, doc);
      how = 'adopted';
    }
    userId = existing.id;
    const name = folioName(doc, email);
    if (name !== existing.name) await store.updateUser(userId, { name });
    await setActive(ctx, userId, doc.active, !existing.disabled, { via: how });
  } else {
    const user = await store.createUser({ email, name: folioName(doc, email), isAdmin: false, passwordHash: null });
    userId = user.id;
    try {
      await insertPlaceholder(ctx, userId, email, doc);
    } catch (err) {
      await query('DELETE FROM users WHERE id = $1', [userId]); // no half-provisioned account left behind
      throw err;
    }
    how = 'created';
    if (!doc.active) await store.updateUser(userId, { disabled: true }, { actorId: null });
  }
  recordAudit(null, 'scim.user_create', userId, auditMeta(ctx, { email, userName: doc.userName, externalId: doc.externalId, active: doc.active, ...(how !== 'created' ? { via: how } : {}) }));
  return getScimUser(ctx, userId);
}

// ---------------------------------------------------------------------------
// Replace / patch
// ---------------------------------------------------------------------------

async function applyDoc(ctx: ScimContext, row: UserRow, next: UserDoc): Promise<void> {
  const before = docFromRow(row);
  const email = accountEmail(next);
  const changed: string[] = [];
  if (email !== row.email.toLowerCase()) {
    assertDomainAllowed(ctx.provider, email);
    const other = await store.findStoredUserByEmail(email);
    if (other && other.id !== row.id) throw scimConflict(`another Folio account already uses the email ${email}`);
    await query('UPDATE users SET email = $2 WHERE id = $1', [row.id, email]);
    await query('UPDATE user_identities SET email = $2 WHERE id = $1', [row.identity_id, email]);
    changed.push('email');
  }
  if (next.externalId !== before.externalId) {
    if (await externalIdTaken(ctx, next.externalId, row.id)) throw scimConflict('another user of this provider already has this externalId');
    changed.push('externalId');
  }
  if (next.userName !== (row.scim_user_name ?? row.email)) changed.push('userName');
  const name = folioName(next, email);
  if (name !== row.name) {
    await store.updateUser(row.id, { name });
    changed.push('name');
  } else if (JSON.stringify(next.name) !== JSON.stringify(before.name)) changed.push('name');
  await writeIdentity(row.identity_id, next);
  if (changed.length > 0) recordAudit(null, 'scim.user_update', row.id, auditMeta(ctx, { changed, email }));
  await setActive(ctx, row.id, next.active, !row.disabled);
}

export async function replaceScimUser(ctx: ScimContext, id: string, body: unknown): Promise<Record<string, unknown>> {
  const row = await requireRow(ctx, id);
  const input = docFromInput(body);
  // PUT replaces, but an omitted `active` keeps the account's state (some clients leave it out of a profile update).
  const activeGiven = typeof body === 'object' && body !== null && 'active' in body && (body as { active?: unknown }).active != null;
  await applyDoc(ctx, row, { ...input, active: activeGiven ? input.active : !row.disabled });
  return getScimUser(ctx, id);
}

/** One PATCH path (or one key of a path-less value object) applied to the document. Unknown attributes are ignored. */
function applyUserPath(doc: UserDoc, rawPath: string, op: 'add' | 'replace' | 'remove', value: unknown): void {
  const path = stripCoreUrn(rawPath).trim();
  const lower = path.toLowerCase().replace(/\s+/g, ' ');
  const text = (what: string): string | null => {
    if (op === 'remove') return null;
    if (value === null) return null;
    if (typeof value !== 'string') throw scimBadRequest(`"${what}" must be a string`);
    return value.trim() || null;
  };
  switch (lower) {
    case 'active':
      if (op !== 'remove') doc.active = scimBoolean(value);
      return;
    case 'username': {
      const v = text('userName');
      if (!v) throw scimBadRequest('userName cannot be removed', 'mutability');
      doc.userName = v;
      return;
    }
    case 'externalid':
      doc.externalId = text('externalId');
      return;
    case 'displayname':
      doc.displayName = text('displayName');
      return;
    case 'name.givenname':
    case 'name.familyname':
    case 'name.formatted':
    case 'name.middlename': {
      const key = ({ 'name.givenname': 'givenName', 'name.familyname': 'familyName', 'name.formatted': 'formatted', 'name.middlename': 'middleName' } as const)[lower];
      const v = text(path);
      doc.name = { ...doc.name, [key]: v ?? undefined };
      return;
    }
    case 'name':
      if (op === 'remove') doc.name = {};
      else if (typeof value === 'object' && value !== null) doc.name = { ...(op === 'replace' ? {} : doc.name), ...cleanName(value as ScimName) };
      else throw scimBadRequest('"name" must be an object');
      return;
    case 'emails':
      if (op === 'remove') return; // the account keeps its email: Folio needs one
      if (Array.isArray(value)) {
        const parsed = value.filter((e): e is ScimEmail => typeof e === 'object' && e !== null && typeof (e as ScimEmail).value === 'string');
        const email = pickEmail(parsed);
        if (email) doc.email = email;
        return;
      }
      throw scimBadRequest('"emails" must be an array');
    default:
      if (/^emails\[type eq "work"\]\.value$/i.test(path) || /^emails\[primary eq true\]\.value$/i.test(path) || lower === 'emails.value') {
        if (op === 'remove') return;
        const v = text('emails.value');
        if (v) doc.email = v;
        return;
      }
      // title, addresses, phoneNumbers, preferredLanguage, the enterprise extension, password...: not kept by Folio.
      return;
  }
}

export async function patchScimUser(ctx: ScimContext, id: string, body: unknown): Promise<Record<string, unknown>> {
  const ops = parsePatch(body);
  const row = await requireRow(ctx, id);
  const doc = docFromRow(row);
  for (const op of ops) {
    if (op.path) {
      applyUserPath(doc, op.path, op.op, op.value);
      continue;
    }
    // Path-less (Entra, Okta): {"op": "replace", "value": {"active": false, "name.givenName": "Ada", "emails[type eq \"work\"].value": "…"}}
    if (typeof op.value !== 'object' || op.value === null || Array.isArray(op.value)) throw scimBadRequest('a PATCH operation without a path needs an object value', 'invalidSyntax');
    for (const [key, value] of Object.entries(op.value as Record<string, unknown>)) {
      if (key === 'schemas' || key === 'id' || key === 'meta') continue;
      applyUserPath(doc, key, op.op, value);
    }
  }
  await applyDoc(ctx, row, doc);
  return getScimUser(ctx, id);
}

export async function deleteScimUser(ctx: ScimContext, id: string): Promise<void> {
  const row = await requireRow(ctx, id);
  await setActive(ctx, row.id, false, !row.disabled, { deleted: true });
  await query('UPDATE user_identities SET scim_deleted_at = now(), scim_updated_at = now() WHERE provider_id = $1 AND user_id = $2', [ctx.provider.id, row.id]);
}
