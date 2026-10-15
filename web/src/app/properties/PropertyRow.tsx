import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, X } from 'lucide-react';
import type { PageStatus, PropertyType } from '@shared/contracts';
import {
  STATUS_VALUES,
  addChips,
  chipsOf,
  dateInputValue,
  datetimeInputValue,
  editorKindFor,
  isFlatList,
  parseNumberInput,
  sameValue,
} from './propertyValues';
import '../i18n/register';

const FIELD_CLASS =
  'w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-sm text-neutral-900 outline-none hover:border-neutral-300 focus:border-neutral-400 dark:text-neutral-100 dark:hover:border-neutral-700 dark:focus:border-neutral-500';

/** What every editor reports: the value to store, or "nothing changed" (Esc, or a blur without an edit). */
interface EditorProps {
  name: string;
  value: unknown;
  autoFocus?: boolean;
  onCommit: (value: unknown) => void;
  onUnchanged: () => void;
}

/**
 * A text-like field: Enter commits (by leaving the field, so the blur is the single commit),
 * Esc puts the stored value back, and leaving the field with an edit commits it as well.
 */
function useFieldCommit(initial: string, parse: (text: string) => unknown, onCommit: (value: unknown) => void, onUnchanged: () => void) {
  const [draft, setDraft] = useState(initial);
  const cancelled = useRef(false);
  // The stored value moved (our own save landed, or the page was reloaded): show it.
  useEffect(() => setDraft(initial), [initial]);

  return {
    draft,
    setDraft,
    handlers: {
      onBlur: () => {
        if (cancelled.current) {
          cancelled.current = false;
          setDraft(initial);
          onUnchanged();
          return;
        }
        if (draft === initial) onUnchanged();
        else onCommit(parse(draft));
      },
      onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          // Esc cancels the field only; it must not reach a dialog or the switcher behind it.
          event.stopPropagation();
          cancelled.current = true;
          event.currentTarget.blur();
        }
      },
    },
  };
}

function TextEditor({ name, value, autoFocus, onCommit, onUnchanged }: EditorProps) {
  const initial = value === null || value === undefined ? '' : String(value);
  const field = useFieldCommit(initial, (text) => text, onCommit, onUnchanged);
  return (
    <input
      aria-label={name}
      value={field.draft}
      autoFocus={autoFocus}
      onChange={(e) => field.setDraft(e.target.value)}
      className={FIELD_CLASS}
      {...field.handlers}
    />
  );
}

function NumberEditor({ name, value, autoFocus, onCommit, onUnchanged }: EditorProps) {
  const initial = typeof value === 'number' ? String(value) : '';
  const field = useFieldCommit(initial, parseNumberInput, onCommit, onUnchanged);
  return (
    <input
      aria-label={name}
      type="number"
      inputMode="decimal"
      value={field.draft}
      autoFocus={autoFocus}
      onChange={(e) => field.setDraft(e.target.value)}
      className={FIELD_CLASS}
      {...field.handlers}
    />
  );
}

function DateEditor({ name, value, kind, autoFocus, onCommit, onUnchanged }: EditorProps & { kind: 'date' | 'datetime' }) {
  const initial = kind === 'date' ? dateInputValue(value) : datetimeInputValue(value);
  const field = useFieldCommit(initial, (text) => (text ? text : null), onCommit, onUnchanged);
  return (
    <input
      aria-label={name}
      type={kind === 'date' ? 'date' : 'datetime-local'}
      value={field.draft}
      autoFocus={autoFocus}
      onChange={(e) => field.setDraft(e.target.value)}
      className={`${FIELD_CLASS} max-w-[16rem]`}
      {...field.handlers}
    />
  );
}

function CheckboxEditor({ name, value, autoFocus, onCommit }: EditorProps) {
  return (
    <input
      aria-label={name}
      type="checkbox"
      checked={value === true}
      autoFocus={autoFocus}
      onChange={(e) => onCommit(e.target.checked)}
      className="mx-1.5 my-1 size-4 accent-neutral-800 dark:accent-neutral-200"
    />
  );
}

function StatusEditor({ name, value, autoFocus, onCommit, onUnchanged }: EditorProps) {
  const { t } = useTranslation('app');
  const current = typeof value === 'string' ? value : '';
  return (
    <select
      aria-label={name}
      value={current}
      autoFocus={autoFocus}
      onChange={(e) => (e.target.value === current ? onUnchanged() : onCommit(e.target.value))}
      className={`${FIELD_CLASS} max-w-[12rem]`}
    >
      {current === '' && <option value="" />}
      {STATUS_VALUES.map((status: PageStatus) => (
        <option key={status} value={status}>
          {t(`properties.status.${status}`)}
        </option>
      ))}
    </select>
  );
}

