/**
 * Round FORMS — the submit path: `POST /api/forms/:id/submit` (server/
 * forms/routes.ts) is a thin wrapper around this module, same "thin route +
 * directly-testable module function" split server/tables/routes.ts documents
 * for its own zone.
 *
 * The one invariant this module exists to enforce: a submission is ALWAYS
 * appended through server/tables/service.ts#insertRows — never a second,
 * parallel writer of the paired table's file. insertRows itself already
 * goes through the live-document path when a collab room is open
 * (collab.editTableDoc) and falls back to a direct file write otherwise
 * (server/tables/service.ts's own module doc comment) — this module doesn't
 * need to know which; that's exactly the point of reusing it.
 */
import { createHash } from 'node:crypto';
import { badRequest, HttpError, notFound } from '../errors.js';
import * as storage from '../storage.js';
import type { PageIndexEntry } from '../storage.js';
import * as tables from '../tables/service.js';
import * as collab from '../collab.js';
import { SUBMITTED_AT_COLUMN_ID, SUBMITTER_COLUMN_ID, buildFormChoices as buildChoicesFor, deriveFieldsFromColumns, formatSubmittedAt, systemColumns, validateSubmission } from '../../shared/forms/index.js';
import type { FormDoc, FormField, SubmissionError } from '../../shared/forms/index.js';
import type { FormFieldChoices, PageMeta, TableColumn } from '../../shared/contracts.js';
import { listMentionableUsers } from '../auth/store.js';
import { checkColumnCount, checkOptionCount, withNewColumnDefaults } from '../../shared/tables/index.js';

export class FormValidationError extends Error {
  constructor(public readonly errors: SubmissionError['errors']) {
    super('form submission failed validation');
  }
}

/**
 * Resolves the paired table's page id from a form's `table`
 * (space-root-relative) frontmatter field — self-healing when that stored
 * path has gone stale (a move or slug rename touching either side of the
 * pair, or an ancestor directory of either, none of which ever rewrite
 * `table:`; see storage.resolvePairedTableEntry's own doc comment for the
 * full mechanics and why the pair's TREE position is what the fallback
 * trusts instead). Only throws 404 when the table is genuinely gone —
 * neither at the stored path nor findable by tree position — which really
 * is a dangling reference, not a "try again" case.
 */
