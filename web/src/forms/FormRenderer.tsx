import { useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormField, FormFieldChoices } from '@shared/contracts';
import { formatDraftTime, removeDraft, useBeforeUnloadWarning, useDraftAutosave } from './draftStorage';
import { hasAnswers, loadAnswersDraft, toAnswersDraft } from './answersDraft';
import { InlineChoices, LinkInput, RADIO_MAX, SearchableChoices, SelectDropdown } from './FormChoiceInputs';
import type { ChoiceItem } from './FormChoiceInputs';
import './i18n/register';

export interface FormSubmitOutcome {
  ok: boolean;
  /** Set on failure — a generic message shown above the form. */
  message?: string;
  /** Set on a 400 validation failure — columnId -> 'required' | 'invalid', rendered under each field. */
  fieldErrors?: Record<string, string>;
}

export interface FormRendererProps {
  title: string;
  description?: string;
  fields: readonly FormField[];
  /**
   * What each field needs beyond its `kind` (the bound column's options and
   * `multiple`, the members of a `user` field), by columnId — `PageDoc.
   * formChoices`. Without an entry a select/status/user field is a plain text
   * input, as before; `hidden: true` leaves the field out (a `user` field of
   * an anonymous respondent).
   */
  choices?: Record<string, FormFieldChoices>;
  submitButtonLabel?: string;
  /**
   * Deliberately IO-free (see this module's own header note): the page
   * route wires this to `api.submitForm` (app/api.ts), the `::form{id}`
   * embed widget wires it to a plain `fetch` — same "no app/ <-> markdown/
   * import edge" rule web/src/markdown/PageTree.tsx already follows.
   */
  onSubmit: (values: Record<string, unknown>) => Promise<FormSubmitOutcome>;
  /** Show the form but do not let it be sent (a public site's anonymous reader: the form is filled in inside Folio). */
  submitDisabled?: boolean;
  /**
   * localStorage slot for this respondent's half-filled answers (see
   * draftStorage.answersDraftKey — per form AND per user / share token).
   * Undefined = nothing is kept and no leave-warning is shown.
   */
  draftKey?: string;
}

/**
 * Round FORMS — the one place that actually renders a form's fields and
 * collects a submission. Mounted from TWO places with otherwise nothing in
 * common (the form's own page route, and the `::form{id}` embed widget
 * inline in any other page) — kept in `web/src/forms/` rather than either
 * `app/` or `markdown/` so neither has to depend on the other to share it.
 *
 * Choice kinds (select/status -> radio group up to RADIO_MAX options, a
 * dropdown above it, checkboxes / a searchable list for `multiple`; user -> a
 * searchable member picker; link -> URL + label) take their options from
 * `choices`; a field with no entry there falls back to a plain text input.
 */
