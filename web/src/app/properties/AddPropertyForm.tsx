import { useId, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { PropertyType } from '@shared/contracts';
import { api } from '../api';
import { PROPERTY_TYPES, normalizeKeyInput } from './propertyValues';
import '../i18n/register';

export interface NewProperty {
  key: string;
  type: PropertyType;
  /** The author asked to keep this key's type in the space's `.folio/properties.json` (space admins only). */
  saveType: boolean;
}

export interface AddPropertyFormProps {
  space: string;
  /** Keys the page already has — they cannot be added twice. */
  existingKeys: readonly string[];
  /** Space admin: may write the space's property types. Everyone else sees the type the key already has (or is inferred to have). */
  canManageTypes: boolean;
  onAdd: (property: NewProperty) => void;
  onClose: () => void;
}

const FIELD =
  'rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:text-neutral-100';

/**
 * "Add property": a key picked from the space's known keys (GET property-types → `known`)
 * or typed freely, and the type its editor should have. A known key brings its type along
 * and cannot be retyped here; a brand-new key gets a type selector and, for a space admin,
 * an offer to keep that type for the whole space.
 */
export function AddPropertyForm({ space, existingKeys, canManageTypes, onAdd, onClose }: AddPropertyFormProps) {
  const { t } = useTranslation('app');
  const listId = useId();
  const [rawKey, setRawKey] = useState('');
  const [chosenType, setChosenType] = useState<PropertyType>('text');
  const [saveType, setSaveType] = useState(false);

  const { data } = useQuery({
    queryKey: ['property-types', space],
    queryFn: () => api.getSpacePropertyTypes(space),
    staleTime: 30_000,
    retry: false,
  });

  const key = normalizeKeyInput(rawKey);
  const known = useMemo(() => new Map((data?.known ?? []).map((entry) => [entry.key, entry])), [data]);
  const spaceType = key ? data?.types[key] : undefined;
  // A key the space already types, or has seen with values, brings its type along.
  const knownType = key ? (spaceType ?? known.get(key)?.inferred) : undefined;
  const type = knownType ?? chosenType;
  const duplicate = key !== null && existingKeys.includes(key);
  const suggestions = (data?.known ?? []).filter((entry) => !existingKeys.includes(entry.key));

  function submit() {
    if (!key || duplicate) return;
    onAdd({ key, type, saveType: canManageTypes && saveType && !spaceType });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter') {
      // A focused button keeps its own Enter (Cancel must not submit).
      if (event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }

  return (
    <div role="group" aria-label={t('properties.add')} className="mt-1 flex flex-wrap items-center gap-2 rounded-md bg-neutral-50 p-2 dark:bg-neutral-900/60" onKeyDown={handleKeyDown}>
      <input
        autoFocus
        list={listId}
        value={rawKey}
        onChange={(e) => setRawKey(e.target.value)}
        placeholder={t('properties.keyPlaceholder')}
        aria-label={t('properties.keyLabel')}
        aria-invalid={duplicate || undefined}
        title={duplicate ? t('properties.duplicateKey') : undefined}
        maxLength={100}
        className={`${FIELD} w-44 min-w-0`}
      />
      <datalist id={listId}>
        {suggestions.map((entry) => (
          <option key={entry.key} value={entry.key}>
            {t('properties.knownKey', { type: t(`properties.types.${entry.inferred}`), pages: entry.pages })}
          </option>
        ))}
      </datalist>
      <select
        aria-label={t('properties.typeLabel')}
        value={type}
        disabled={knownType !== undefined}
        title={knownType !== undefined ? t('properties.typeFixed') : undefined}
        onChange={(e) => setChosenType(e.target.value as PropertyType)}
        className={FIELD}
      >
        {PROPERTY_TYPES.map((option) => (
          <option key={option} value={option}>
            {t(`properties.types.${option}`)}
          </option>
        ))}
      </select>
      {canManageTypes && key && !spaceType && (
        <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400">
          <input type="checkbox" checked={saveType} onChange={(e) => setSaveType(e.target.checked)} />
          {t('properties.saveType')}
        </label>
      )}
      <div className="ml-auto flex items-center gap-1">
        <button type="button" onClick={onClose} className="rounded-md px-2.5 py-1 text-sm hover:bg-neutral-200/70 dark:hover:bg-neutral-800">
          {t('ui.cancel')}
        </button>
        <button
          type="button"
          disabled={!key || duplicate}
          onClick={submit}
          className="rounded-md bg-neutral-900 px-2.5 py-1 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {t('properties.addAction')}
        </button>
      </div>
    </div>
  );
}
