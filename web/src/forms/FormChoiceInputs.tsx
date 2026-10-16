import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatLinkValue, parseLinkValue } from '@shared/tables/values';
import { Chip } from '../tables/cells/Chip';
import type { TableColor } from '../tables/colors';
import './i18n/register';

/**
 * Round FORMS — the controls of the "choice" field kinds: select / status
 * (radio group up to RADIO_MAX options, a dropdown above it; checkboxes /
 * a searchable list for `multiple`), user (a searchable member picker) and
 * link (URL + optional label). Everything is native inputs inside a
 * <fieldset> (arrow keys, space, Tab and screen readers work as in any form);
 * "required" is checked by FormRenderer on submit because a group of
 * checkboxes has no native required.
 */

/** Up to this many options a single choice is a radio group; above it, a dropdown. */
export const RADIO_MAX = 6;
/** Above this many items the picker list gets a search box. */
const SEARCH_MIN = 8;

export interface ChoiceItem {
  value: string;
  label: string;
  /** Second line (a member's @username). */
  hint?: string;
  color?: TableColor;
  /** Show the colour as a chip (status always, select only for a non-neutral colour). */
  chip?: boolean;
}

const rowClassName =
  'flex min-h-10 cursor-pointer items-center gap-2.5 rounded-md border border-neutral-200 px-3 py-2 text-sm hover:bg-neutral-50 has-[:checked]:border-neutral-500 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-500 dark:border-neutral-800 dark:hover:bg-neutral-900 dark:has-[:checked]:border-neutral-400';

function ItemLabel({ item }: { item: ChoiceItem }) {
  return (
    <span className="flex min-w-0 flex-col">
      {item.chip ? <Chip value={item.label} color={item.color} className="self-start" /> : <span className="truncate text-neutral-800 dark:text-neutral-200">{item.label}</span>}
      {item.hint && <span className="truncate text-xs text-neutral-400 dark:text-neutral-500">{item.hint}</span>}
    </span>
  );
}

interface GroupProps {
  items: ChoiceItem[];
  /** The answer: a string, or a list for `multiple`. */
  value: unknown;
  multiple: boolean;
  onChange: (value: string | string[] | '') => void;
  invalid?: boolean;
  describedBy?: string;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value !== '') return [value];
  return [];
}

/** Radio group (single) or checkbox group (multiple): every item visible. */
export function InlineChoices({ items, value, multiple, onChange, invalid, describedBy }: GroupProps) {
  const { t } = useTranslation('forms');
  const name = useId();
  const selected = asList(value);
  if (items.length === 0) return <p className="text-xs text-neutral-400 dark:text-neutral-500">{t('choiceNone')}</p>;
  return (
    <div className="flex flex-col gap-1.5" aria-invalid={invalid || undefined} aria-describedby={describedBy}>
      {items.map((item) => {
        const checked = selected.includes(item.value);
        return (
          <label key={item.value} className={rowClassName}>
            <input
              type={multiple ? 'checkbox' : 'radio'}
              name={name}
              value={item.value}
              checked={checked}
              onChange={() => onChange(multiple ? (checked ? selected.filter((v) => v !== item.value) : [...selected, item.value]) : item.value)}
            />
            <ItemLabel item={item} />
          </label>
        );
      })}
      {!multiple && selected.length > 0 && (
        <button type="button" onClick={() => onChange('')} className="self-start text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-700 dark:text-neutral-400">
          {t('choiceClear')}
        </button>
      )}
    </div>
  );
}

/** A single choice out of many: the native dropdown (the best control on a phone). */
export function SelectDropdown({ id, items, value, onChange, invalid, describedBy, className }: Omit<GroupProps, 'multiple'> & { id: string; className: string }) {
  const { t } = useTranslation('forms');
  const current = asList(value)[0] ?? '';
  const item = items.find((i) => i.value === current);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        id={id}
        value={current}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={`${className} min-w-0 max-w-full flex-1`}
      >
        <option value="">{t('choicePlaceholder')}</option>
        {items.map((i) => (
          <option key={i.value} value={i.value}>
            {i.label}
          </option>
        ))}
      </select>
      {item?.chip && <Chip value={item.label} color={item.color} />}
    </div>
  );
}

