/**
 * Round FORMS — pure field <-> column mapping and submission validation.
 * No IO, no server/collab knowledge: server/forms/service.ts calls these
 * before it ever touches storage/collab, and the web field editor uses
 * `deriveFieldsFromColumns` for its own "regenerate from table" action.
 */
import type { FormField, FormFieldChoices, MentionableUser, TableCellValue, TableColumn } from '../contracts.js';
import { formatLinkValue, parseLinkValue } from '../tables/values.js';

/**
 * Columns the server stamps onto every submission automatically (spec: "add
 * them to the table if missing") — never shown as fillable fields, and
 * `deriveFieldsFromColumns` skips them so re-deriving a form from its table
 * doesn't grow a "Submitted at" text box.
 */
export const SUBMITTED_AT_COLUMN_ID = 'submitted_at';
export const SUBMITTER_COLUMN_ID = 'submitter';
const SYSTEM_COLUMN_IDS: ReadonlySet<string> = new Set([SUBMITTED_AT_COLUMN_ID, SUBMITTER_COLUMN_ID]);

export function systemColumns(): TableColumn[] {
  return [
    { id: SUBMITTED_AT_COLUMN_ID, name: 'Submitted at', type: 'date', time: true },
    { id: SUBMITTER_COLUMN_ID, name: 'Submitter', type: 'text' },
  ];
}

/**
 * BUGFIX (owner repro: after a successful submit, the table row's "Submitted
 * at" cell rendered as an empty `dd.mm.yyyy, --:--` — the column WAS created
 * and the row WAS written, but the value never showed). Root cause:
 * server/forms/service.ts used to write `new Date().toISOString()`
 * (`"2026-09-21T12:34:56.789Z"` — milliseconds + a `Z` offset) straight into
 * this `date, time: true` column. `values.ts#encodeCell`/`decodeCell` do NO
 * parsing for the `date` type — a cell's stored value is whatever string was
 * put there, verbatim (see that module's own doc comment) — and the ONE
 * place a `date, time: true` value is ever consulted is
 * `web/src/tables/cells/CellComponents.tsx`'s `DateCell` (and
 * RowDetailPanel's twin), which hands it straight to an
 * `<input type="datetime-local">`. Per the HTML spec that input's `value`
 * must be a "local date and time string" — `YYYY-MM-DDTHH:mm[:ss]`, no
 * timezone designator — so a `Z`-suffixed ISO string is simply an INVALID
 * value for it: the browser silently ignores it and the input renders
 * empty, exactly the reported symptom (checked in the browser: setting an
 * `<input type="datetime-local">`'s `.value` to an ISO string with `Z`
 * leaves it blank; the same string without the `Z`/milliseconds renders
 * fine). This formats the submission time in that exact shape instead, off
 * the server's own local clock (there is no per-row timezone anywhere else
 * in the table model either — every `date`/`datetime-local` value in this
 * app is already a zone-less wall-clock string, filled in by whoever's
 * browser wrote it; this keeps a server-written one consistent with that).
 */
export function formatSubmittedAt(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** One field per non-system column, in column order — the starter mapping for "Create a form" on an existing table, and for a field-editor's "regenerate from table" action. */
export function deriveFieldsFromColumns(columns: TableColumn[]): FormField[] {
  return columns
    .filter((c) => !SYSTEM_COLUMN_IDS.has(c.id))
    .map((c) => ({ columnId: c.id, label: c.name, help: c.description, required: false, kind: c.type }));
}

/**
 * What each field of a form needs to render as the right control, by
 * columnId, read off the paired table's columns. Only the form's OWN fields
 * are described (a reader never learns about the table's other columns).
 *
 * `users`: the members a `user` field can pick, or `null` for a reader who
 * must not see the member list (a share-link guest, the public site) — such a
 * field is marked `hidden` and the form leaves it out; the submit side ignores
 * it for the same readers (see `validateSubmission`'s `ctx.users`).
 * A field whose column has gone from the table gets no entry: the form falls
 * back to a plain input for it, as before.
 */
export function buildFormChoices(
  fields: readonly FormField[],
  columns: readonly TableColumn[],
  users: readonly MentionableUser[] | null,
): Record<string, FormFieldChoices> {
  const byId = new Map(columns.map((c) => [c.id, c]));
  const out: Record<string, FormFieldChoices> = {};
  for (const field of fields) {
    const column = byId.get(field.columnId);
    if (!column || column.type !== field.kind) continue;
    if (field.kind === 'select' || field.kind === 'status') {
      out[field.columnId] = { options: (column.options ?? []).map((o) => ({ ...o })), ...(column.multiple ? { multiple: true } : {}) };
    } else if (field.kind === 'user') {
      out[field.columnId] = users === null ? { hidden: true } : { users: users.map((u) => ({ ...u })), ...(column.multiple ? { multiple: true } : {}) };
    }
  }
  return out;
}

export interface SubmissionOk {
  ok: true;
  values: Record<string, TableCellValue>;
}
export interface SubmissionError {
  ok: false;
  /** columnId -> human-ish reason, i18n'd by the caller (server returns the raw key, web maps it to text). */
  errors: Record<string, 'required' | 'invalid'>;
}

/**
 * What a submission is checked against beyond the form's own fields. Left out
 * (a unit test of the coercion alone) the select/user/link fields are only
 * coerced to strings, as before; the server always passes it.
 */
export interface SubmissionContext {
  /** The paired table's columns: select/status answers must be among the column's options, with the shape its `multiple` says. */
  columns: readonly TableColumn[];
  /**
   * Usernames (lower-case) a `user` field accepts — the respondent is a
   * signed-in member. `null`: the respondent is anonymous, `user` fields are
   * not part of the form for them (ignored, not required).
   */
  users: ReadonlySet<string> | null;
}

function isEmptyInput(raw: unknown): boolean {
  return raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0);
}