export async function resolvePairedTableId(formEntry: PageIndexEntry, tableRelPath: string): Promise<string> {
  const tableEntry = await storage.resolvePairedTableEntry(formEntry, tableRelPath);
  if (!tableEntry) throw notFound(`the table paired with this form was not found (looked for "${tableRelPath}")`);
  if (tableEntry.relPath !== tableRelPath) {
    // Found by tree position, not by the stored path: heal it so the next
    // resolution is the cheap exact-path lookup again. Best-effort — see
    // healFormTablePath's own doc comment for why a failure here must never
    // surface to the caller, who already has the id it asked for.
    await storage.healFormTablePath(formEntry.id, tableEntry.relPath).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[forms] could not update the stale table: path in form ${formEntry.id}:`, err);
    });
  }
  return tableEntry.id;
}

/**
 * Owner ask (22.09.2026, sidebar screenshot): renaming a FORM should carry
 * its default-titled paired table's TITLE along — a table nested under a
 * freshly-renamed form was still showing "New form", the name it got at
 * creation. Called from both places a form rename lands — the REST rename
 * route's form branch (server/routes.ts) and pageChanges.ts's undo path's
 * form branch — right after `storage.renameFormDirect` itself. It lives HERE
 * rather than next to renameFormDirect in server/storage.ts because it needs
 * `collab.applyH1Rename`, and storage.ts cannot import collab.ts without a
 * cycle (collab.ts already imports storage.ts); this module already imports
 * both with no cycle (collab.ts imports neither forms/service.ts nor
 * pageChanges.ts).
 *
 * Same collab-room-first ordering server/routes.ts's own table-rename branch
 * uses: `applyH1Rename` wins when the table is LIVE (its Y.Doc is the
 * authoritative copy — writing the H1 straight to the file there would get
 * clobbered by the room's next debounced flush, silently reverting the
 * rename); `renameTableFile` (a plain file write) is only the fallback for
 * when no room is open.
 *
 * ONE direction only — form -> table, never the reverse: a table can be the
 * target of several forms, so "which form's title wins" is ambiguous;
 * renaming a table must never touch any form.
 *
 * Best-effort: a missing/foreign/non-table paired entry, or any other
 * failure, is logged and swallowed — the paired table's title is cosmetic
 * next to the form rename the user actually asked for, never a reason to
 * fail it. No retro-fix for form/table pairs already sitting in spaces;
 * this only runs on the next rename.
 *
 * Owner report (22.09.2026, second round: "I renamed it and nothing happened"): this
 * used to look the table up with `getEntryIdByExactPath` — the STORED path
 * only — so for a pair whose `form.table` had gone stale it found nothing
 * and, being best-effort, returned silently. That is the same staleness
 * resolvePairedTableEntry exists to absorb (see its doc comment), and the
 * very pair the owner hit was already known to be stale — it is what broke
 * «Edit form» saving. Going through the shared resolver instead means a
 * rename can no longer be defeated by a move or slug rename, and it heals
 * the stored path on the way through.
 */
export async function renamePairedTableBestEffort(formEntry: PageIndexEntry, tableRelPath: string, title: string): Promise<void> {
  try {
    const tableEntry = await storage.resolvePairedTableEntry(formEntry, tableRelPath);
    if (!tableEntry || tableEntry.kind !== 'table') return;
    if (tableEntry.relPath !== tableRelPath) {
      await storage.healFormTablePath(formEntry.id, tableEntry.relPath).catch(() => {
        // Healing is an optimisation for the NEXT lookup; the rename below
        // already has the entry it needs — see healFormTablePath's own note.
      });
    }
    if (!(await collab.applyH1Rename(tableEntry.id, title))) {
      await storage.renameTableFile(tableEntry.id, title);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[forms] could not rename the paired table (space=${formEntry.space}, table=${tableRelPath}):`, error);
  }
}

/** Adds `submitted_at`/`submitter` to the table if either is missing. Idempotent — cheap to call on every submit rather than tracked separately. */
async function ensureSystemColumns(tableId: string): Promise<void> {
  const snapshot = await tables.getTableSnapshot(tableId);
  const existingIds = new Set(snapshot.columns.map((c) => c.id));
  for (const column of systemColumns()) {
    if (!existingIds.has(column.id)) {
      // eslint-disable-next-line no-await-in-loop -- two columns, order matters for a readable diff, not worth Promise.all's parallel-write race here
      await tables.addColumn(tableId, column);
    }
  }
}

export interface SubmitFormResult {
  rowId: string;
}

export interface SubmitFormOptions {
  /**
   * The respondent is not a signed-in member (a share-link guest). Their form
   * has no `user` fields (they are never shown the member list), so any
   * answer to one is ignored. Defaults to true: the safe side.
   */
  anonymous?: boolean;
}

/**
 * What the respondent's form needs to render each field as the right control
 * (`PageDoc.formChoices`): the bound column's options / `multiple`, and for a
 * `user` field the members — only for a signed-in member (`viewerIsMember`),
 * never for a share guest or the public site, who get `hidden` instead.
 * Read live from the paired table, so the choices follow the table. A form
 * whose table cannot be found gets `{}` (every field renders as a plain input,
 * the way it did before choices existed) rather than failing the page.
 */
