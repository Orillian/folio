import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Plus, TriangleAlert } from 'lucide-react';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useLocalStorage } from '../hooks';
import { useToast } from '../ui/Toast';
import { AddPropertyForm } from './AddPropertyForm';
import type { NewProperty } from './AddPropertyForm';
import { PropertyRow } from './PropertyRow';
import { countProperties, effectiveType, emptyValueFor } from './propertyValues';
import { usePageProperties } from './usePageProperties';
import '../i18n/register';

export interface PropertiesPanelProps {
  pageId: string;
  space: string;
  /** The caller may edit this page (space role capped by the page's own role). The server's own `canEdit` must agree. */
  canEdit: boolean;
  /** Space admin: may keep a new key's type in the space (`.folio/properties.json`). */
  canManageTypes: boolean;
}

/** `labels:` is Obsidian's synonym of `tags:`; Folio reads it and never writes it. */
const SYNONYM_KEYS = ['labels'];

/**
 * The front matter of a document, above its body: collapsed to one line ("Properties (3)")
 * by default, the open state remembered per space. Rows are typed editors (text, number,
 * checkbox, date, list / tags / aliases as chips); a value Folio would not write itself shows
 * read-only with a "foreign value" badge, `id` is read-only, nested values are shown as JSON.
 *
 * Saving is optimistic and whole-map: every committed field (Enter or leaving it; Esc puts
 * the old value back) sends ONE PUT carrying all the editable properties (usePageProperties).
 * A 409 — the front matter changed under the editor — stops editing and offers a reload.
 */
export function PropertiesPanel({ pageId, space, canEdit, canManageTypes }: PropertiesPanelProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useLocalStorage<boolean>(`folio:properties-open:${space}`, false);
  const state = usePageProperties(pageId, space);
  const [draft, setDraft] = useState<NewProperty | null>(null);
  const [adding, setAdding] = useState(false);

  const data = state.data;
  const readOnlyKeys = useMemo(() => data?.readOnly ?? ['id'], [data]);
  const editable = canEdit && data?.canEdit !== false && !state.conflict;

  const saveTypes = useMutation({
    mutationFn: async (property: NewProperty) => {
      // The PUT replaces the whole file: send the merged view (Obsidian's defaults included) plus the new key.
      const current = await api.getSpacePropertyTypes(space);
      return api.updateSpacePropertyTypes(space, { types: { ...current.types, [property.key]: property.type } });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['property-types', space] });
      showToast(t('properties.typeSaved'), 'info');
    },
    onError: (err) => showToast(errorText(err, 'properties.typeSaveFailed')),
  });

  if (!data) return null;

  const keys = Object.keys(state.properties);
  const count = countProperties(state.properties, readOnlyKeys);
  // A viewer of a page without properties has nothing to look at, and nothing to add.
  if (!canEdit && count === 0 && !readOnlyKeys.some((key) => key in state.properties)) return null;

  const visibleKeys = keys.filter((key) => !readOnlyKeys.includes(key));
  const lockedKeys = keys.filter((key) => readOnlyKeys.includes(key));
  const rowKeys = draft && !(draft.key in state.properties) ? [...visibleKeys, draft.key] : visibleKeys;
  const bodyId = `properties-${pageId}`;

  async function handleCommit(key: string, value: unknown) {
    const next = { ...state.properties, [key]: value };
    const pending = draft && draft.key === key ? draft : null;
    if (pending) setDraft(null);
    const ok = await state.commit(next);
    if (ok && pending?.saveType) saveTypes.mutate(pending);
  }

  function handleRemove(key: string) {
    const next = { ...state.properties };
    delete next[key];
    void state.commit(next);
  }

  function handleAdd(property: NewProperty) {
    setAdding(false);
    setDraft(property);
  }

  return (
    <section aria-label={t('properties.label')} className="ph-mask shrink-0 border-b border-neutral-200 dark:border-neutral-800">
      <div className="mx-auto w-full max-w-[72ch] px-6">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-1 rounded py-1.5 text-xs font-medium text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          <ChevronRight size={13} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
          {t('properties.title', { n: count })}
        </button>

        {open && (
          <div id={bodyId} className="max-h-[45vh] overflow-y-auto pb-2">
            {state.conflict && (
              <div role="alert" className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <TriangleAlert size={14} className="shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">{t('properties.conflict')}</span>
                <button
                  type="button"
                  onClick={() => void state.reload()}
                  className="rounded-md bg-amber-200/70 px-2.5 py-1 text-sm font-medium hover:bg-amber-200 dark:bg-amber-900/60 dark:hover:bg-amber-900"
                >
                  {t('properties.reload')}
                </button>
              </div>
            )}

            {/* One keyed list for stored rows and the row being added: the new row keeps its place (and the caret) once its first value is saved. */}
            {rowKeys.map((key) => (
              <PropertyRow
                key={key}
                name={key}
                value={key in state.properties ? state.properties[key] : emptyValueFor(draft?.type ?? 'text')}
                type={key in state.properties ? effectiveType(key, state.properties[key], data.types) : (draft?.type ?? 'text')}
                foreign={data.foreign.includes(key)}
                locked={SYNONYM_KEYS.includes(key)}
                canEdit={editable}
                draft={!(key in state.properties)}
                onCommit={(k, v) => void handleCommit(k, v)}
                onRemove={handleRemove}
                onCancelDraft={() => setDraft(null)}
              />
            ))}

            {visibleKeys.length === 0 && !draft && <p className="px-1.5 py-1 text-sm text-neutral-400">{t('properties.empty')}</p>}

            {lockedKeys.map((key) => (
              <PropertyRow
                key={key}
                name={key}
                value={state.properties[key]}
                type={effectiveType(key, state.properties[key], data.types)}
                locked
                canEdit={false}
                onCommit={() => undefined}
                onRemove={() => undefined}
                onCancelDraft={() => undefined}
              />
            ))}

            {editable &&
              (adding ? (
                <AddPropertyForm
                  space={space}
                  existingKeys={keys}
                  canManageTypes={canManageTypes}
                  onAdd={handleAdd}
                  onClose={() => setAdding(false)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="mt-1 flex items-center gap-1.5 rounded px-1.5 py-1 text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                >
                  <Plus size={13} aria-hidden="true" />
                  {t('properties.add')}
                </button>
              ))}
          </div>
        )}
      </div>
    </section>
  );
}