export function FormRenderer({ title, description, fields: allFields, choices, submitButtonLabel, onSubmit, submitDisabled, draftKey }: FormRendererProps) {
  const { t, i18n } = useTranslation('forms');
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  // A field this respondent cannot answer is not on their form at all.
  const fields = useMemo(() => allFields.filter((f) => !choices?.[f.columnId]?.hidden), [allFields, choices]);
  // Bumped when the answers are wiped, so a field with its own inner state (link) starts empty too.
  const [resetNonce, setResetNonce] = useState(0);
  // Answers typed before a reload / a crashed tab come back on their own,
  // with a note and a one-click "Clear". Read once on mount.
  const [restored, setRestored] = useState(() => (draftKey ? loadAnswersDraft(draftKey, fields, choices) : null));
  const [values, setValues] = useState<Record<string, unknown>>(() => restored?.values ?? {});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [succeeded, setSucceeded] = useState(false);

  const draft = useMemo(() => toAnswersDraft(values, fields), [values, fields]);
  const unsent = hasAnswers(draft) && !succeeded && !submitDisabled;
  const autosave = useDraftAutosave(draftKey, draft, { enabled: !succeeded && !submitDisabled, persist: hasAnswers(draft) });
  useBeforeUnloadWarning(Boolean(draftKey) && unsent);

  function clearAnswers() {
    setValues({});
    setFieldErrors({});
    setRestored(null);
    setResetNonce((n) => n + 1);
    if (draftKey) removeDraft(draftKey);
  }

  function setValue(columnId: string, value: unknown) {
    setValues((prev) => ({ ...prev, [columnId]: value }));
    if (fieldErrors[columnId]) setFieldErrors((prev) => ({ ...prev, [columnId]: '' }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting || submitDisabled) return;
    // Required is checked here for every kind (the form is `noValidate`): one inline message under each empty field,
    // the same look for a text box, a radio group and a member list — a group of checkboxes has no native `required` anyway.
    const missing = fields.filter((f) => f.required && f.kind !== 'checkbox' && isBlank(values[f.columnId]));
    if (missing.length > 0) {
      setFieldErrors(Object.fromEntries(missing.map((f) => [f.columnId, 'required'])));
      setFormError(undefined);
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(`[data-field="${CSS.escape(missing[0].columnId)}"] :is(input, select, textarea)`)?.focus());
      return;
    }
    setSubmitting(true);
    setFormError(undefined);
    try {
      const result = await onSubmit(values);
      if (result.ok) {
        // Sent — the kept answers must not come back on the next visit.
        autosave.clear();
        setRestored(null);
        setSucceeded(true);
      } else {
        setFormError(result.message ?? t('genericError'));
        setFieldErrors(result.fieldErrors ?? {});
      }
    } catch {
      setFormError(t('genericError'));
    } finally {
      setSubmitting(false);
    }
  }

  if (succeeded) {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-6 text-center dark:border-green-900 dark:bg-green-950/30">
        <p className="text-sm font-medium text-green-800 dark:text-green-200">{t('successTitle')}</p>
        <button
          type="button"
          onClick={() => {
            setValues({});
            setFieldErrors({});
            setResetNonce((n) => n + 1);
            autosave.resume();
            setSucceeded(false);
          }}
          className="mt-3 rounded-md border border-green-300 bg-white px-3 py-1.5 text-sm text-green-800 hover:bg-green-100 dark:border-green-800 dark:bg-neutral-900 dark:text-green-200 dark:hover:bg-green-950"
        >
          {t('submitAnother')}
        </button>
      </div>
    );
  }

  return (
    <form ref={formRef} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{title}</h2>
        {description && <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{description}</p>}
      </div>

      {restored && (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
          <span>
            {t('answersRestored', { time: formatDraftTime(restored.savedAt, i18n.language) })}
            {restored.skippedLabels.length > 0 && ` ${t('answersSkipped', { fields: restored.skippedLabels.join(', ') })}`}
            {restored.droppedLabels.length > 0 && ` ${t('answersDropped', { fields: restored.droppedLabels.join(', ') })}`}
          </span>
          <button type="button" onClick={clearAnswers} className="font-medium underline underline-offset-2">
            {t('answersClear')}
          </button>
        </div>
      )}

      {formError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {formError}
        </p>
      )}

      {fields.map((field) => (
        <FieldBlock
          key={`${field.columnId}:${resetNonce}`}
          field={field}
          choice={choices?.[field.columnId]}
          idPrefix={uid}
          value={values[field.columnId]}
          onChange={(v) => setValue(field.columnId, v)}
          error={fieldErrors[field.columnId] ? (fieldErrors[field.columnId] === 'required' ? t('fieldRequiredError') : t('fieldInvalidError')) : undefined}
        />
      ))}

      <button
        type="submit"
        disabled={submitting || submitDisabled}
        className="mt-2 self-start rounded-md bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {submitting ? t('submitting') : (submitButtonLabel?.trim() || t('submit'))}
      </button>
    </form>
  );
}

const inputClassName =
  'rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:text-neutral-100 dark:focus:border-neutral-500';

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);
}

type Control = 'plain' | 'radio' | 'dropdown' | 'checks' | 'list' | 'members' | 'link';

/** Which control a field gets, from its kind and what the server told about it. 'plain' = the native-required inputs (text, number, date, …). */
function controlOf(field: FormField, choice: FormFieldChoices | undefined): Control {
  switch (field.kind) {
    case 'select':
    case 'status': {
      if (!choice?.options) return 'plain'; // the paired column could not be read: type the value
      if (choice.multiple) return choice.options.length <= RADIO_MAX ? 'checks' : 'list';
      return choice.options.length <= RADIO_MAX ? 'radio' : 'dropdown';
    }
    case 'user':
      return choice?.users ? 'members' : 'plain';
    case 'link':
      return 'link';
    default:
      return 'plain';
  }
}

