/**
 * Page properties (Obsidian brief, wave 3): a document's front matter, read and
 * edited OUTSIDE the collaborative body. The collab room holds the body only
 * (storage.ts readFreshDocBody strips the block before a room is seeded), so a
 * properties save rewrites the block in the FILE, byte-preserving the body and
 * everything it does not change (frontmatter.ts writeFrontmatterKeys), under
 * the same per-page file lock as the room's write-back
 * (storage.ts rewriteDocFrontmatter / withDocFileLock).
 *
 *   GET /api/pages/:id/properties  (viewer+)  -> PagePropertiesResponse
 *   PUT /api/pages/:id/properties  (editor+, cookie or write-scope PAT) body UpdatePagePropertiesBody
 *       -> PagePropertiesResponse; 409 + the current response on an etag mismatch
 *
 * Read: the block as it is in the file now (the index row's jsonb when the file
 * cannot be read). Values go out JSON-shaped: a YAML date as `YYYY-MM-DD`, a
 * timestamp as `YYYY-MM-DDTHH:MM:SS` (UTC, as YAML reads one without a zone).
 * `foreign` lists Folio's own keys whose value Folio would not write itself
 * (owner's decision 4: `status: deprecated`, a non-numeric `order`, an empty
 * `icon`, an `id` that is not this page's); `readOnly` is `id`; `etag` is the
 * sha1 of the block's bytes (null without a block). `canEdit` is false for a
 * reader, a read-only token, a non-document page and a block YAML refuses.
 *
 * Write rules (PUT replaces the editable keys with `properties`):
 *  - `id` can never change: a different value (or one the file does not have) is a 400;
 *    leaving it out keeps it.
 *  - Folio's keys (`order`, `status`, `icon`, `cover`) are validated as Folio
 *    reads them (status draft/published/archived, a finite number, a non-empty
 *    string; a numeric string is taken as a number for `order`); sending the
 *    value the file has keeps it as is, foreign or not; `null` removes the key;
 *    leaving one out removes it — EXCEPT a foreign value, which stays unless the
 *    client sends the key (owner's decision 4: never rewrite another tool's value
 *    by omission).
 *  - `tags` / `labels:` (its Obsidian synonym): new tags are written as `tags:`;
 *    an existing `labels:` is never removed or migrated by Folio — left out it
 *    stays as it is (only an explicit `labels: null` removes it), a changed one
 *    is written in place under `labels:`, and on a page whose only list is
 *    `labels:` a `tags` sent alone (the panel's tags row, built from `labels:`)
 *    is written in place under `labels:` too. A `labels` the file does not have
 *    is written as `tags:`. Tags lose a leading `#`, empty ones and duplicates.
 *  - every other key: sent and different -> set (in place; a new key is appended
 *    to the block in the order of `properties`); sent and equal -> untouched,
 *    the file's own spelling kept; not sent -> removed. `null` writes `key:`, an
 *    empty property as Obsidian writes it. With the key's type (space types,
 *    else inferred) a numeric string becomes a number (`number`), `true`/`false`
 *    a boolean (`checkbox`), a string a one-item list (`list`/`aliases`), and a
 *    date/datetime is written unquoted (`due: 2024-05-01`) when YAML reads it
 *    back as that same value.
 *  - key order of untouched keys never changes; renaming is remove + add.
 * Nothing to change: no write, no commit, no audit row. A write: the index row
 * follows (Folio's keys, title, tags, frontmatter jsonb), the debounced
 * auto-commit is nudged like any page save, and the route records
 * `page.properties` with the changed keys.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { PagePropertiesResponse, PropertyType, UpdatePagePropertiesBody } from '../shared/contracts.js';
import { queryOne } from './db/pool.js';
import { badRequest, HttpError } from './errors.js';
import {
  folioCouldHaveWritten,
  parsedEntry,
  readFrontmatterBlock,
  renderFrontmatterEntry,
  UnparseableFrontmatterError,
  writeFrontmatterKeys,
  type FolioKey,
  type FrontmatterKeyEdit,
} from './frontmatter.js';
import { inferPropertyType, readDeclaredTypes } from './propertyTypes.js';
import * as storage from './storage.js';
import type { PageIndexEntry } from './storage.js';

/** Folio's keys other than `id`, which has its own rule. */
const FOLIO_VALUE_KEYS = ['order', 'status', 'icon', 'cover'] as const satisfies readonly FolioKey[];
const FOLIO_VALUE_KEY_SET: ReadonlySet<string> = new Set(FOLIO_VALUE_KEYS);
export const READ_ONLY_PROPERTIES = ['id'] as const;
const MAX_VALUE_DEPTH = 6;

