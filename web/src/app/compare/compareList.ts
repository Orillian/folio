/**
 * The compare list — pure helpers (no React, no storage), so the rules are testable on their own.
 *
 * Two shapes live here, deliberately different:
 *  - `CompareItem`, an entry of the reader's own list (kept in this browser's localStorage): carries the title and
 *    the space name as they were when the page was added, only so the tray can show something readable;
 *  - `CompareRef`, an entry of a compare URL (`/compare?items=<id>,<id>@<sha>,…`): just the page id and, for a
 *    version from the page's history, its commit. Everything else is fetched by whoever opens the link, with THEIR
 *    rights — a link carries no content and no titles.
 */
export interface CompareRef {
  pageId: string;
  /** A commit of the page's history. Absent: the page as it is now (a live editor). */
  sha?: string;
}

export interface CompareItem extends CompareRef {
  space: string;
  title: string;
}

/** The most columns the compare view shows side by side. */
export const MAX_COMPARE = 5;
export const COMPARE_STORAGE_KEY = 'folio:compare';

const PAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA = /^[0-9a-f]{7,64}$/i;

/** One entry's identity: the same page can be compared with its own versions, but never twice as the same column. */
export function compareKey(ref: CompareRef): string {
  return ref.sha ? `${ref.pageId}@${ref.sha}` : ref.pageId;
}

/** `?items=` -> refs. Garbage and duplicates are dropped silently, extras beyond the limit are cut: a hand-edited or stale link still opens. */
export function parseCompareParam(param: string | null | undefined): CompareRef[] {
  if (!param) return [];
  const seen = new Set<string>();
  const refs: CompareRef[] = [];
  for (const part of param.split(',')) {
    const [pageId, sha, ...rest] = part.trim().split('@');
    if (rest.length > 0 || !pageId || !PAGE_ID.test(pageId)) continue;
    if (sha !== undefined && !SHA.test(sha)) continue;
    const ref: CompareRef = sha ? { pageId, sha: sha.toLowerCase() } : { pageId };
    const key = compareKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
    if (refs.length >= MAX_COMPARE) break;
  }
  return refs;
}

export function serializeCompareParam(refs: CompareRef[]): string {
  return refs.map(compareKey).join(',');
}

/** The compare view's address for a set of columns, in order (the leftmost is the base for highlighting). */
export function comparePath(refs: CompareRef[]): string {
  return `/compare?items=${serializeCompareParam(refs)}`;
}

export type AddResult = 'added' | 'duplicate' | 'full';

export function addCompareItem(list: CompareItem[], item: CompareItem): { list: CompareItem[]; result: AddResult } {
  if (list.some((entry) => compareKey(entry) === compareKey(item))) return { list, result: 'duplicate' };
  if (list.length >= MAX_COMPARE) return { list, result: 'full' };
  return { list: [...list, item], result: 'added' };
}

/** What was stored, if it still looks like a list (storage is the reader's to edit, and old builds may differ). */
export function parseStoredList(raw: string | null): CompareItem[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  let list: CompareItem[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { pageId, sha, space, title } = entry as Record<string, unknown>;
    if (typeof pageId !== 'string' || !PAGE_ID.test(pageId)) continue;
    if (sha !== undefined && (typeof sha !== 'string' || !SHA.test(sha))) continue;
    const item: CompareItem = { pageId, space: typeof space === 'string' ? space : '', title: typeof title === 'string' ? title : pageId };
    if (typeof sha === 'string') item.sha = sha;
    list = addCompareItem(list, item).list;
  }
  return list;
}