function itemsOf(field: FormField, choice: FormFieldChoices | undefined): ChoiceItem[] {
  if (choice?.users) return choice.users.map((u) => ({ value: u.username, label: u.name || u.username, hint: `@${u.username}` }));
  return (choice?.options ?? []).map((o) => ({
    value: o.value,
    label: o.value,
    color: o.color,
    // Status is all about its colour; a select shows one only when the owner picked a real colour.
    chip: field.kind === 'status' ? true : o.color !== undefined && o.color !== 'gray' && o.color !== 'none',
  }));
}

function FieldBlock({ field, choice, idPrefix, value, onChange, error }: { field: FormField; choice: FormFieldChoices | undefined; idPrefix: string; value: unknown; onChange: (v: unknown) => void; error?: string }) {
  const control = controlOf(field, choice);
  const base = `${idPrefix}-${field.columnId}`;
  const helpId = field.help ? `${base}-help` : undefined;
  const errorId = error ? `${base}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined;
  const title = (
    <>
      {field.label}
      {field.required && <span className="ml-0.5 text-red-500" aria-hidden="true">*</span>}
    </>
  );
  const help = field.help && (
    <span id={helpId} className="text-xs text-neutral-400 dark:text-neutral-500">
      {field.help}
    </span>
  );
  const errorText = error && (
    <span id={errorId} role="alert" className="text-xs text-red-600 dark:text-red-400">
      {error}
    </span>
  );
  const titleClassName = 'text-neutral-700 dark:text-neutral-300';

  if (control === 'plain') {
    return (
      <label className="flex flex-col gap-1 text-sm" data-field={field.columnId}>
        <span className={titleClassName}>{title}</span>
        {help}
        <FieldInput field={field} value={value} onChange={onChange} describedBy={describedBy} />
        {errorText}
      </label>
    );
  }

  if (control === 'dropdown') {
    return (
      <div className="flex flex-col gap-1 text-sm" data-field={field.columnId}>
        <label htmlFor={`${base}-input`} className={titleClassName}>
          {title}
        </label>
        {help}
        <SelectDropdown id={`${base}-input`} items={itemsOf(field, choice)} value={value} onChange={onChange} invalid={Boolean(error)} describedBy={describedBy} className={inputClassName} />
        {errorText}
      </div>
    );
  }

  const items = itemsOf(field, choice);
  return (
    <fieldset className="flex min-w-0 flex-col gap-1 border-0 p-0 text-sm" data-field={field.columnId} aria-required={field.required || undefined}>
      <legend className={`${titleClassName} mb-1 p-0`}>{title}</legend>
      {help}
      {control === 'radio' || control === 'checks' ? (
        <InlineChoices items={items} value={value} multiple={control === 'checks'} onChange={onChange} invalid={Boolean(error)} describedBy={describedBy} />
      ) : control === 'link' ? (
        <LinkInput value={value} onChange={onChange} required={field.required} invalid={Boolean(error)} describedBy={describedBy} className={inputClassName} />
      ) : (
        <SearchableChoices
          items={items}
          value={value}
          multiple={Boolean(choice?.multiple)}
          onChange={onChange}
          invalid={Boolean(error)}
          describedBy={describedBy}
          inputClassName={inputClassName}
        />
      )}
      {errorText}
    </fieldset>
  );
}

function FieldInput({ field, value, onChange, describedBy }: { field: FormField; value: unknown; onChange: (v: unknown) => void; describedBy?: string }) {
  const { t } = useTranslation('forms');
  switch (field.kind) {
    case 'longtext':
      return (
        <textarea
          required={field.required}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          aria-describedby={describedBy}
          className={inputClassName}
        />
      );
    case 'number':
      return (
        <input
          type="number"
          required={field.required}
          value={(value as string | number) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={describedBy}
          className={inputClassName}
        />
      );
    case 'checkbox':
      return (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          <span className="text-neutral-600 dark:text-neutral-400">{t('checkboxYes')}</span>
        </label>
      );
    case 'date':
      return (
        <input
          type="date"
          required={field.required}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={describedBy}
          className={inputClassName}
        />
      );
    // 'text', and select/status/user without choices — see the module doc comment.
    default:
      return (
        <input
          type="text"
          required={field.required}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={describedBy}
          className={inputClassName}
        />
      );
  }
}
