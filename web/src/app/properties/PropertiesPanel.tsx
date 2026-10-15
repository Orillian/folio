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
/** The open state of the panel, remembered per space; the toggle and the body share it. */
export function usePropertiesOpen(space: string) {
  return useLocalStorage<boolean>(`folio:properties-open:${space}`, false);
}

/** What both halves need: the loaded front matter, the count, and whether there is anything to show at all. */
function useView(pageId: string, space: string, canEdit: boolean) {
  const state = usePageProperties(pageId, space);
  const data = state.data;
  const readOnlyKeys = useMemo(() => data?.readOnly ?? ['id'], [data]);
  if (!data) return { state, data, readOnlyKeys, count: 0, visible: false };
  const count = countProperties(state.properties, readOnlyKeys);
  // A viewer of a page without properties has nothing to look at, and nothing to add.
  const visible = canEdit || count > 0 || readOnlyKeys.some((key) => key in state.properties);
  return { state, data, readOnlyKeys, count, visible };
}

export interface PropertiesHalfProps extends PropertiesPanelProps {
  open: boolean;
  /**
   * 'column' (default): centred like the editor's text column (a document). 'plain': left-aligned in whatever
   * the caller wraps it in (PagePropertiesBar — tables, forms, boards, files).
   */
  layout?: 'column' | 'plain';
}

export function propertiesBodyId(pageId: string): string {
  return `properties-${pageId}`;
}

/** The "Properties (3)" toggle: small enough to ride in the editor's chrome row. */
export function PropertiesToggle({ pageId, space, canEdit, open, onToggle }: Omit<PropertiesHalfProps, 'canManageTypes'> & { onToggle: () => void }) {
  const { t } = useTranslation('app');
  const { count, visible } = useView(pageId, space, canEdit);
  if (!visible) return null;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={propertiesBodyId(pageId)}
      onClick={onToggle}
      className="ph-mask flex min-w-0 max-w-full items-center gap-1 rounded py-1 text-xs font-medium text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
    >
      <ChevronRight size={13} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
      <span className="truncate">{t('properties.title', { n: count })}</span>
    </button>
  );
}

/** The editors, shown under the chrome row while the toggle is open. */
export function PropertiesBody({ pageId, space, canEdit, canManageTypes, open, layout = 'column' }: PropertiesHalfProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const { state, data, visible } = useView(pageId, space, canEdit);
  const [draft, setDraft] = useState<NewProperty | null>(null);
  const [adding, setAdding] = useState(false);

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

  if (!data || !visible || !open) return null;

  const readOnlyKeys = data.readOnly;
  const keys = Object.keys(state.properties);
  const visibleKeys = keys.filter((key) => !readOnlyKeys.includes(key));
  const lockedKeys = keys.filter((key) => readOnlyKeys.includes(key));
  const rowKeys = draft && !(draft.key in state.properties) ? [...visibleKeys, draft.key] : visibleKeys;

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
    <section aria-label={t('properties.label')} className="ph-mask shrink-0">
      <div className={layout === 'plain' ? 'max-w-3xl' : 'folio-props-body'}>
        <div id={propertiesBodyId(pageId)} className="max-h-[45vh] overflow-y-auto pb-2">
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
      </div>
    </section>
  );
}

/**
 * Toggle and body for a page without the document editor's chrome row — a data table, a form, a board, a PDF or
 * an Office file (15.10.2026): a thin row above the page's own surface, the toggle at its top left, the open body
 * under it, left-aligned with the surface (`className` carries the caller's horizontal padding). Collapsed,
 * it costs one short line; a viewer of a page without properties sees nothing at all.
 *
 * Who may edit (owner's rule: reading is reading): these pages have no reading / editing modes of their own —
 * the table, the board and the file viewer are the same surface for every role — so the properties are editable
 * exactly for the people who may edit the page (`canEdit`, the page role, as for the page itself), read-only
 * for everyone else. A form's "Edit form" dialog changes the definition, not the page's metadata, so it is not
 * a mode either.
 */
export function PagePropertiesBar({ className = 'px-4', ...props }: PropertiesPanelProps & { className?: string }) {
  const [open, setOpen] = usePropertiesOpen(props.space);
  return (
    <div className={`shrink-0 ${className}`} data-page-properties="">
      <PropertiesToggle pageId={props.pageId} space={props.space} canEdit={props.canEdit} open={open} onToggle={() => setOpen((v) => !v)} />
      <PropertiesBody {...props} open={open} layout="plain" />
    </div>
  );
}

/** Toggle and body together (the standalone layout; PageContent splits them across the editor's chrome). */
export function PropertiesPanel(props: PropertiesPanelProps) {
  const [open, setOpen] = usePropertiesOpen(props.space);
  return (
    <>
      <PropertiesToggle pageId={props.pageId} space={props.space} canEdit={props.canEdit} open={open} onToggle={() => setOpen((v) => !v)} />
      <PropertiesBody {...props} open={open} />
    </>
  );
}
