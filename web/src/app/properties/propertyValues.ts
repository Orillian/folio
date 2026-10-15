import type { PagePropertiesResponse, PageStatus, PropertyType } from '@shared/contracts';

/**
 * Pure helpers behind the properties panel: which editor a value gets, how a value is
 * coerced when the user commits it, and how the front matter map maps to what the panel
 * shows (the `labels:` synonym of `tags:`). No React, no I/O — unit-tested on their own.
 */

export const PROPERTY_TYPES: readonly PropertyType[] = ['text', 'number', 'checkbox', 'date', 'datetime', 'list', 'tags', 'aliases'];

/** The values `status:` takes when Folio writes it (pageStatusSchema); anything else is a "foreign value" the server reports. */
export const STATUS_VALUES: readonly PageStatus[] = ['draft', 'published', 'archived'];

/** What the row renders for a value: one of the editors, or a read-only view. */
export type EditorKind = 'text' | 'number' | 'checkbox' | 'date' | 'datetime' | 'chips' | 'status' | 'readonly';

export type Properties = Record<string, unknown>;

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Primitives only: a list of scalars can be chips, a list holding a map or another list cannot. */
export function isFlatList(value: unknown): value is (string | number | boolean)[] {
  return Array.isArray(value) && value.every(isPrimitive);
}

/**
 * Which editor a (key, type, value) triple gets. The declared type wins when the value
 * fits it; a value that does not (a string under a `number` type, say) falls back to what
 * the value actually is, so nothing is ever coerced behind the user's back. Nested maps and
 * lists of maps stay read-only: the panel shows them as JSON and never rewrites them.
 */
export function editorKindFor(key: string, type: PropertyType | undefined, value: unknown): EditorKind {
  if (isPlainObject(value)) return 'readonly';
  if (Array.isArray(value) && !isFlatList(value)) return 'readonly';
  if (key === 'status' && (value === undefined || value === null || (typeof value === 'string' && (STATUS_VALUES as readonly string[]).includes(value)))) {
    return 'status';
  }
  switch (type) {
    case 'list':
    case 'tags':
    case 'aliases':
      // A comma-separated string under a list type (`tags: a, b`) is what Obsidian accepts too.
      if (Array.isArray(value) || typeof value === 'string' || value === null || value === undefined) return 'chips';
      break;
    case 'checkbox':
      if (typeof value === 'boolean') return 'checkbox';
      break;
    case 'number':
      if (typeof value === 'number' || value === null || value === undefined) return 'number';
      break;
    case 'date':
      if (typeof value === 'string' || value === null || value === undefined) return 'date';
      break;
    case 'datetime':
      if (typeof value === 'string' || value === null || value === undefined) return 'datetime';
      break;
    default:
      break;
  }
  if (Array.isArray(value)) return 'chips';
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  return 'text';
}

/** The chips a list-like value shows: an array as is, a string split on commas, nothing for null. */
export function chipsOf(value: unknown, type?: PropertyType): string[] {
  if (Array.isArray(value)) return value.filter(isPrimitive).map((item) => String(item));
  if (typeof value === 'string') {
    const parts = type === 'tags' ? value.split(/[\s,]+/) : value.split(',');
    return parts.map((part) => part.trim()).filter(Boolean);
  }
  return [];
}

const TAG_CHARS = /^[\p{L}\p{N}\p{M}_\-/]+$/u;

/**
 * A tag as the index stores it (server/indexV2/parse.ts normalizeTag): no `#`, lowercased,
 * no doubled or edge slashes, at least one letter. Null when what was typed is not a tag.
 */
