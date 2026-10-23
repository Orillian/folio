import type { AuditLogQuery } from '@shared/contracts';

/** Filter state of the audit screen; every value is a raw input value, '' = not set. */
export interface AuditFilters {
  actor: string;
  action: string;
  target: string;
  from: string;
  to: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilters = { actor: '', action: '', target: '', from: '', to: '' };

export const AUDIT_PAGE_SIZE = 50;

/** Prefixes offered in the action filter (the server matches any prefix; these are just the families Folio writes). */
export const ACTION_FAMILIES = [
  'access.',
  'space.',
  'page.',
  'table.',
  'user.',
  'session.',
  'group.',
  'auth.',
  'scim.',
  'share.',
  'invite.',
  'token.',
  'oauth.',
  'chat.',
  'assistant.',
  'audit.',
] as const;

export function filtersToQuery(filters: AuditFilters): AuditLogQuery {
  return {
    actor: filters.actor || undefined,
    action: filters.action.trim() || undefined,
    target: filters.target.trim() || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
  };
}

export function hasActiveFilters(filters: AuditFilters): boolean {
  return Object.values(filters).some((v) => v.trim() !== '');
}

/** Filters from the page's query string (a link from elsewhere can open the screen pre-filtered). */
export function filtersFromSearch(search: URLSearchParams): AuditFilters {
  const get = (key: keyof AuditFilters): string => search.get(key) ?? '';
  return { actor: get('actor'), action: get('action'), target: get('target'), from: get('from'), to: get('to') };
}

/** `page.file.replaced` -> `audit.action.page_file_replaced` (a flat i18n key: dots would nest, and some actions contain `-`). */
export function actionLabelKey(action: string): string {
  return `audit.action.${action.replace(/[^A-Za-z0-9]+/g, '_')}`;
}

/**
 * The action to label an event by. Before `group.restore` existed an unarchive was logged as `group.archive`
 * with `archived: false` in meta; such old events read as restored. (Filtering still uses the stored action.)
 */
export function displayAction(action: string, meta: Record<string, unknown> | null | undefined): string {
  return action === 'group.archive' && meta?.archived === false ? 'group.restore' : action;
}

const MAX_VALUE_LENGTH = 80;

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const json = JSON.stringify(value);
  return json.length > MAX_VALUE_LENGTH ? `${json.slice(0, MAX_VALUE_LENGTH)}…` : json;
}

/** The meta of an event as short `key: value` parts, in the order stored; empty values skipped. Unknown actions render the same way, so nothing is hidden. */
export function metaParts(meta: Record<string, unknown> | null): Array<{ key: string; value: string }> {
  if (!meta) return [];
  return Object.entries(meta)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => ({ key, value: formatValue(value) }));
}

/** "Chrome on macOS" from a User-Agent; falls back to the raw (already truncated) string. Order matters: Edge and Opera also say Chrome, Chrome also says Safari. */
export function describeUserAgent(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const browser =
    /Edg\//.test(userAgent) ? 'Edge'
    : /OPR\/|Opera/.test(userAgent) ? 'Opera'
    : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari'
    : undefined;
  const os =
    /Windows/.test(userAgent) ? 'Windows'
    : /Android/.test(userAgent) ? 'Android'
    : /iPhone|iPad|iPod/.test(userAgent) ? 'iOS'
    : /Mac OS X|Macintosh/.test(userAgent) ? 'macOS'
    : /Linux|X11/.test(userAgent) ? 'Linux'
    : undefined;
  if (browser && os) return `${browser} · ${os}`;
  return browser ?? os ?? userAgent.slice(0, 60);
}