function Chip({ label, onRemove, removeLabel }: { label: string; onRemove?: () => void; removeLabel?: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
      <span className="truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={onRemove}
          className="rounded-full text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
        >
          <X size={11} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

function ChipsEditor({ name, type, value, autoFocus, onCommit, onUnchanged }: EditorProps & { type: PropertyType }) {
  const { t } = useTranslation('app');
  const chips = chipsOf(value, type);
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const cancelled = useRef(false);

  function add(raw: string) {
    if (!raw.trim()) return;
    const next = addChips(chips, raw, type);
    if (next.length === chips.length) {
      // Already there, or not something that can be this kind of chip (a tag has no spaces or `?`): say so, keep the text.
      setInvalid(true);
      return;
    }
    setText('');
    setInvalid(false);
    onCommit(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',' || (event.key === ' ' && type === 'tags' && text.trim())) {
      event.preventDefault();
      add(text);
    } else if (event.key === 'Backspace' && text === '' && chips.length > 0) {
      onCommit(chips.slice(0, -1));
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      cancelled.current = true;
      setText('');
      setInvalid(false);
      event.currentTarget.blur();
    }
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 px-1">
      {chips.map((chip) => (
        <Chip
          key={chip}
          label={type === 'tags' ? `#${chip}` : chip}
          removeLabel={t('properties.removeChip', { chip })}
          onRemove={() => onCommit(chips.filter((item) => item !== chip))}
        />
      ))}
      <input
        aria-label={name}
        aria-invalid={invalid || undefined}
        title={invalid ? t('properties.chipRejected') : undefined}
        value={text}
        autoFocus={autoFocus}
        placeholder={t(type === 'tags' ? 'properties.addTagPlaceholder' : 'properties.addItemPlaceholder')}
        onChange={(e) => {
          setText(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (cancelled.current) {
            cancelled.current = false;
            onUnchanged();
            return;
          }
          if (text.trim()) add(text);
          else onUnchanged();
        }}
        className="min-w-[7rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
      />
    </div>
  );
}

/** Values the panel never edits: scalars as text, flat lists as chips, maps and lists of maps as JSON. */
export function ReadOnlyValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="px-1.5 py-0.5 text-neutral-400">—</span>;
  if (isFlatList(value)) {
    return (
      <div className="flex flex-wrap gap-1 px-1.5 py-0.5">
        {value.map((item, index) => (
          <Chip key={`${index}:${String(item)}`} label={String(item)} />
        ))}
      </div>
    );
  }
  if (typeof value === 'object') {
    return (
      <pre className="max-h-40 overflow-auto rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return <span className="break-words px-1.5 py-0.5 text-neutral-700 dark:text-neutral-300">{String(value)}</span>;
}

export interface PropertyRowProps {
  name: string;
  value: unknown;
  type: PropertyType;
  /** The server reports this Folio key's value as one Folio would not write: shown with a badge, never edited. */
  foreign?: boolean;
  /** `id`, and `labels:` beside a `tags:` of its own: shown, never edited. */
  locked?: boolean;
  canEdit: boolean;
  /** Just added: nothing is stored yet, so Esc or an unchanged commit drops the row instead of keeping an empty property. */
  draft?: boolean;
  onCommit: (key: string, value: unknown) => void;
  onRemove: (key: string) => void;
  onCancelDraft: () => void;
}

/** One front matter property: its name, the editor its type calls for (or a read-only view), and a remove button. */
export function PropertyRow({ name, value, type, foreign, locked, canEdit, draft, onCommit, onRemove, onCancelDraft }: PropertyRowProps) {
  const { t } = useTranslation('app');
  const readOnly = !canEdit || Boolean(foreign) || Boolean(locked);
  const kind = readOnly ? 'readonly' : editorKindFor(name, type, value);

  const editor: EditorProps = {
    name,
    value,
    autoFocus: draft,
    onCommit: (next) => {
      if (sameValue(next, value)) {
        if (draft) onCancelDraft();
        return;
      }
      onCommit(name, next);
    },
    onUnchanged: () => {
      if (draft) onCancelDraft();
    },
  };

  return (
    <div role="group" aria-label={name} data-property={name} className="group grid grid-cols-[minmax(5rem,9rem)_minmax(0,1fr)_1.5rem] items-start gap-x-3 py-0.5 text-sm">
      <div className="flex min-w-0 items-center gap-1 px-1.5 py-0.5 text-neutral-500 dark:text-neutral-400" title={`${name} · ${t(`properties.types.${type}`)}`}>
        {locked && <Lock size={11} className="shrink-0 opacity-60" aria-hidden="true" />}
        <span className="truncate">{name}</span>
      </div>
      <div className="min-w-0">
        {kind === 'text' && <TextEditor {...editor} />}
        {kind === 'number' && <NumberEditor {...editor} />}
        {kind === 'checkbox' && <CheckboxEditor {...editor} />}
        {(kind === 'date' || kind === 'datetime') && <DateEditor {...editor} kind={kind} />}
        {kind === 'status' && <StatusEditor {...editor} />}
        {kind === 'chips' && <ChipsEditor {...editor} type={type} />}
        {kind === 'readonly' && (
          <div className="flex flex-wrap items-start gap-2">
            <ReadOnlyValue value={value} />
            {foreign && (
              <span
                title={t('properties.foreignHint')}
                className="mt-0.5 inline-flex shrink-0 items-center rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
              >
                {t('properties.foreign')}
              </span>
            )}
          </div>
        )}
      </div>
      <div>
        {canEdit && !locked && !foreign && !draft && (
          <button
            type="button"
            aria-label={t('properties.remove', { name })}
            title={t('properties.remove', { name })}
            onClick={() => onRemove(name)}
            className="rounded p-1 text-neutral-400 opacity-0 hover:bg-neutral-200 hover:text-neutral-700 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-200 max-md:opacity-100"
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