const LINK_URL_RE = /^(https?:\/\/|mailto:)\S+$/i;

/** A list answer as a list of distinct strings; `null` when it is not strings (an object, a bool …). */
function asStringList(raw: unknown): string[] | null {
  const items = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string' && typeof item !== 'number') return null;
    const text = String(item).trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/** One-or-many answer: `multiple` gives the list, otherwise the single value (a one-item list is accepted for a single field); `null` = does not fit. */
function shapeAnswer(list: string[], multiple: boolean): string | string[] | null {
  if (multiple) return list;
  return list.length === 1 ? list[0] : null;
}

/** `[caption](url)` or a bare URL -> the value a `link` cell stores; `null` when the URL is not http(s)/mailto. Brackets/newlines in the caption would break the cell, so they are dropped. */
function normalizeLink(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseLinkValue(raw);
  if (!parsed || !LINK_URL_RE.test(parsed.url)) return null;
  const caption = parsed.caption?.replace(/[[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  return formatLinkValue(parsed.url, caption || undefined);
}

/**
 * Required-field check + per-kind coercion of a raw (JSON-from-the-wire)
 * submission into typed `TableCellValue`s ready for
 * `server/tables/service.ts#insertRows`. Never throws — a bad submission is
 * data, not a bug, so every problem comes back as `errors` for the caller
 * (server: 400; web form: inline messages) to present.
 */
export function validateSubmission(fields: readonly FormField[], input: Record<string, unknown>, ctx?: SubmissionContext): SubmissionOk | SubmissionError {
  const errors: Record<string, 'required' | 'invalid'> = {};
  const values: Record<string, TableCellValue> = {};
  const columnById = new Map((ctx?.columns ?? []).map((c) => [c.id, c]));

  for (const field of fields) {
    // A `user` field of an anonymous respondent is not on their form at all.
    if (ctx && ctx.users === null && field.kind === 'user') {
      values[field.columnId] = null;
      continue;
    }
    const raw = input[field.columnId];
    if (isEmptyInput(raw)) {
      if (field.required) errors[field.columnId] = 'required';
      else values[field.columnId] = null;
      continue;
    }
    const column = columnById.get(field.columnId);
    const known = column && column.type === field.kind ? column : undefined;
    switch (field.kind) {
      case 'number': {
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(n)) {
          errors[field.columnId] = 'invalid';
          break;
        }
        values[field.columnId] = n;
        break;
      }
      case 'checkbox':
        values[field.columnId] = raw === true || raw === 'true' || raw === 'on' || raw === 1;
        break;
      case 'select':
      case 'status': {
        if (!known) {
          // No column to check against (see SubmissionContext): coerce only.
          values[field.columnId] = Array.isArray(raw) ? raw.map(String) : String(raw);
          break;
        }
        const list = asStringList(raw);
        const allowed = new Set((known.options ?? []).map((o) => o.value));
        const shaped = list && list.length > 0 && list.every((v) => allowed.has(v)) ? shapeAnswer(list, Boolean(known.multiple)) : null;
        if (shaped === null) errors[field.columnId] = 'invalid';
        else values[field.columnId] = shaped;
        break;
      }
      case 'user': {
        if (!ctx) {
          values[field.columnId] = Array.isArray(raw) ? raw.map(String).join(', ') : String(raw);
          break;
        }
        const list = asStringList(raw)?.map((h) => (h.startsWith('@') ? h.slice(1) : h).toLowerCase());
        const shaped = list && list.length > 0 && list.every((h) => ctx.users!.has(h)) ? shapeAnswer([...new Set(list)], Boolean(known?.multiple)) : null;
        if (shaped === null) errors[field.columnId] = 'invalid';
        else values[field.columnId] = shaped;
        break;
      }
      case 'link': {
        if (!ctx) {
          values[field.columnId] = Array.isArray(raw) ? raw.map(String).join(', ') : String(raw);
          break;
        }
        const link = normalizeLink(raw);
        if (link === null) errors[field.columnId] = 'invalid';
        else values[field.columnId] = link;
        break;
      }
      case 'text':
      case 'longtext':
      case 'date':
      default:
        values[field.columnId] = Array.isArray(raw) ? raw.map(String).join(', ') : String(raw);
        break;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, values };
}
