import type { FormField, FormFieldChoices } from '@shared/contracts';
import { readDraft, removeDraft } from './draftStorage';

/**
 * A respondent's half-filled answers, kept locally so a reload does not
 * throw them away. What is deliberately NOT kept:
 *   - anything that is not a plain string / number / boolean — a file
 *     upload's `File` object, say, never goes into localStorage; the field is
 *     reported as "skipped" so the form can ask for it to be attached again;
 *   - fields of a sensitive kind (password / secret / file-like). The current
 *     field kinds (text, longtext, number, date, checkbox, select, status,
 *     user, link) have none, but the guard keeps a future one from leaking
 *     into localStorage by default.
 */

type Primitive = string | number | boolean | string[];

export interface AnswersDraftData {
  values: Record<string, Primitive>;
  /** columnIds whose answers were not stored (files, sensitive kinds) — they need re-entering. */
  skipped: string[];
}

export interface RestoredAnswers {
  values: Record<string, unknown>;
  skippedLabels: string[];
  /** Fields whose kept answer is no longer among the field's choices (an option or a member removed since) — dropped. */
  droppedLabels: string[];
  savedAt: number;
}

const NEVER_STORE_KINDS = new Set<string>(['password', 'secret', 'file', 'files', 'attachment', 'image']);

function isEmptyAnswer(value: unknown): boolean {
  return value === undefined || value === null || value === '' || value === false || (typeof value === 'number' && Number.isNaN(value)) || (Array.isArray(value) && value.length === 0);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** A stored answer that is storable: a string / number / boolean, or a list of strings (a `multiple` select). */
function isStorable(value: unknown): value is Primitive {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || isStringList(value);
}

/** The storable subset of the live `values`, plus the ids that could not be stored. */
export function toAnswersDraft(values: Record<string, unknown>, fields: readonly FormField[]): AnswersDraftData {
  const kindOf = new Map(fields.map((f) => [f.columnId, f.kind as string]));
  const out: Record<string, Primitive> = {};
  const skipped: string[] = [];
  for (const [columnId, value] of Object.entries(values)) {
    const kind = kindOf.get(columnId);
    if (kind === undefined || isEmptyAnswer(value)) continue;
    if (NEVER_STORE_KINDS.has(kind) || !isStorable(value)) {
      skipped.push(columnId);
      continue;
    }
    out[columnId] = value;
  }
  return { values: out, skipped };
}

/** Anything worth keeping (or worth warning about before leaving)? */
export function hasAnswers(draft: AnswersDraftData): boolean {
  return Object.keys(draft.values).length > 0 || draft.skipped.length > 0;
}

/** Stored answers that still fit the form as it is now (a field removed since is dropped). */
export function loadAnswersDraft(key: string, fields: readonly FormField[], choices?: Record<string, FormFieldChoices>): RestoredAnswers | null {
  const stored = readDraft<Partial<AnswersDraftData>>(key);
  if (!stored) return null;
  const raw = stored.data.values;
  if (!raw || typeof raw !== 'object') {
    removeDraft(key);
    return null;
  }
  const known = new Map(fields.map((f) => [f.columnId, f]));
  const values: Record<string, unknown> = {};
  const droppedLabels: string[] = [];
  for (const [columnId, value] of Object.entries(raw)) {
    const field = known.get(columnId);
    if (!field || !isStorable(value)) continue;
    const fitted = fitToChoices(value, choices?.[columnId]);
    if (fitted === undefined) droppedLabels.push(field.label);
    else values[columnId] = fitted;
  }
  const skippedLabels = (Array.isArray(stored.data.skipped) ? stored.data.skipped : [])
    .map((id) => (typeof id === 'string' ? known.get(id)?.label : undefined))
    .filter((label): label is string => Boolean(label));
  if (Object.keys(values).length === 0 && skippedLabels.length === 0 && droppedLabels.length === 0) {
    removeDraft(key);
    return null;
  }
  return { values, skippedLabels, droppedLabels, savedAt: stored.savedAt };
}

/**
 * A stored select/status/user answer as the field is NOW: kept to the values
 * the field still offers (an option renamed or removed, a member gone, since
 * the draft was written), in the shape its `multiple` says. `undefined` =
 * nothing of the answer fits any more. Without choices (a plain field) the
 * answer is kept as is.
 */
function fitToChoices(value: Primitive, choice: FormFieldChoices | undefined): Primitive | undefined {
  if (!choice || choice.hidden) return choice?.hidden ? undefined : value;
  const allowed = choice.options ? new Set(choice.options.map((o) => o.value)) : choice.users ? new Set(choice.users.map((u) => u.username)) : null;
  if (!allowed) return value;
  const list = (Array.isArray(value) ? value : [String(value)]).filter((v) => allowed.has(v));
  if (list.length === 0) return undefined;
  return choice.multiple ? list : list[0];
}
