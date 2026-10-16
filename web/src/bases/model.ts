/**
 * The base page's UI model: what a cell says, which editor a cell gets, the
 * value an edit writes, and the rows laid out with their group headers. Pure.
 */
import type { PropertyType } from '@shared/contracts';
import type { BaseCell, BaseColumn, BaseGroup, BaseQueryResponse, BaseRow } from '@shared/bases/types';

const pad = (n: number) => String(n).padStart(2, '0');

/** A UTC `YYYY-MM-DDTHH:MM:SS` from the server in the reader's time zone, `YYYY-MM-DD HH:MM`. */
export function localDateTime(utc: string): string {
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(utc) ? utc : `${utc}Z`);
  if (Number.isNaN(d.getTime())) return utc.replace('T', ' ');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Plain text of a cell (lists joined, links by their text). */
export function cellText(cell: BaseCell | undefined): string {
  if (cell === null || cell === undefined) return '';
  switch (cell.t) {
    case 'list':
      return cell.v.map(cellText).filter(Boolean).join(', ');
    case 'bool':
      return cell.v ? '✓' : '';
    case 'datetime':
      return localDateTime(cell.v);
    case 'number':
      return Number.isInteger(cell.v) ? String(cell.v) : String(Number(cell.v.toFixed(6)));
    default:
      return String(cell.v);
  }
}

/** File fields with a readable name when the base gives them none. */
export const FILE_FIELD_KEYS: Record<string, string> = {
  'file.name': 'fileName',
  'file.basename': 'fileName',
  'file.path': 'filePath',
  'file.folder': 'fileFolder',
  'file.ext': 'fileExt',
  'file.size': 'fileSize',
  'file.ctime': 'fileCtime',
  'file.mtime': 'fileMtime',
  'file.tags': 'fileTags',
  'file.links': 'fileLinks',
  'file.backlinks': 'fileBacklinks',
};

/** The header text: the base's display name, a translated name for a file field, else the property name. */
export function columnLabel(column: Pick<BaseColumn, 'id' | 'label'>, t: (key: string) => string): string {
  if (column.label !== column.id) return column.label;
  const key = FILE_FIELD_KEYS[column.id];
  if (key) return t(`fields.${key}`);
  if (column.id.startsWith('formula.')) return column.id.slice('formula.'.length);
  return column.label;
}

/**
 * What a property id is called in the editor's lists: the base's `properties.<id>.displayName` (also found
 * for `status` ↔ `note.status`), else the same name the table header shows (a translated file field, a
 * formula's name, a note property's key without `note.`).
 */
export function propertyLabel(id: string, properties: Record<string, { displayName?: unknown }> | undefined, t: (key: string) => string): string {
  const named = (key: string) => {
    const v = properties?.[key]?.displayName;
    return typeof v === 'string' && v ? v : undefined;
  };
  const alias = id.startsWith('note.') ? id.slice('note.'.length) : `note.${id}`;
  const custom = named(id) ?? (id.startsWith('file.') || id.startsWith('formula.') ? undefined : named(alias));
  if (custom) return custom;
  return columnLabel({ id, label: id.startsWith('note.') ? id.slice('note.'.length) : id }, t);
}

export type CellEditor = 'text' | 'number' | 'date' | 'datetime' | 'checkbox' | 'list';

/** The editor a cell gets: the space's type for the key when there is one, else what the value looks like. */
export function editorFor(cell: BaseCell | undefined, type: PropertyType | undefined): CellEditor {
  switch (type) {
    case 'number':
      return 'number';
    case 'checkbox':
      return 'checkbox';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'list':
    case 'tags':
    case 'aliases':
      return 'list';
    case 'text':
      return 'text';
  }
  if (!cell) return 'text';
  if (cell.t === 'number') return 'number';
  if (cell.t === 'bool') return 'checkbox';
  if (cell.t === 'date') return 'date';
  if (cell.t === 'datetime') return 'datetime';
  if (cell.t === 'list') return 'list';
  return 'text';
}

/** What the inline editor starts with. */
export function editText(cell: BaseCell | undefined, editor: CellEditor): string {
  if (!cell) return '';
  if (editor === 'datetime' && cell.t === 'datetime') return cell.v.slice(0, 16);
  if (editor === 'list' && cell.t === 'list') return cell.v.map(cellText).join(', ');
  if (cell.t === 'link' && !cell.url) return cell.path && /\.md$/i.test(cell.path) ? `[[${cell.v}]]` : cell.v;
  return cellText(cell);
}

/** The edited text → the property value to write (null = an empty property, as Obsidian writes it). */
export function parseEdit(text: string, editor: CellEditor): unknown {
  const v = text.trim();
  switch (editor) {
    case 'number': {
      if (v === '') return null;
      const n = Number(v.replace(',', '.'));
      return Number.isFinite(n) ? n : v;
    }
    case 'checkbox':
      return v === 'true';
    case 'list':
      return v === '' ? [] : v.split(',').map((x) => x.trim()).filter(Boolean);
    case 'date':
    case 'datetime':
      return v === '' ? null : v.replace(' ', 'T');
    default:
      return v === '' ? null : text;
  }
}

/** Does the page's current value still look like the cell the reader edited? (Someone else may have changed it since the base was loaded.) */
export function sameAsShown(current: unknown, cell: BaseCell | undefined): boolean {
  if (!cell || cell.t === 'error' || cell.t === 'unsupported' || cell.t === 'object') return true;
  if (current === undefined || current === null || current === '') return cell === null || cellText(cell) === '';
  if (cell.t === 'number') return Number(current) === cell.v;
  if (cell.t === 'bool') return current === cell.v;
  if (cell.t === 'date' || cell.t === 'datetime') return String(current).replace(' ', 'T').startsWith(cell.v.slice(0, 10));
  if (cell.t === 'list') return Array.isArray(current) ? current.length === cell.v.length : cell.v.length === 1;
  if (cell.t === 'link') return String(current).includes(cell.v) || String(current).includes(cell.path?.replace(/\.md$/i, '') ?? '\u0000');
  return String(current) === cellText(cell);
}

export type LaidOutItem = { kind: 'group'; index: number; group: BaseGroup } | { kind: 'row'; row: BaseRow };

/** The rows of the page with a header before each group's first row (groups in the answer's order). */
export function layOut(response: Pick<BaseQueryResponse, 'rows' | 'groups'>, collapsed: ReadonlySet<number> = new Set()): LaidOutItem[] {
  if (!response.groups) return response.rows.map((row) => ({ kind: 'row', row }));
  const out: LaidOutItem[] = [];
  let current = -1;
  for (const row of response.rows) {
    const g = row.group ?? -1;
    if (g !== current) {
      current = g;
      if (g >= 0 && response.groups[g]) out.push({ kind: 'group', index: g, group: response.groups[g] });
    }
    if (!collapsed.has(g)) out.push({ kind: 'row', row });
  }
  return out;
}

/** The property ids a picker offers: the base's columns, the space's keys, file fields, the base's formulas. */
export function propertyChoices(spaceKeys: string[], formulas: string[], extra: string[] = []): string[] {
  const out: string[] = [];
  const push = (id: string) => {
    if (id && !out.includes(id)) out.push(id);
  };
  extra.forEach(push);
  for (const k of [...spaceKeys].sort((a, b) => a.localeCompare(b))) push(k);
  for (const f of Object.keys(FILE_FIELD_KEYS)) if (f !== 'file.basename') push(f);
  for (const f of formulas) push(`formula.${f}`);
  return out;
}