/** 409 of a save whose etag no longer matches; carries the current state for the response body. */
export class PropertiesConflictError extends HttpError {
  constructor(public current: PagePropertiesResponse) {
    super(409, 'the front matter changed since it was read');
  }
}

export function frontmatterEtag(blockText: string): string | null {
  return blockText ? createHash('sha1').update(blockText, 'utf8').digest('hex') : null;
}

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

/** A YAML timestamp as the client sees it: `YYYY-MM-DD` at midnight UTC, else `YYYY-MM-DDTHH:MM:SS[.mmm]` (UTC). */
function dateText(d: Date): string {
  if (Number.isNaN(d.getTime())) return '';
  const iso = d.toISOString();
  if (iso.endsWith('T00:00:00.000Z')) return iso.slice(0, 10);
  return iso.replace(/\.000Z$/, '').replace(/Z$/, '');
}

/** Parsed front matter -> what the client gets (dates as text, recursively). */
export function toClientValue(value: unknown): unknown {
  if (value instanceof Date) return dateText(value);
  if (Array.isArray(value)) return value.map(toClientValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toClientValue(v)]));
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
    }
    return v;
  });
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function hasOwn(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** A key name the block can hold on one line. */
function assertKey(key: string): void {
  if (key.trim() !== key || /[\u0000-\u001f\u007f]/.test(key)) throw badRequest(`invalid property name: ${JSON.stringify(key)}`);
}

/** null, strings, finite numbers, booleans, and lists/maps of them. */
function assertValue(key: string, value: unknown, depth = 0): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
  } else if (depth < MAX_VALUE_DEPTH && Array.isArray(value)) {
    for (const item of value) assertValue(key, item, depth + 1);
    return;
  } else if (depth < MAX_VALUE_DEPTH && value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertKey(k);
      assertValue(key, v, depth + 1);
    }
    return;
  }
  throw badRequest(`invalid value for property ${JSON.stringify(key)}`);
}