export function normalizeTagInput(raw: string): string | null {
  const tag = raw.trim().replace(/^#+/, '').trim().replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!tag || !/\p{L}/u.test(tag) || !TAG_CHARS.test(tag)) return null;
  return tag;
}

/** A chip typed into a list-like property, normalized for its type; null when it is empty or not valid there. */
export function normalizeChip(raw: string, type: PropertyType | undefined): string | null {
  if (type === 'tags') return normalizeTagInput(raw);
  const value = raw.trim();
  return value ? value : null;
}

/** The chips after adding what was typed (it may hold several, separated by commas): duplicates and invalid entries are dropped. */
export function addChips(current: string[], raw: string, type: PropertyType | undefined): string[] {
  const separator = type === 'tags' ? /[\s,]+/ : /,/;
  const next = [...current];
  for (const piece of raw.split(separator)) {
    const chip = normalizeChip(piece, type);
    if (chip && !next.includes(chip)) next.push(chip);
  }
  return next;
}

/** The value a freshly added property starts with, by type. */
export function emptyValueFor(type: PropertyType): unknown {
  switch (type) {
    case 'list':
    case 'tags':
    case 'aliases':
      return [];
    case 'checkbox':
      return false;
    case 'number':
    case 'date':
    case 'datetime':
      return null;
    default:
      return '';
  }
}

/** A number input's text as the number to store; null for an empty or non-numeric field. */
export function parseNumberInput(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** `YYYY-MM-DD` out of a stored date (it may come back as a full ISO timestamp); '' when it is not a date. */
export function dateInputValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  const match = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(value.trim());
  return match ? match[1] : '';
}

/** `YYYY-MM-DDTHH:mm` for a datetime-local input; '' when the stored text is not a datetime. */
export function datetimeInputValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(value.trim());
  return match ? `${match[1]}T${match[2]}` : '';
}

/** Structural equality for the JSON-ish values front matter holds. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameValue(a[key], b[key]));
  }
  return false;
}

/** How many properties the header counts: every key the user can see and edit, `id` and the like left out. */
export function countProperties(properties: Properties, readOnly: readonly string[]): number {
  return Object.keys(properties).filter((key) => !readOnly.includes(key)).length;
}

/**
 * The map the panel shows. Folio only ever WRITES `tags:`; a page that still has the
 * Obsidian synonym `labels:` and no `tags:` shows those labels as its `tags` row, so the
 * owner sees one tag list however the file spells it.
 */
export function toDisplayProperties(properties: Properties): Properties {
  if ('tags' in properties || !('labels' in properties)) return properties;
  const { labels, ...rest } = properties;
  return { ...rest, tags: labels };
}

/**
 * The map to PUT for a display map: the inverse of {@link toDisplayProperties}. An
 * untouched `tags` row built from `labels:` goes back as `labels:` (no migration nobody
 * asked for); once the user edits it the list goes as `tags` alone, which the server
 * writes in place under `labels:` (server/properties.ts: an existing `labels:` is never
 * removed or migrated).
 */
export function toWireProperties(display: Properties, original: Properties): Properties {
  if ('tags' in original || !('labels' in original) || !('tags' in display)) return display;
  if (!sameValue(display.tags, original.labels)) return display;
  const { tags: _tags, ...rest } = display;
  return { ...rest, labels: original.labels };
}

/** The map the PUT carries: everything the editor may touch, the read-only keys (`id`) left out. */
export function editableProperties(wire: Properties, readOnly: readonly string[]): Properties {
  return Object.fromEntries(Object.entries(wire).filter(([key]) => !readOnly.includes(key)));
}

/** The type a key shows with: the server's effective type, or the shape of the value when it has none. */
export function effectiveType(key: string, value: unknown, types: PagePropertiesResponse['types']): PropertyType {
  const known = types[key];
  if (known) return known;
  if (Array.isArray(value)) return key === 'tags' ? 'tags' : 'list';
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  return 'text';
}

/** A property key someone typed: trimmed, 1–100 characters, no newline. */
export function normalizeKeyInput(raw: string): string | null {
  const key = raw.trim();
  if (!key || key.length > 100 || /[\r\n]/.test(key)) return null;
  return key;
}