export async function buildFormChoices(formEntry: PageIndexEntry, viewerIsMember: boolean): Promise<Record<string, FormFieldChoices>> {
  try {
    const form = await storage.readFreshFormDoc(formEntry.id);
    if (!form.fields.some((f) => f.kind === 'select' || f.kind === 'status' || f.kind === 'user')) return {};
    const tableId = await resolvePairedTableId(formEntry, form.table);
    const { columns } = await tables.getTableSnapshot(tableId);
    const needsUsers = viewerIsMember && form.fields.some((f) => f.kind === 'user');
    const users = viewerIsMember ? (needsUsers ? await listMentionableUsers(formEntry.space) : []) : null;
    return buildChoicesFor(form.fields, columns, users);
  } catch {
    return {};
  }
}

/**
 * Validates `rawValues` against the form's OWN fields (never the table's
 * live columns directly — a field's `kind` is a snapshot, see FormField's
 * doc comment in shared/contracts.ts) and appends one row. The table's
 * columns only decide what a select/status/user answer may be: a value that
 * is not among the column's options (or not a member, or a malformed link)
 * is rejected as `invalid`, and a list is accepted only for a `multiple`
 * column.
 * `submitterLabel` is the caller's job to resolve (a signed-in user's name,
 * or the literal 'anonymous') — this module is agnostic to auth.
 */
export async function submitForm(
  formEntry: PageIndexEntry,
  submitterLabel: string,
  rawValues: Record<string, unknown>,
  options: SubmitFormOptions = {},
): Promise<SubmitFormResult> {
  if (formEntry.kind !== 'form') throw badRequest('page is not a form');
  const form: FormDoc = await storage.readFreshFormDoc(formEntry.id);
  const tableId = await resolvePairedTableId(formEntry, form.table);

  const { columns } = await tables.getTableSnapshot(tableId);
  let users: Set<string> | null = null;
  if (options.anonymous === false) {
    users = new Set<string>();
    if (form.fields.some((f) => f.kind === 'user')) for (const u of await listMentionableUsers(formEntry.space)) users.add(u.username.toLowerCase());
  }
  const result = validateSubmission(form.fields, rawValues, { columns, users });
  if (!result.ok) throw new FormValidationError(result.errors);

  await ensureSystemColumns(tableId);
  const values = {
    ...result.values,
    // formatSubmittedAt, not toISOString() — see its own doc comment
    // (shared/forms/fields.ts) for the bug a bare ISO-with-`Z` string caused.
    [SUBMITTED_AT_COLUMN_ID]: formatSubmittedAt(new Date()),
    [SUBMITTER_COLUMN_ID]: submitterLabel,
  };
  const { rows } = await tables.insertRows(tableId, [values]);
  return { rowId: rows[0].id };
}

// ---------------------------------------------------------------------------
// Building a form from a definition (16.10.2026: the AI assistant and the MCP
// create_form / update_form tools). The same steps the web app takes, through
// the same writers: "+ -> Form" is storage.createPage(kind 'form'), "Create a
// form" on a table is storage.createFormFromTable, and the form editor's Save
// adds a column to the paired table for every new field (tables.addColumn,
// seeded like a column added in the UI) and then writes the whole definition
// with storage.writeFormDoc. A field removed from the form leaves its column
// and the answers in it alone, as in the editor.
// ---------------------------------------------------------------------------

/** Etag of a form: the sha1 of its whole file, the way a base's etag is its file's (bases/service.ts). */
export function formEtag(raw: string): string {
  return createHash('sha1').update(raw, 'utf8').digest('hex');
}

/** 409 of a form write whose etag no longer matches the file; carries the current etag. */
export class FormConflictError extends HttpError {
  constructor(public readonly currentEtag: string) {
    super(409, 'the form changed since it was read');
  }
}