/** A sent value with the key's type applied (see the module comment). */
function coerce(value: unknown, type: PropertyType): unknown {
  if (type === 'number' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  if (type === 'checkbox' && (value === 'true' || value === 'false')) return value === 'true';
  if ((type === 'list' || type === 'aliases') && typeof value === 'string') return value === '' ? [] : [value];
  return value;
}

/** Tags as written: no leading `#`, no empty ones, no duplicates. A string is split on commas and whitespace. */
function normalizeTags(value: unknown): unknown {
  if (value === null) return null;
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : null;
  if (items === null) throw badRequest('tags must be a list of strings');
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string' && typeof item !== 'number') throw badRequest('tags must be a list of strings');
    const tag = String(item).trim().replace(/^#+/, '').trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** A Folio key's new value, validated the way Folio reads it back (storage.ts numericOrder / validStatus / validStringField). */
function folioValue(key: (typeof FOLIO_VALUE_KEYS)[number], value: unknown): unknown {
  switch (key) {
    case 'order': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n === 'number' && Number.isFinite(n)) return n;
      throw badRequest('order must be a number');
    }
    case 'status':
      if (value === 'draft' || value === 'published' || value === 'archived') return value;
      throw badRequest('status must be draft, published or archived');
    case 'icon':
    case 'cover':
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
      throw badRequest(`${key} must be a non-empty string`);
  }
}

const DATE_VALUE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** `key: 2024-05-01` unquoted, when YAML reads that line back as the value sent (a date, or the same string); else js-yaml's own rendering. */
function dateLines(key: string, value: unknown, type: PropertyType): string[] | undefined {
  if ((type !== 'date' && type !== 'datetime') || typeof value !== 'string' || !DATE_VALUE_RE.test(value)) return undefined;
  const [keyLine] = renderFrontmatterEntry(key, null); // `key:` with the key quoted as YAML needs
  const line = `${keyLine} ${value}`;
  try {
    const parsed = parsedEntry(key, [line]);
    if (parsed instanceof Date ? dateText(parsed) === value : parsed === value) return [line];
  } catch {
    /* js-yaml's rendering below */
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

/** Folio's keys whose current value Folio would not write itself. */
export function foreignFolioKeys(data: Record<string, unknown>, pageId: string): string[] {
  const out: string[] = [];
  if (hasOwn(data, 'id') && data.id !== pageId) out.push('id');
  for (const key of FOLIO_VALUE_KEYS) if (hasOwn(data, key) && !folioCouldHaveWritten(key, data[key])) out.push(key);
  return out;
}

/** Effective types: the space's declared types, plus the inferred type of every key the page has that is not declared. */
function effectiveTypes(declared: Record<string, PropertyType>, properties: Record<string, unknown>): Record<string, PropertyType> {
  const types: Record<string, PropertyType> = { ...declared };
  for (const [key, value] of Object.entries(properties)) if (!types[key]) types[key] = inferPropertyType(key, value);
  return types;
}

async function responseFor(entry: PageIndexEntry, raw: string | undefined, roleCanEdit: boolean): Promise<PagePropertiesResponse> {
  const readOnly = [...READ_ONLY_PROPERTIES];
  if (entry.kind !== 'doc') return { properties: {}, types: {}, foreign: [], readOnly, canEdit: false, etag: null };
  const declared = (await readDeclaredTypes(entry.space)).types;
  if (raw === undefined) {
    // The file cannot be read right now: what the index last saw, read-only.
    const row = await queryOne<{ frontmatter: Record<string, unknown> | null }>('SELECT frontmatter FROM pages_index WHERE id = $1', [entry.id]);
    const properties = row?.frontmatter && typeof row.frontmatter === 'object' ? row.frontmatter : {};
    return { properties, types: effectiveTypes(declared, properties), foreign: foreignFolioKeys(properties, entry.id), readOnly, canEdit: false, etag: null };
  }
  const block = readFrontmatterBlock(raw);
  const properties = toClientValue(block.data) as Record<string, unknown>;
  return {
    properties,
    types: effectiveTypes(declared, properties),
    foreign: foreignFolioKeys(block.data, entry.id),
    readOnly,
    canEdit: roleCanEdit && block.parseable,
    etag: frontmatterEtag(block.text),
  };
}

/** GET /api/pages/:id/properties for a page the caller may read; `roleCanEdit` = editor+ with a token that may write. */
export async function readPageProperties(entry: PageIndexEntry, roleCanEdit: boolean): Promise<PagePropertiesResponse> {
  const raw = entry.kind === 'doc' ? await fs.readFile(entry.absPath, 'utf8').catch(() => undefined) : undefined;
  return responseFor(entry, raw, roleCanEdit);
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

/**
 * The key edits that turn the block `current` (as parsed) into `sent` under
 * the write rules of the module comment. Only keys that actually change.
 */
export function planPropertyEdits(current: Record<string, unknown>, sent: Record<string, unknown>, declared: Record<string, PropertyType>): Map<string, FrontmatterKeyEdit> {
  const client = toClientValue(current) as Record<string, unknown>;
  const present = (key: string) => hasOwn(current, key);
  const sentHas = (key: string) => hasOwn(sent, key) && sent[key] !== undefined;
  const edits = new Map<string, FrontmatterKeyEdit>();
  const remove = (key: string) => {
    if (present(key)) edits.set(key, { remove: true });
  };
  const setUnlessSame = (key: string, value: unknown, lines?: string[]) => {
    if (present(key) && same(client[key], value)) return;
    edits.set(key, lines ? { set: value, lines } : { set: value });
  };

  for (const key of Object.keys(sent)) {
    assertKey(key);
    if (sent[key] !== undefined) assertValue(key, sent[key]);
  }

  // id: immutable.
  if (sentHas('id') && !same(client.id, sent.id)) throw badRequest('id cannot be changed');

  // Folio's own keys.
  for (const key of FOLIO_VALUE_KEYS) {
    if (sentHas(key)) {
      const value = sent[key];
      if (value === null) remove(key);
      else if (!(present(key) && same(client[key], value))) setUnlessSame(key, folioValue(key, value));
    } else if (present(key) && folioCouldHaveWritten(key, current[key])) {
      remove(key); // a foreign value stays unless the client names the key
    }
  }

  // tags and its synonym `labels:` (owner's rule: Folio writes `tags:` for new tags,
  // never deletes or migrates an existing `labels:`).
  const changed = (key: string, value: unknown) => !(present(key) && same(client[key], value));
  if (sentHas('tags')) {
    // A page whose only list is `labels:` shows it as its tags row (web toDisplayProperties),
    // so an edited row comes back as `tags` alone: it is written in place under `labels:`.
    const target = !present('tags') && present('labels') && !sentHas('labels') ? 'labels' : 'tags';
    const value = normalizeTags(sent.tags);
    if (changed(target, sent.tags)) setUnlessSame(target, value);
  } else if (!(sentHas('labels') && !present('labels'))) {
    remove('tags');
  }
  if (sentHas('labels')) {
    if (sent.labels === null && present('labels')) remove('labels');
    else if (present('labels')) {
      if (changed('labels', sent.labels)) setUnlessSame('labels', normalizeTags(sent.labels));
    } else if (sent.labels !== null) {
      // No `labels:` in the file: new tags are written as `tags:` (joined to the sent tags, if any).
      const extra = normalizeTags(sent.labels) as string[];
      const base = sentHas('tags') ? ((normalizeTags(sent.tags) as string[] | null) ?? []) : [];
      const merged = normalizeTags([...base, ...extra]);
      if (changed('tags', merged)) edits.set('tags', { set: merged });
    }
  }
  // `labels` not sent: kept as the file has it (never removed by omission).

  // Everything else: the file's keys first (kept or removed), then the new ones in the order they were sent.
  const special = (key: string) => key === 'id' || key === 'tags' || key === 'labels' || FOLIO_VALUE_KEY_SET.has(key);
  const keys = [...Object.keys(current), ...Object.keys(sent).filter((k) => !present(k))];
  for (const key of keys) {
    if (special(key)) continue;
    if (!sentHas(key)) {
      remove(key);
      continue;
    }
    const raw = sent[key];
    if (present(key) && same(client[key], raw)) continue;
    const type = declared[key] ?? inferPropertyType(key, present(key) ? client[key] : raw);
    const value = coerce(raw, type);
    setUnlessSame(key, value, dateLines(key, value, type));
  }
  return edits;
}

export interface PropertiesWriteResult {
  response: PagePropertiesResponse;
  written: boolean;
  /** Keys set or removed by this save. */
  keys: string[];
}

/** PUT /api/pages/:id/properties for a page the caller may edit (the route checks the role and the token scope). */
export async function updatePageProperties(pageId: string, body: UpdatePagePropertiesBody, roleCanEdit: boolean): Promise<PropertiesWriteResult> {
  let keys: string[] = [];
  const { entry, written } = await storage.rewriteDocFrontmatter(pageId, async (raw, current) => {
    const block = readFrontmatterBlock(raw);
    if (!block.parseable) throw badRequest('the front matter of this page cannot be parsed; fix it in the file first');
    if (body.etag !== undefined && body.etag !== frontmatterEtag(block.text)) {
      throw new PropertiesConflictError(await responseFor(current, raw, roleCanEdit));
    }
    const declared = (await readDeclaredTypes(current.space)).types;
    const edits = planPropertyEdits(block.data, body.properties, declared);
    keys = [...edits.keys()];
    if (edits.size === 0) return null;
    try {
      return writeFrontmatterKeys(raw, edits);
    } catch (err) {
      if (err instanceof UnparseableFrontmatterError) throw badRequest('the front matter of this page cannot be parsed; fix it in the file first');
      throw err;
    }
  });
  return { response: await readPageProperties(entry, roleCanEdit), written, keys: written ? keys : [] };
}