/**
 * Many items (a long multiple select, the members of a space): the chosen
 * ones as chips on top, a search box, and a scrollable list of radios /
 * checkboxes below. Single choice keeps radios, so one pick replaces another.
 */
export function SearchableChoices({ items, value, multiple, onChange, invalid, describedBy, inputClassName }: GroupProps & { inputClassName: string }) {
  const { t } = useTranslation('forms');
  const name = useId();
  const [search, setSearch] = useState('');
  const selected = asList(value);
  const needle = search.trim().toLowerCase();
  const shown = useMemo(
    () => (needle ? items.filter((i) => i.label.toLowerCase().includes(needle) || i.hint?.toLowerCase().includes(needle)) : items),
    [items, needle],
  );
  if (items.length === 0) return <p className="text-xs text-neutral-400 dark:text-neutral-500">{t('choiceNone')}</p>;
  const byValue = new Map(items.map((i) => [i.value, i]));
  return (
    <div className="flex flex-col gap-2" aria-invalid={invalid || undefined} aria-describedby={describedBy}>
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {selected.map((v) => {
            const item = byValue.get(v);
            return (
              <Chip
                key={v}
                value={item?.label ?? v}
                color={item?.color}
                onRemove={() => onChange(multiple ? selected.filter((s) => s !== v) : '')}
                removeLabel={t('choiceRemove', { value: item?.label ?? v })}
              />
            );
          })}
        </div>
      )}
      {items.length >= SEARCH_MIN && (
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('choiceSearch')}
          aria-label={t('choiceSearch')}
          className={inputClassName}
        />
      )}
      <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md border border-neutral-200 p-1 dark:border-neutral-800">
        {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-neutral-400 dark:text-neutral-500">{t('choiceNothingFound')}</p>}
        {shown.map((item) => {
          const checked = selected.includes(item.value);
          return (
            <label key={item.value} className={rowClassName}>
              <input
                type={multiple ? 'checkbox' : 'radio'}
                name={name}
                value={item.value}
                checked={checked}
                onChange={() => onChange(multiple ? (checked ? selected.filter((v) => v !== item.value) : [...selected, item.value]) : item.value)}
              />
              <ItemLabel item={item} />
            </label>
          );
        })}
      </div>
    </div>
  );
}

/**
 * `link`: a URL and an optional label. The answer is the table's own link
 * encoding (`[label](url)`, or the bare URL), so it lands in the cell as is.
 * The two boxes keep their own state — a label typed before the URL is not
 * lost — and the form's answer is empty until the URL is.
 */
export function LinkInput({ value, onChange, required, invalid, describedBy, className }: { value: unknown; onChange: (value: string) => void; required: boolean; invalid?: boolean; describedBy?: string; className: string }) {
  const { t } = useTranslation('forms');
  const initial = typeof value === 'string' ? parseLinkValue(value) : null;
  const [url, setUrl] = useState(initial?.url ?? '');
  const [caption, setCaption] = useState(initial?.caption ?? '');
  function emit(nextUrl: string, nextCaption: string) {
    const u = nextUrl.trim();
    onChange(u ? formatLinkValue(u, nextCaption.replace(/[[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim() || undefined) : '');
  }
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <input
        type="url"
        inputMode="url"
        required={required}
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          emit(e.target.value, caption);
        }}
        placeholder="https://"
        aria-label={t('linkUrl')}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={`${className} min-w-0 flex-[2]`}
      />
      <input
        type="text"
        value={caption}
        onChange={(e) => {
          setCaption(e.target.value);
          emit(url, e.target.value);
        }}
        placeholder={t('linkLabel')}
        aria-label={t('linkLabel')}
        className={`${className} min-w-0 flex-1`}
      />
    </div>
  );
}