/** One field as an agent describes it: an existing column of the paired table (`columnId`), or a new column (no `columnId`). */
export interface FormFieldInput {
  /** A column of the paired table this field fills; omit to add a new column for it. */
  columnId?: string;
  /** Required for a new field. For an existing column it may be left out: the form's current label for it, else the column's name. */
  label?: string;
  /** Column type of a NEW field (default text). For an existing column it may be left out; if given it must be the column's type. */
  type?: TableColumn['type'];
  /** Left out: the form's current value for this column (false for a new field). */
  required?: boolean;
  /** Left out: the form's current hint for this column; "" removes it. */
  help?: string;
  /** New select/status field only: the allowed values. A status field without them gets the status preset, as in the web app. */
  options?: TableColumn['options'];
  /** New select/user field only: several values per answer. */
  multiple?: boolean;
}

/** The form's own settings; `null` clears an optional one. */
export interface FormSettingsInput {
  title?: string;
  description?: string | null;
  submitButton?: string | null;
  public?: boolean;
}

type PlannedField = { input: FormFieldInput; existing?: TableColumn; current?: FormField; newColumn?: Omit<TableColumn, 'id'> };

const SYSTEM_IDS: ReadonlySet<string> = new Set([SUBMITTED_AT_COLUMN_ID, SUBMITTER_COLUMN_ID]);

/**
 * Checks every field against the paired table's columns (`null`: the table does not exist yet) BEFORE anything is
 * written, so a bad field never leaves a half-added set of columns behind. Throws 400 with the field's position.
 */
function planFields(inputs: readonly FormFieldInput[], columns: readonly TableColumn[] | null, currentFields: readonly FormField[] = []): PlannedField[] {
  const byId = new Map((columns ?? []).map((c) => [c.id, c]));
  const currentById = new Map(currentFields.map((f) => [f.columnId, f]));
  const used = new Set<string>();
  const planned: PlannedField[] = [];
  inputs.forEach((input, index) => {
    const where = `field ${index + 1}${input.label ? ` ("${input.label}")` : input.columnId ? ` (${input.columnId})` : ''}`;
    if (input.label !== undefined && !input.label.trim()) throw badRequest(`${where}: label is empty`);
    if (input.columnId !== undefined) {
      if (columns === null) throw badRequest(`${where}: a new form has no table yet — leave columnId out to add a column for the field`);
      if (SYSTEM_IDS.has(input.columnId)) throw badRequest(`${where}: ${input.columnId} is filled in by Folio on every submission and cannot be a field`);
      const column = byId.get(input.columnId);
      if (!column) throw badRequest(`${where}: the paired table has no column "${input.columnId}" (its columns: ${[...byId.keys()].filter((id) => !SYSTEM_IDS.has(id)).join(', ') || 'none'})`);
      if (used.has(column.id)) throw badRequest(`${where}: column "${column.id}" is already used by another field`);
      if (input.type !== undefined && input.type !== column.type) throw badRequest(`${where}: column "${column.id}" is of type ${column.type}, not ${input.type}; leave type out for an existing column, or change the column with folio_table_update_column`);
      if (input.options !== undefined || input.multiple !== undefined) throw badRequest(`${where}: options and multiple belong to the column; change them with folio_table_update_column`);
      used.add(column.id);
      planned.push({ input, existing: column, current: currentById.get(column.id) });
      return;
    }
    if (!input.label?.trim()) throw badRequest(`${where}: a new field needs a label`);
    const type = input.type ?? 'text';
    if (input.options !== undefined && type !== 'select' && type !== 'status') throw badRequest(`${where}: options apply to select and status fields only`);
    if (input.multiple !== undefined && type !== 'select' && type !== 'user') throw badRequest(`${where}: multiple applies to select and user fields only`);
    const newColumn = withNewColumnDefaults({
      name: input.label.trim(),
      type,
      ...(input.options !== undefined ? { options: input.options } : {}),
      ...(input.multiple !== undefined ? { multiple: input.multiple } : {}),
    });
    if (newColumn.options) {
      const check = checkOptionCount(newColumn.options.length);
      if (check.level === 'error') throw badRequest(`${where}: ${check.message ?? 'too many options'}`);
    }
    planned.push({ input, newColumn });
  });
  const added = planned.filter((p) => p.newColumn).length;
  if (added > 0) {
    const check = checkColumnCount((columns?.length ?? 0) + added + (columns === null ? SYSTEM_IDS.size : 0));
    if (check.level === 'error') throw badRequest(check.message ?? 'too many columns');
  }
  return planned;
}

