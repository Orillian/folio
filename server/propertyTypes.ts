/**
 * Property types of a space (Obsidian brief, wave 3; owner's decision 2):
 * the TYPES of front matter keys live in the repository.
 *
 *   `.folio/properties.json`   Folio's own file: `{ "v": 1, "types": { "due": "date", … } }`
 *                              (shared/contracts.ts propertyTypesFileSchema); other top-level
 *                              keys are kept by a save.
 *   `.obsidian/types.json`     read as the default when Folio's file is absent — Obsidian's
 *                              format `{ "types": { "key": "text|number|checkbox|date|datetime|
 *                              multitext|tags|aliases" } }`, `multitext` read as `list`. Never written.
 *
 * One source at a time (`source` in the response): Folio's file when it exists
 * and is a JSON object, else Obsidian's, else none. A value that is not a
 * known type is dropped, never an error: a hand-edited file must not take the
 * properties panel down. Nothing here follows a symlink.
 *
 * `known` is what the space's front matter actually holds — every key of
 * `pages_index.frontmatter` on the pages the caller may read — documents, and
 * since 15.10.2026 the own properties of tables, forms, boards and files too
 * (accessSql.ts, `_templates/` excluded; a document's `id` left out: Folio's,
 * never typed), with the type
 * inferred from the values (the most common one; a tie goes to the more
 * specific type, text last) and the number of pages; an empty value votes for nothing.
 * Inference: `tags`/`labels` -> tags, `aliases` -> aliases, a number -> number,
 * a boolean -> checkbox, a list -> list, an ISO date -> date, an ISO date with
 * a time -> datetime, anything else -> text.
 *
 * GET /api/spaces/:space/property-types (viewer+) and PUT (space admin, cookie
 * session, not the shared demo login) are registered in propertiesRoutes.ts;
 * the PUT writes `.folio/properties.json` through spaceAppearance.ts's settings
 * file helper (space lock, atomic write, ONE commit
 * `settings: update .folio/properties.json`).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { propertyTypeSchema, type PropertyType, type SpacePropertyTypesResponse } from '../shared/contracts.js';
import { sqlParam, visiblePagesSql, type PageViewer } from './accessSql.js';
import { query } from './db/pool.js';
import type { GitIdentity } from './git.js';
import { readFolioSettingsFile, writeFolioSettingsFile } from './spaceAppearance.js';
import * as storage from './storage.js';

export const PROPERTY_TYPES_FILE = 'properties.json';
const OBSIDIAN_TYPES_FILE = path.join('.obsidian', 'types.json');
/** A types file larger than this is not read (it would be a mistake, not a schema). */
const TYPES_FILE_MAX_BYTES = 512 * 1024;

export type PropertyTypesSource = SpacePropertyTypesResponse['source'];

/** A type name from either file -> Folio's type (`multitext` is Obsidian's list), or null. */
export function normalizePropertyType(raw: unknown): PropertyType | null {
  if (raw === 'multitext') return 'list';
  const parsed = propertyTypeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** `{ types: {...} }` of either file -> the valid entries, sorted by key. Null when the text is not a JSON object. */
export function parseTypesFile(content: string): { types: Record<string, PropertyType>; rest: Record<string, unknown> } | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { types: rawTypes, v: _v, ...rest } = value as Record<string, unknown>;
  const types: Record<string, PropertyType> = {};
  if (rawTypes && typeof rawTypes === 'object' && !Array.isArray(rawTypes)) {
    for (const key of Object.keys(rawTypes as Record<string, unknown>).sort()) {
      if (key.length < 1 || key.length > 100) continue;
      const type = normalizePropertyType((rawTypes as Record<string, unknown>)[key]);
      if (type) types[key] = type;
    }
  }
  return { types, rest };
}

