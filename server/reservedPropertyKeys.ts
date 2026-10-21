/**
 * The front matter keys that ARE a data table or a form (15.10.2026): a
 * `.table.md` / `.form.md` block holds the page's own properties next to
 * them. The properties panel never shows, edits or removes these; the codecs
 * (shared/tables/codec.ts, shared/forms/codec.ts) rebuild only these, and
 * storage.ts carries every other key of the block across each rebuild.
 * `order` / `icon` are the page's place in the tree and its icon (written by
 * the tree and the icon picker, not by the panel).
 */
import { ARTIFACT_RESERVED_KEYS, type PageKind } from '../shared/contracts.js';

export const TABLE_RESERVED_KEYS: readonly string[] = ['folio', 'version', 'id', 'columns', 'views', 'options', 'order', 'icon'];
export const FORM_RESERVED_KEYS: readonly string[] = ['folio', 'version', 'id', 'table', 'title', 'description', 'public', 'submitButton', 'fields', 'order', 'icon'];
const TABLE_RESERVED: ReadonlySet<string> = new Set(TABLE_RESERVED_KEYS);
const FORM_RESERVED: ReadonlySet<string> = new Set(FORM_RESERVED_KEYS);
/** An artifact's artifact.yaml (21.10.2026): the keys that describe the bundle; every other top-level key is a property. */
const ARTIFACT_RESERVED: ReadonlySet<string> = new Set(ARTIFACT_RESERVED_KEYS);

/** The reserved keys of a table / form block; null for every other kind. */
export function reservedKeysOf(kind: PageKind): ReadonlySet<string> | null {
  return kind === 'table' ? TABLE_RESERVED : kind === 'form' ? FORM_RESERVED : kind === 'artifact' ? ARTIFACT_RESERVED : null;
}

/** The page's own properties out of its parsed block: a table's / form's without the reserved keys, anything else as it is. */
export function ownProperties(kind: PageKind, data: Record<string, unknown>): Record<string, unknown> {
  const reserved = reservedKeysOf(kind);
  if (!reserved) return data;
  return Object.fromEntries(Object.entries(data).filter(([key]) => !reserved.has(key)));
}