/** The field as written: what the input gives, else what the form had for this column (`current`), else the defaults. */
function fieldOf(input: FormFieldInput, column: Pick<TableColumn, 'id' | 'name' | 'type'>, current?: FormField): FormField {
  const label = input.label?.trim() || current?.label || column.name;
  const help = input.help === undefined ? current?.help : input.help.trim() || undefined;
  return { columnId: column.id, label, ...(help ? { help } : {}), required: input.required ?? current?.required ?? false, kind: column.type };
}

/** Adds a column to the paired table for every new field, in order (sequential, like the editor's Save), and returns the form's fields. */
async function materializeFields(tableId: string, planned: PlannedField[]): Promise<FormField[]> {
  const fields: FormField[] = [];
  for (const p of planned) {
    if (p.existing) {
      fields.push(fieldOf(p.input, p.existing, p.current));
    } else {
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose: column ids are derived from the columns already there
      const column = await tables.addColumn(tableId, p.newColumn!);
      fields.push(fieldOf(p.input, column));
    }
  }
  return fields;
}

function applySettings(doc: FormDoc, settings: FormSettingsInput): Omit<FormDoc, 'meta' | 'table'> {
  const optional = (value: string | null | undefined, current: string | undefined): string | undefined =>
    value === undefined ? current : value === null ? undefined : value.trim() || undefined;
  return {
    title: settings.title?.trim() || doc.title,
    description: optional(settings.description, doc.description),
    public: settings.public ?? doc.public,
    submitButton: optional(settings.submitButton, doc.submitButton),
    fields: doc.fields,
    body: doc.body,
  };
}

export interface FormWriteResult {
  meta: PageMeta;
  etag: string;
  /** Columns this call added to the paired table. */
  columnsAdded: string[];
  tableId: string;
}

/**
 * Creates a form. Without `tableId`: the form and its paired table as one new pair, the way "+ -> Form" does
 * (storage.createPage kind 'form'), the table's columns made from the fields. With `tableId`: a form on that
 * existing table, the way "Create a form" on a table does (storage.createFormFromTable, which places the form under
 * the table and starts with one field per column); `fields`, when given, then replace that starting list (an
 * existing column by `columnId`, a new one without). The caller checks access (editor+ in the space, and on the
 * table) and records the Git author.
 */
export async function createFormFromDefinition(
  input: FormSettingsInput & { space: string; parentPath: string; title: string; tableId?: string; fields?: FormFieldInput[] },
  language?: string,
): Promise<FormWriteResult> {
  let meta: PageMeta;
  let tableId: string;
  let fields: FormField[] | undefined;
  const columnsAdded: string[] = [];
  if (input.tableId !== undefined) {
    const tableEntry = await storage.requireEntry(input.tableId);
    if (tableEntry.kind !== 'table') throw badRequest('page is not a data table');
    if (tableEntry.space !== input.space) throw badRequest('the table is in another space');
    const before = (await tables.getTableSnapshot(input.tableId)).columns;
    // The starting fields "Create a form" gives (one per column) are what a field without label/help falls back to.
    const planned = input.fields ? planFields(input.fields, before, deriveFieldsFromColumns(before)) : undefined;
    meta = await storage.createFormFromTable(input.tableId);
    tableId = input.tableId;
    if (planned) {
      fields = await materializeFields(tableId, planned);
      const had = new Set(before.map((c) => c.id));
      columnsAdded.push(...fields.map((f) => f.columnId).filter((id) => !had.has(id)));
    }
  } else {
    const planned = planFields(input.fields ?? [], null);
    // Ids derived here exactly as tables.addColumn would derive them; the system columns' ids are kept free.
    const taken = new Set<string>(SYSTEM_IDS);
    const columns: TableColumn[] | undefined = planned.length
      ? planned.map((p) => {
          const id = tables.columnIdFromName(p.newColumn!.name, taken);
          taken.add(id);
          return { ...p.newColumn!, id };
        })
      : undefined;
    meta = await storage.createPage({ space: input.space, parentPath: input.parentPath, title: input.title, kind: 'form', columns }, undefined, language);
    const created = await storage.readFreshFormDoc(meta.id);
    const formEntry = await storage.requireEntry(meta.id);
    tableId = await resolvePairedTableId(formEntry, created.table);
    if (columns) {
      fields = planned.map((p, i) => fieldOf(p.input, columns[i]));
      columnsAdded.push(...columns.map((c) => c.id));
    }
  }
  const doc = await storage.readFreshFormDoc(meta.id);
  const next = applySettings({ ...doc, ...(fields ? { fields } : {}) }, { ...input, title: input.title });
  meta = await storage.writeFormDoc(meta.id, next);
  return { meta, etag: formEtag(await storage.readFreshFormRaw(meta.id)), columnsAdded, tableId };
}