/** `.obsidian/types.json` at the content root, as text — null when absent, too big, or reached through a symlink. */
async function readObsidianTypes(space: string): Promise<string | null> {
  const root = storage.getSpaceDir(space);
  try {
    const dir = await fs.lstat(path.join(root, '.obsidian'));
    if (!dir.isDirectory() || dir.isSymbolicLink()) return null;
    const abs = path.join(root, OBSIDIAN_TYPES_FILE);
    const st = await fs.lstat(abs);
    if (!st.isFile() || st.size > TYPES_FILE_MAX_BYTES) return null;
    return await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

/** The declared types of a space and where they came from (no inference). */
export async function readDeclaredTypes(space: string): Promise<{ types: Record<string, PropertyType>; source: PropertyTypesSource }> {
  const own = await readFolioSettingsFile(space, PROPERTY_TYPES_FILE);
  if (own) {
    const parsed = parseTypesFile(own.content);
    if (parsed) return { types: parsed.types, source: 'folio' };
    // eslint-disable-next-line no-console
    console.warn(`[properties] ${space}: .folio/${PROPERTY_TYPES_FILE} is not a JSON object; ignoring it`);
  }
  const obsidian = await readObsidianTypes(space);
  if (obsidian !== null) {
    const parsed = parseTypesFile(obsidian);
    if (parsed) return { types: parsed.types, source: 'obsidian' };
  }
  return { types: {}, source: 'none' };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** The type a value suggests (the properties panel, for a key no file types). */
export function inferPropertyType(key: string, value: unknown): PropertyType {
  if (key === 'tags' || key === 'labels') return 'tags';
  if (key === 'aliases') return 'aliases';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'checkbox';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Date) return value.getUTCHours() === 0 && value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0 ? 'date' : 'datetime';
  if (typeof value === 'string') {
    if (DATE_RE.test(value)) return 'date';
    if (DATETIME_RE.test(value)) return 'datetime';
  }
  return 'text';
}

/** Tie-break of `known`'s inference: the more specific type first. */
const TIE_ORDER: readonly PropertyType[] = ['tags', 'aliases', 'date', 'datetime', 'number', 'checkbox', 'list', 'text'];

/** Keys of the space's front matter, inferred type and page count — over the documents `viewer` may read. */
export async function listKnownProperties(space: string, viewer: PageViewer): Promise<SpacePropertyTypesResponse['known']> {
  const params: unknown[] = [space];
  const visible = visiblePagesSql('p', viewer, params, { excludeTemplates: true });
  // A YAML date reaches the jsonb as an ISO string at midnight UTC (gray-matter parses it to a Date).
  const rows = await query<{ key: string; inferred: PropertyType | null; pages: number }>(
    `SELECT e.key,
            CASE
              WHEN e.key IN ('tags', 'labels') THEN 'tags'
              WHEN e.key = 'aliases' THEN 'aliases'
              WHEN jsonb_typeof(e.value) = 'null' THEN NULL
              WHEN jsonb_typeof(e.value) = 'number' THEN 'number'
              WHEN jsonb_typeof(e.value) = 'boolean' THEN 'checkbox'
              WHEN jsonb_typeof(e.value) = 'array' THEN 'list'
              WHEN jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') ~ '^\\d{4}-\\d{2}-\\d{2}(T00:00:00(\\.0+)?Z)?$' THEN 'date'
              WHEN jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') ~ '^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}' THEN 'datetime'
              ELSE 'text'
            END AS inferred,
            COUNT(DISTINCT p.id)::int AS pages
       FROM pages_index p
       CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(p.frontmatter) = 'object' THEN p.frontmatter ELSE '{}'::jsonb END) AS e
      WHERE p.space_slug = $1 AND p.kind <> 'folder' AND (p.kind <> 'doc' OR e.key <> 'id') AND ${visible}
      GROUP BY 1, 2`,
    params,
  );
  const byKey = new Map<string, { pages: number; votes: Map<PropertyType, number> }>();
  for (const row of rows) {
    const entry = byKey.get(row.key) ?? { pages: 0, votes: new Map<PropertyType, number>() };
    entry.pages += row.pages; // one value per key and page: the groups of a key never share a page
    if (row.inferred) entry.votes.set(row.inferred, (entry.votes.get(row.inferred) ?? 0) + row.pages);
    byKey.set(row.key, entry);
  }
  const known: SpacePropertyTypesResponse['known'] = [];
  for (const [key, entry] of byKey) {
    // The most pages win; a tie goes to the more specific type (text last).
    const ranked = [...entry.votes].sort((a, b) => b[1] - a[1] || TIE_ORDER.indexOf(a[0]) - TIE_ORDER.indexOf(b[0]));
    known.push({ key, inferred: ranked[0]?.[0] ?? 'text', pages: entry.pages });
  }
  return known.sort((a, b) => b.pages - a.pages || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Sample values per key: a value longer than this (as JSON) is cut. */
const SAMPLE_MAX_CHARS = 80;

/** A value for a sample list: short enough to read in a table of keys; a long text is cut, a big list or map becomes its (cut) JSON text. */
function sampleOf(value: unknown): unknown {
  if (typeof value === 'string') return value.length > SAMPLE_MAX_CHARS ? `${value.slice(0, SAMPLE_MAX_CHARS)}…` : value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  const text = JSON.stringify(value);
  return text.length > SAMPLE_MAX_CHARS ? `${text.slice(0, SAMPLE_MAX_CHARS)}…` : value;
}

/**
 * Up to `perKey` of the most common non-empty values of each key, over the pages `viewer` may read — the same pages
 * as `listKnownProperties` (a value that sits only on a page the viewer cannot open is never returned).
 */
export async function listPropertySamples(space: string, viewer: PageViewer, perKey = 3): Promise<Map<string, unknown[]>> {
  const params: unknown[] = [space];
  const visible = visiblePagesSql('p', viewer, params, { excludeTemplates: true });
  const limit = sqlParam(params, Math.max(1, Math.floor(perKey)));
  const rows = await query<{ key: string; value: unknown }>(
    `SELECT key, value FROM (
       SELECT e.key, e.value, ROW_NUMBER() OVER (PARTITION BY e.key ORDER BY COUNT(DISTINCT p.id) DESC, e.value::text) AS rn
         FROM pages_index p
         CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(p.frontmatter) = 'object' THEN p.frontmatter ELSE '{}'::jsonb END) AS e
        WHERE p.space_slug = $1 AND p.kind <> 'folder' AND (p.kind <> 'doc' OR e.key <> 'id') AND ${visible}
          AND jsonb_typeof(e.value) <> 'null' AND e.value <> '""'::jsonb AND e.value <> '[]'::jsonb
        GROUP BY e.key, e.value
     ) ranked
     WHERE rn <= ${limit}
     ORDER BY key, rn`,
    params,
  );
  const out = new Map<string, unknown[]>();
  for (const row of rows) {
    const list = out.get(row.key) ?? [];
    list.push(sampleOf(row.value));
    out.set(row.key, list);
  }
  return out;
}

/** GET /api/spaces/:space/property-types. `types` are the DECLARED types only (what a PUT writes back); inference is in `known`. */
export async function readSpacePropertyTypes(space: string, viewer: PageViewer): Promise<SpacePropertyTypesResponse> {
  const declared = await readDeclaredTypes(space);
  return { types: declared.types, source: declared.source, known: await listKnownProperties(space, viewer) };
}

/** The `.folio/properties.json` text for `types`, keeping the other top-level keys of the current file. */
export function renderTypesFile(types: Record<string, PropertyType>, current: string | null): string {
  const rest = current === null ? {} : (parseTypesFile(current)?.rest ?? {});
  const sorted: Record<string, PropertyType> = {};
  for (const key of Object.keys(types).sort()) sorted[key] = types[key];
  return `${JSON.stringify({ v: 1, types: sorted, ...rest }, null, 2)}\n`;
}

/** PUT /api/spaces/:space/property-types: writes Folio's file (one commit; nothing when it already says this). */
export async function writeSpacePropertyTypes(space: string, actor: GitIdentity, types: Record<string, PropertyType>): Promise<boolean> {
  return writeFolioSettingsFile(space, actor, PROPERTY_TYPES_FILE, (current) => renderTypesFile(types, current?.content ?? null));
}
