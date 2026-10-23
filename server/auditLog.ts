/**
 * Reading the instance audit log (the /admin/audit screen and its CSV export). Writing is
 * server/audit.ts (recordAudit); the older per-space "access changes" feed is
 * auth/store.ts listAccessLogForSpace and stays as it is.
 *
 * Pages by keyset on audit_log.id (bigserial, so newest-first is `ORDER BY id DESC`): a cursor
 * is the id of the last row of the previous page, which stays correct while new rows arrive.
 */
import type { AuditLogEvent, AuditLogPage, AuditLogQuery } from '../shared/contracts.js';
import { query } from './db/pool.js';

export const AUDIT_PAGE_DEFAULT = 50;
/** Hard cap of one CSV export, so an unbounded filter cannot turn into an unbounded response. */
export const AUDIT_EXPORT_MAX_ROWS = 100_000;
const EXPORT_BATCH = 1000;

interface Row {
  id: string;
  at: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  target: string | null;
  meta: Record<string, unknown> | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Readable names of the targets on one page of events, one batch lookup per kind (no query per row).
 * A target is a user / group / provider / token id (uuid), a page id or a space slug. Resolution order:
 * uuid -> user, group, auth provider, API token; then page title, then space name. A target that
 * resolves nowhere (deleted, or not an entity at all) falls back to the name the event itself recorded
 * (`groupName` for group events), else null, and the screen shows the raw id.
 */
export async function resolveTargetNames(rows: Array<Pick<Row, 'action' | 'target' | 'meta'>>): Promise<Map<string, string>> {
  const targets = [...new Set(rows.map((r) => r.target).filter((t): t is string => !!t))];
  const names = new Map<string, string>();
  if (targets.length === 0) return names;
  const uuids = targets.filter((t) => UUID_RE.test(t));
  if (uuids.length > 0) {
    const sources: Array<[string, string]> = [
      ['SELECT id::text AS id, name, email::text AS extra FROM users WHERE id = ANY($1::uuid[])', 'user'],
      ['SELECT id::text AS id, name, NULL AS extra FROM groups WHERE id = ANY($1::uuid[])', 'group'],
      ['SELECT id::text AS id, display_name AS name, NULL AS extra FROM auth_providers WHERE id = ANY($1::uuid[])', 'provider'],
      ['SELECT id::text AS id, name, NULL AS extra FROM api_tokens WHERE id = ANY($1::uuid[])', 'token'],
    ];
    for (const [sql, kind] of sources) {
      const found = await query<{ id: string; name: string; extra: string | null }>(sql, [uuids.filter((u) => !names.has(u))]);
      for (const row of found) if (!names.has(row.id)) names.set(row.id, kind === 'user' && row.extra ? `${row.name} (${row.extra})` : row.name);
    }
  }
  const rest = targets.filter((t) => !names.has(t));
  if (rest.length > 0) {
    const pages = await query<{ id: string; title: string }>('SELECT id, title FROM pages_index WHERE id = ANY($1::text[])', [rest]);
    for (const row of pages) names.set(row.id, row.title);
    const spaces = await query<{ slug: string; name: string }>('SELECT slug, name FROM spaces WHERE slug = ANY($1::text[])', [rest.filter((t) => !names.has(t))]);
    for (const row of spaces) names.set(row.slug, row.name);
  }
  // Deleted entities: the event often recorded the name at the time.
  for (const row of rows) {
    if (!row.target || names.has(row.target)) continue;
    const recorded = row.action.startsWith('group.') ? row.meta?.groupName : undefined;
    if (typeof recorded === 'string' && recorded) names.set(row.target, recorded);
  }
  return names;
}

async function withTargetNames(rows: Row[]): Promise<AuditLogEvent[]> {
  const names = await resolveTargetNames(rows);
  return rows.map((row) => rowToEvent(row, row.target ? (names.get(row.target) ?? null) : null));
}

function rowToEvent(row: Row, targetName: string | null = null): AuditLogEvent {
  return {
    id: String(row.id),
    at: new Date(row.at).toISOString(),
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorEmail: row.actor_email,
    action: row.action,
    target: row.target,
    targetName,
    meta: row.meta,
  };
}

/** Escapes LIKE wildcards so a typed prefix like `access_` is literal. */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildWhere(filters: AuditLogQuery, cursor?: string): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    clauses.push(sql.replace('?', `$${params.length}`));
  };
  if (filters.actor) add('al.actor_id = ?::uuid', filters.actor);
  if (filters.action) add("al.action LIKE ? ESCAPE '\\'", likePrefix(filters.action));
  if (filters.target) add('al.target = ?', filters.target);
  // Inclusive UTC day range.
  if (filters.from) add("al.at >= (?::date)::timestamp AT TIME ZONE 'UTC'", filters.from);
  if (filters.to) add("al.at < ((?::date) + 1)::timestamp AT TIME ZONE 'UTC'", filters.to);
  if (cursor) add('al.id < ?::bigint', cursor);
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