/**
 * Changes a form's settings and/or its whole list of fields, the way the form editor's Save does. `fields`, when
 * given, is the new list in order: a field with `columnId` keeps filling that column (label, help, required change
 * only when given), one without adds a column to the paired table, and a field left out is removed from the form
 * only (its column and the answers stay). `etag` (from read_page or a previous write) refuses the write with a
 * FormConflictError when the form changed meanwhile; without it the write is guarded by the etag read here.
 */
export async function updateFormDefinition(
  formEntry: PageIndexEntry,
  input: FormSettingsInput & { fields?: FormFieldInput[] },
  etag?: string,
): Promise<FormWriteResult> {
  if (formEntry.kind !== 'form') throw badRequest('page is not a form');
  const raw = await storage.readFreshFormRaw(formEntry.id);
  const expected = etag ?? formEtag(raw);
  if (formEtag(raw) !== expected) throw new FormConflictError(formEtag(raw));
  const doc = await storage.readFreshFormDoc(formEntry.id);
  const tableId = await resolvePairedTableId(formEntry, doc.table);
  let fields = doc.fields;
  const columnsAdded: string[] = [];
  if (input.fields) {
    const before = (await tables.getTableSnapshot(tableId)).columns;
    const planned = planFields(input.fields, before, doc.fields);
    fields = await materializeFields(tableId, planned);
    const had = new Set(before.map((c) => c.id));
    columnsAdded.push(...fields.map((f) => f.columnId).filter((id) => !had.has(id)));
  }
  const next = applySettings({ ...doc, fields }, input);
  const meta = await storage.writeFormDoc(formEntry.id, next, {
    beforeWrite: (current) => {
      if (formEtag(current) !== expected) throw new FormConflictError(formEtag(current));
    },
  });
  return { meta, etag: formEtag(await storage.readFreshFormRaw(formEntry.id)), columnsAdded, tableId };
}

/** A form's definition as the agent reads it (read_page): settings, fields, the paired table (id null when it cannot be found) and the etag. */
export async function readFormDefinition(formEntry: PageIndexEntry): Promise<{
  form: Omit<FormDoc, 'meta' | 'body' | 'table'> & { table: { id: string | null; path: string } };
  etag: string;
}> {
  const raw = await storage.readFreshFormRaw(formEntry.id);
  const doc = await storage.readFreshFormDoc(formEntry.id);
  let tableId: string | null = null;
  try {
    tableId = await resolvePairedTableId(formEntry, doc.table);
  } catch {
    tableId = null;
  }
  return {
    form: { title: doc.title, description: doc.description, public: doc.public, submitButton: doc.submitButton, fields: doc.fields, table: { id: tableId, path: doc.table } },
    etag: formEtag(raw),
  };
}
