/**
 * What a NEW column gets when its author did not say: the web app seeds a
 * `status` column with the normative status preset (spec §3) and a `select`
 * column with an empty-but-present options list (TablePage.tsx's add column,
 * the column editor, the form editor's "+ Add field"). The MCP tools that add
 * columns (create_form, update_form, folio_table_create, folio_table_add_column)
 * apply the same defaults, so a column an agent adds is the column a person
 * would have got.
 */
import type { TableColumn } from '../contracts.js';

/** The normative status preset from spec §3, in its normative order. */
export const STATUS_PRESET_OPTIONS: NonNullable<TableColumn['options']> = [
  { value: 'PLANNING', color: 'purple', description: 'planned' },
  { value: 'WAITING', color: 'gray', description: 'waiting on others' },
  { value: 'QUESTIONS', color: 'orange', description: 'answers needed' },
  { value: 'IN PROG', color: 'blue', description: 'in progress' },
  { value: 'DONE', color: 'green', description: 'done' },
  { value: 'REPLAN', color: 'yellow', description: 'being moved' },
  { value: 'FAILED', color: 'red', description: 'failed' },
  { value: 'CANCELLED', color: 'gray', description: 'cancelled' },
];

/** `options` a new column of `type` starts with when none were given: the status preset, `[]` for select, nothing otherwise. */
export function defaultColumnOptions(type: TableColumn['type']): TableColumn['options'] {
  if (type === 'status') return STATUS_PRESET_OPTIONS.map((o) => ({ ...o }));
  if (type === 'select') return [];
  return undefined;
}

/** `column` with its options seeded the way the web app seeds a new column (only when it has none). */
export function withNewColumnDefaults<T extends Pick<TableColumn, 'type' | 'options'>>(column: T): T {
  if (column.options !== undefined) return column;
  const options = defaultColumnOptions(column.type);
  return options === undefined ? column : { ...column, options };
}