async function fetchRows(filters: AuditLogQuery, cursor: string | undefined, limit: number): Promise<Row[]> {
  const { where, params } = buildWhere(filters, cursor);
  params.push(limit);
  return query<Row>(
    `SELECT al.id, al.at, al.actor_id, u.name AS actor_name, u.email AS actor_email, al.action, al.target, al.meta
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.actor_id
       ${where}
      ORDER BY al.id DESC
      LIMIT $${params.length}`,
    params,
  );
}

/** One page of the log, newest first. `nextCursor` is null on the last page. */
export async function listAuditEvents(filters: AuditLogQuery): Promise<AuditLogPage> {
  const limit = filters.limit ?? AUDIT_PAGE_DEFAULT;
  const rows = await fetchRows(filters, filters.cursor, limit + 1);
  const page = rows.slice(0, limit);
  return { events: await withTargetNames(page), nextCursor: rows.length > limit ? String(page[page.length - 1].id) : null };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export const AUDIT_CSV_HEADER = ['id', 'time_utc', 'actor_id', 'actor_name', 'actor_email', 'action', 'target', 'target_name', 'meta'] as const;

/** One CSV cell: quoted when needed, and neutralised against spreadsheet formula injection (a cell starting with = + - @ tab or CR). */
export function csvCell(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  let text = value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function auditEventCsvLine(event: AuditLogEvent): string {
  return (
    [event.id, event.at, event.actorId, event.actorName, event.actorEmail, event.action, event.target, event.targetName, event.meta ? JSON.stringify(event.meta) : null]
      .map((v) => csvCell(v))
      .join(',') + '\r\n'
  );
}

export interface AuditExportResult {
  rows: number;
  truncated: boolean;
}

/**
 * The CSV of the current filter, produced batch by batch (keyset, 1000 rows a time) so memory stays flat,
 * capped at AUDIT_EXPORT_MAX_ROWS. A UTF-8 BOM first, so Excel reads the Cyrillic names right. `result`
 * is filled in as the stream ends (for the audit entry of the export itself).
 */
export async function* auditCsvChunks(filters: AuditLogQuery, result: AuditExportResult = { rows: 0, truncated: false }): AsyncGenerator<string> {
  yield `﻿${AUDIT_CSV_HEADER.join(',')}\r\n`;
  let cursor: string | undefined;
  while (result.rows < AUDIT_EXPORT_MAX_ROWS) {
    const batchSize = Math.min(EXPORT_BATCH, AUDIT_EXPORT_MAX_ROWS - result.rows);
    const rows = await fetchRows({ ...filters, cursor: undefined, limit: undefined }, cursor, batchSize);
    if (rows.length === 0) return;
    let chunk = '';
    for (const event of await withTargetNames(rows)) chunk += auditEventCsvLine(event);
    result.rows += rows.length;
    cursor = String(rows[rows.length - 1].id);
    yield chunk;
    if (rows.length < batchSize) return;
  }
  // The cap was reached: say so in the file itself, a silent cut would read as "that is everything".
  const probe = await fetchRows({ ...filters, cursor: undefined, limit: undefined }, cursor, 1);
  if (probe.length > 0) {
    result.truncated = true;
    yield `# truncated at ${AUDIT_EXPORT_MAX_ROWS} rows; narrow the filter to see the rest\r\n`;
  }
}
