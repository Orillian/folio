import type { FormDoc, FormField } from '@shared/contracts';
import { readDraft, removeDraft } from '../../forms/draftStorage';

/**
 * The form builder's local draft (FormDefinitionEditor). Everything the
 * dialog lets you type, held as plain JSON next to a fingerprint of the saved
 * form it was started from — so a later "restore" can tell when the saved form
 * has moved on in the meantime.
 *
 * Why local only and not "autosave to the server too": Save is not a plain
 * front-matter write. It first creates a real table COLUMN for every newly
 * added field (api.addTableColumn -> a commit on the paired table), then
 * writes the `.form` file. Autosaving that would litter the table with
 * half-finished columns and the history with commits on every pause, so the
 * draft stays on this device until the owner presses Save.
 */

export interface BuilderSnapshot {
  title: string;
  description: string;
  isPublic: boolean;
  submitButton: string;
  fields: FormField[];
}

export interface BuilderDraftData {
  /** JSON of the saved form's snapshot when the draft was started. */
  base: string;
  snapshot: BuilderSnapshot;
}

export interface OfferedBuilderDraft {
  snapshot: BuilderSnapshot;
  savedAt: number;
  /** The saved form changed after this draft was started — restoring replaces those changes. */
  stale: boolean;
}

export const PENDING_PREFIX = 'pending-column:';

export function snapshotOfForm(form: FormDoc): BuilderSnapshot {
  return {
    title: form.title,
    description: form.description ?? '',
    isPublic: form.public,
    submitButton: form.submitButton ?? '',
    fields: form.fields,
  };
}

export function snapshotJson(snapshot: BuilderSnapshot): string {
  return JSON.stringify(snapshot);
}

/** Highest `pending-column:N` suffix in use, so new fields never collide with restored ones. */
export function maxPendingCounter(fields: readonly FormField[]): number {
  let max = 0;
  for (const field of fields) {
    if (!field.columnId.startsWith(PENDING_PREFIX)) continue;
    const n = Number(field.columnId.slice(PENDING_PREFIX.length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function isFieldLike(value: unknown): value is FormField {
  if (!value || typeof value !== 'object') return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.columnId === 'string' &&
    typeof f.label === 'string' &&
    typeof f.required === 'boolean' &&
    typeof f.kind === 'string' &&
    (f.help === undefined || typeof f.help === 'string')
  );
}

function isSnapshotLike(value: unknown): value is BuilderSnapshot {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.title === 'string' &&
    typeof s.description === 'string' &&
    typeof s.isPublic === 'boolean' &&
    typeof s.submitButton === 'string' &&
    Array.isArray(s.fields) &&
    s.fields.every(isFieldLike)
  );
}

/**
 * The draft to offer for `form`, or null. A draft identical to the saved form
 * is noise and is dropped from storage on the spot.
 */
export function loadBuilderDraft(key: string, form: FormDoc): OfferedBuilderDraft | null {
  const stored = readDraft<BuilderDraftData>(key);
  if (!stored) return null;
  const { data } = stored;
  if (typeof data.base !== 'string' || !isSnapshotLike(data.snapshot)) {
    removeDraft(key);
    return null;
  }
  const baseJson = snapshotJson(snapshotOfForm(form));
  if (snapshotJson(data.snapshot) === baseJson) {
    removeDraft(key);
    return null;
  }
  return { snapshot: data.snapshot, savedAt: stored.savedAt, stale: data.base !== baseJson };
}
