/**
 * The visual editor of a base: views (name, layout, columns, sort, group,
 * summaries, limit, card image), filters for all views and for this view
 * (and / or / not groups, conditions drawn as property · operator · value, any
 * other expression kept as text), formulas and display names, and the raw
 * YAML. Saving sends the edited config; the server writes it back into the
 * file keeping what did not change (comments, unknown keys) — one commit,
 * authored by the user. Lazy-loaded.
 */
import { createContext, useContext, useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import type { BaseConfig, BaseFilter, BaseSourceResponse, BaseView } from '@shared/bases/types';
import { KNOWN_BASE_VIEW_TYPES, SUPPORTED_BASE_VIEW_TYPES } from '@shared/bases/types';
import { FILE_OPS, FILTER_OPS, VALUELESS_OPS, fromFilterNode, toFilterNode, type FilterNode, type FilterOp, type FilterRule } from '@shared/bases/filterModel';
import { api, ApiError } from '../app/api';
import { Modal } from '../app/ui/Modal';
import { propertyChoices, propertyLabel } from './model';
import './i18n/register';

const BUILTIN_SUMMARIES = ['Average', 'Min', 'Max', 'Sum', 'Range', 'Median', 'Stddev', 'Earliest', 'Latest', 'Checked', 'Unchecked', 'Empty', 'Filled', 'Unique'];

const fieldClass =
  'rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-900 focus:border-blue-500 focus:outline-none';
const inputClass =
  'w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-900 focus:border-blue-500 focus:outline-none';
const smallButton =
  'inline-flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800 disabled:opacity-40';
const iconButton = 'rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-30 dark:hover:bg-neutral-800 dark:hover:text-neutral-100';

export interface BaseEditorProps {
  pageId: string;
  space: string;
  viewName?: string;
  initialTab: 'view' | 'yaml';
  onClose: () => void;
  /** After a save: the name of the view to show (it may have been renamed / added). */
  onSaved: (viewName?: string) => void;
}

type Tab = 'view' | 'filters' | 'properties' | 'yaml';

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{label}</span>
      {children}
      {hint && <span className="block text-xs text-neutral-500 dark:text-neutral-400">{hint}</span>}
    </label>
  );
}

/** Friendly name of a property id for the lists of the editor (the base's displayName, else the table header's name). */
const PropertyLabels = createContext<(id: string) => string>((id) => id);

/**
 * A property id as a combobox: at rest it shows the friendly name with the raw key as a muted hint (and a tooltip);
 * focused, it is the raw key you can type or pick from the list.
 */
function PropertyInput({ value, onChange, listId, label }: { value: string; onChange: (v: string) => void; listId: string; label: string }) {
  const labelOf = useContext(PropertyLabels);
  const [focused, setFocused] = useState(false);
  const friendly = value ? labelOf(value) : '';
  const differs = !!value && friendly !== value;
  const resting = differs && !focused;
  return (
    <div className="relative min-w-0 flex-1">
      <input
        list={listId}
        value={resting ? friendly : value}
        aria-label={label}
        title={differs ? value : undefined}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={`${inputClass} ${resting ? 'pr-28 text-ellipsis' : ''}`}
        spellCheck={false}
      />
      {resting && <span className="pointer-events-none absolute inset-y-0 right-2 flex max-w-[45%] items-center truncate font-mono text-[10px] text-neutral-400 dark:text-neutral-500">{value}</span>}
    </div>
  );
}

/** A property in a list of rows (summaries, display names): the friendly name, the raw key under it, muted. */
function PropertyName({ id, widthClass }: { id: string; widthClass: string }) {
  const labelOf = useContext(PropertyLabels);
  const friendly = labelOf(id);
  return (
    <span className={`flex ${widthClass} shrink-0 flex-col leading-tight`} title={id}>
      <span className="truncate text-sm">{friendly}</span>
      {friendly !== id && <span className="truncate font-mono text-[10px] text-neutral-400 dark:text-neutral-500">{id}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

function RuleEditor({ rule, onChange, listId }: { rule: FilterRule; onChange: (r: FilterRule) => void; listId: string }) {
  const { t } = useTranslation('bases');
  const fileOp = FILE_OPS.has(rule.op);
  return (
    <div className="grid flex-1 grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
      {fileOp ? (
        <span className="self-center px-1 text-xs text-neutral-500 dark:text-neutral-400">{t('filter.theFile')}</span>
      ) : (
        <PropertyInput value={rule.property} onChange={(property) => onChange({ ...rule, property })} listId={listId} label={t('filter.property')} />
      )}
      <select
        value={rule.op}
        aria-label={t('filter.operator')}
        onChange={(e) => onChange({ ...rule, op: e.target.value as FilterOp, property: FILE_OPS.has(e.target.value as FilterOp) ? rule.property : rule.property.startsWith('file.') && FILE_OPS.has(rule.op) ? '' : rule.property })}
        className={inputClass}
      >
        {FILTER_OPS.map((op) => (
          <option key={op} value={op}>
            {t(`op.${op}`)}
          </option>
        ))}
      </select>
      {VALUELESS_OPS.has(rule.op) ? (
        <span />
      ) : (
        <div className="flex gap-1">
          <input value={rule.value} aria-label={t('filter.value')} onChange={(e) => onChange({ ...rule, value: e.target.value })} className={inputClass} type={rule.valueType === 'date' ? 'date' : 'text'} />
          {!fileOp && (
            <select value={rule.valueType} aria-label={t('filter.valueType')} onChange={(e) => onChange({ ...rule, valueType: e.target.value as FilterRule['valueType'] })} className={fieldClass}>
              {(['text', 'number', 'date', 'bool'] as const).map((vt) => (
                <option key={vt} value={vt}>
                  {t(`valueType.${vt}`)}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
}

function GroupEditor({ node, onChange, onRemove, listId, depth }: { node: FilterNode & { kind: 'group' }; onChange: (n: FilterNode) => void; onRemove?: () => void; listId: string; depth: number }) {
  const { t } = useTranslation('bases');
  const setItem = (i: number, item: FilterNode) => onChange({ ...node, items: node.items.map((x, j) => (j === i ? item : x)) });
  const removeItem = (i: number) => onChange({ ...node, items: node.items.filter((_, j) => j !== i) });
  const add = (item: FilterNode) => onChange({ ...node, items: [...node.items, item] });
  return (
    <div className={`space-y-2 rounded-md ${depth > 0 ? 'border border-neutral-200 p-2 dark:border-neutral-700' : ''}`}>
      <div className="flex items-center gap-2">
        <select value={node.op} aria-label={t('filter.conjunction')} onChange={(e) => onChange({ ...node, op: e.target.value as 'and' | 'or' | 'not' })} className={fieldClass}>
          <option value="and">{t('filter.and')}</option>
          <option value="or">{t('filter.or')}</option>
          <option value="not">{t('filter.not')}</option>
        </select>
        {onRemove && (
          <button type="button" className={iconButton} onClick={onRemove} aria-label={t('filter.removeGroup')} title={t('filter.removeGroup')}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {node.items.length === 0 && <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('filter.emptyGroup')}</p>}
      {node.items.map((item, i) => (
        <div key={i} className="flex items-start gap-1">
          {item.kind === 'group' ? (
            <div className="flex-1">
              <GroupEditor node={item} onChange={(n) => setItem(i, n)} onRemove={() => removeItem(i)} listId={listId} depth={depth + 1} />
            </div>
          ) : (
            <>
              {item.kind === 'rule' ? (
                <RuleEditor rule={item.rule} onChange={(rule) => setItem(i, { kind: 'rule', rule })} listId={listId} />
              ) : (
                <input
                  value={item.text}
                  aria-label={t('filter.expression')}
                  placeholder={t('filter.expressionPlaceholder')}
                  onChange={(e) => setItem(i, { kind: 'raw', text: e.target.value })}
                  className={`${inputClass} flex-1 font-mono text-xs`}
                  spellCheck={false}
                />
              )}
              <button type="button" className={iconButton} onClick={() => removeItem(i)} aria-label={t('filter.remove')} title={t('filter.remove')}>
                <X size={14} />
              </button>
            </>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-1">
        <button type="button" className={smallButton} onClick={() => add({ kind: 'rule', rule: { property: '', op: 'is', value: '', valueType: 'text' } })}>
          <Plus size={12} aria-hidden="true" />
          {t('filter.addCondition')}
        </button>
        {depth < 3 && (
          <button type="button" className={smallButton} onClick={() => add({ kind: 'group', op: 'or', items: [] })}>
            <Plus size={12} aria-hidden="true" />
            {t('filter.addGroup')}
          </button>
        )}
        <button type="button" className={smallButton} onClick={() => add({ kind: 'raw', text: '' })}>
          <Plus size={12} aria-hidden="true" />
          {t('filter.addExpression')}
        </button>
      </div>
    </div>
  );
}

function FilterSection({ title, hint, filter, onChange, listId }: { title: string; hint: string; filter: BaseFilter | undefined; onChange: (f: BaseFilter | undefined) => void; listId: string }) {
  const [node, setNode] = useState<FilterNode>(() => toFilterNode(filter));
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>
      </div>
      <GroupEditor
        node={node as FilterNode & { kind: 'group' }}
        onChange={(n) => {
          setNode(n);
          onChange(fromFilterNode(n));
        }}
        listId={listId}
        depth={0}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// the editor
// ---------------------------------------------------------------------------

function move<T>(list: T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Blank rows the editor added and left empty are not written. */
export function cleanConfig(config: BaseConfig): BaseConfig {
  const formulas = Object.fromEntries(Object.entries(config.formulas).filter(([n, x]) => n.trim() && x.trim()));
  return {
    ...config,
    formulas,
    views: config.views.map((v) => {
      const next: BaseView = { ...v, name: v.name.trim() };
      if (v.order) next.order = v.order.map((x) => x.trim()).filter(Boolean);
      if (v.sort) {
        const sort = v.sort.filter((x) => x.property.trim());
        if (sort.length) next.sort = sort;
        else delete next.sort;
      }
      for (const k of Object.keys(next) as Array<keyof BaseView>) if (next[k] === undefined) delete next[k];
      return next;
    }),
  };
}

function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

export default function BaseEditor({ pageId, space, viewName, initialTab, onClose, onSaved }: BaseEditorProps) {
  const { t } = useTranslation('bases');
  const listId = useId();
  const source = useQuery({ queryKey: ['base-source', pageId], queryFn: () => api.getBaseSource(pageId), staleTime: 0 });
  const types = useQuery({ queryKey: ['property-types', space], queryFn: () => api.getSpacePropertyTypes(space), staleTime: 60_000 });
  const [loaded, setLoaded] = useState<BaseSourceResponse | null>(null);
  const [draft, setDraft] = useState<BaseConfig | null>(null);
  const [viewIndex, setViewIndex] = useState(0);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [yaml, setYaml] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (!source.data || loaded) return;
    setLoaded(source.data);
    setYaml(source.data.source);
    const config = source.data.config ? structuredClone(source.data.config) : null;
    if (config && config.views.length === 0) config.views.push({ type: 'table', name: t('defaultView'), order: ['file.name'] });
    setDraft(config);
    if (config) setViewIndex(Math.max(0, config.views.findIndex((v) => v.name === viewName)));
    if (!config) setTab('yaml');
  }, [source.data, loaded, viewName, t]);

  const choices = useMemo(
    () => propertyChoices(types.data?.known.map((k) => k.key) ?? [], Object.keys(draft?.formulas ?? {}), draft?.views[viewIndex]?.order ?? []),
    [types.data, draft, viewIndex],
  );

  const labelOf = useMemo(() => (id: string) => propertyLabel(id, draft?.properties, t), [draft?.properties, t]);
  const defaultLabelOf = (id: string) => propertyLabel(id, undefined, t);

  const view: BaseView | undefined = draft?.views[viewIndex];
  const setView = (patch: Partial<BaseView>) =>
    setDraft((d) => (d ? { ...d, views: d.views.map((v, i) => (i === viewIndex ? { ...v, ...patch } : v)) } : d));

  const save = async (mode: 'config' | 'yaml') => {
    if (!loaded) return;
    setSaving(true);
    setError(null);
    try {
      if (mode === 'config' && draft) {
        const names = draft.views.map((v) => v.name.trim());
        if (names.some((n) => !n)) throw new Error(t('editor.viewNameRequired'));
        if (new Set(names).size !== names.length) throw new Error(t('editor.viewNameUnique'));
      }
      await api.updateBase(pageId, mode === 'config' ? { etag: loaded.etag, config: cleanConfig(draft!) } : { etag: loaded.etag, source: yaml });
      onSaved(mode === 'config' ? draft?.views[viewIndex]?.name : undefined);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    setConflict(false);
    setLoaded(null);
    setDraft(null);
    await source.refetch();
  };

  const footer = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {error && <p className="mr-auto text-sm text-red-600 dark:text-red-400">{error}</p>}
      <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
        {t('editor.cancel')}
      </button>
      <button
        type="button"
        disabled={saving || !loaded || (tab !== 'yaml' && !draft)}
        onClick={() => void save(tab === 'yaml' ? 'yaml' : 'config')}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? t('editor.saving') : tab === 'yaml' ? t('editor.saveYaml') : t('editor.save')}
      </button>
    </div>
  );

  const tabs: Array<{ id: Tab; label: string; disabled?: boolean }> = [
    { id: 'view', label: t('editor.tabView'), disabled: !draft },
    { id: 'filters', label: t('editor.tabFilters'), disabled: !draft },
    { id: 'properties', label: t('editor.tabProperties'), disabled: !draft },
    { id: 'yaml', label: t('editor.tabYaml') },
  ];

  return (
    <Modal title={t('editor.title')} onClose={onClose} footer={footer} size="xl">
      <PropertyLabels.Provider value={labelOf}>
        <datalist id={listId}>
          {choices.map((c) => (
            <option key={c} value={c} label={labelOf(c) === c ? undefined : labelOf(c)} />
          ))}
        </datalist>
        {source.isLoading && <p className="text-sm text-neutral-500">{t('loading')}</p>}
        {conflict && (
          <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <span>{t('editor.conflict')}</span>
            <button type="button" className={smallButton} onClick={() => void reload()}>
              {t('editor.reload')}
            </button>
          </div>
        )}
        {loaded && (
          <div className="flex min-h-[24rem] flex-col gap-3 md:flex-row">
            {draft && (
              <aside className="space-y-1 md:w-48 md:shrink-0">
                <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('views')}</p>
                <ul className="flex flex-wrap gap-1 md:flex-col">
                  {draft.views.map((v, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => setViewIndex(i)}
                        aria-current={i === viewIndex}
                        className={`w-full truncate rounded-md px-2 py-1 text-left text-sm ${i === viewIndex ? 'bg-blue-50 font-medium text-blue-800 dark:bg-blue-950/50 dark:text-blue-200' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'}`}
                      >
                        {v.name || '—'}
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className={smallButton}
                  onClick={() => {
                    const name = uniqueName(t('editor.newView'), draft.views.map((v) => v.name));
                    setDraft({ ...draft, views: [...draft.views, { type: 'table', name, order: view?.order ?? ['file.name'] }] });
                    setViewIndex(draft.views.length);
                    setTab('view');
                  }}
                >
                  <Plus size={12} aria-hidden="true" />
                  {t('editor.addView')}
                </button>
              </aside>
            )}
            <div className="min-w-0 flex-1 space-y-3">
              <div role="tablist" className="flex flex-wrap gap-1 border-b border-neutral-200 dark:border-neutral-700">
                {tabs.map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === x.id}
                    disabled={x.disabled}
                    onClick={() => setTab(x.id)}
                    className={`-mb-px border-b-2 px-3 py-1.5 text-sm disabled:opacity-40 ${tab === x.id ? 'border-blue-600 font-medium text-blue-700 dark:text-blue-300' : 'border-transparent text-neutral-600 hover:text-neutral-900 dark:text-neutral-300'}`}
                  >
                    {x.label}
                  </button>
                ))}
              </div>

              {tab === 'view' && view && draft && (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t('editor.viewName')}>
                      <input value={view.name} onChange={(e) => setView({ name: e.target.value })} className={inputClass} />
                    </Field>
                    <Field
                      label={t('editor.layout')}
                      hint={(SUPPORTED_BASE_VIEW_TYPES as readonly string[]).includes(view.type) ? undefined : t('notSupportedType', { type: view.type })}
                    >
                      <select value={view.type} onChange={(e) => setView({ type: e.target.value })} className={inputClass}>
                        {[...KNOWN_BASE_VIEW_TYPES, ...((KNOWN_BASE_VIEW_TYPES as readonly string[]).includes(view.type) ? [] : [view.type])].map((type) => (
                          <option key={type} value={type}>
                            {(SUPPORTED_BASE_VIEW_TYPES as readonly string[]).includes(type) ? t(`layout.${type}`) : t('layout.unsupported', { type: t(`layout.${type}`, { defaultValue: type }) })}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>

                  <section className="space-y-2">
                    <h3 className="text-sm font-medium">{t('editor.columns')}</h3>
                    <ol className="space-y-1">
                      {(view.order ?? []).map((id, i, all) => (
                        <li key={`${id}-${i}`} className="flex items-center gap-1">
                          <PropertyInput value={id} listId={listId} label={t('editor.column')} onChange={(v) => setView({ order: all.map((x, j) => (j === i ? v : x)) })} />
                          <button type="button" className={iconButton} disabled={i === 0} onClick={() => setView({ order: move(all, i, -1) })} aria-label={t('editor.moveUp')}>
                            <ArrowUp size={14} />
                          </button>
                          <button type="button" className={iconButton} disabled={i === all.length - 1} onClick={() => setView({ order: move(all, i, 1) })} aria-label={t('editor.moveDown')}>
                            <ArrowDown size={14} />
                          </button>
                          <button type="button" className={iconButton} onClick={() => setView({ order: all.filter((_, j) => j !== i) })} aria-label={t('editor.remove')}>
                            <X size={14} />
                          </button>
                        </li>
                      ))}
                    </ol>
                    <button type="button" className={smallButton} onClick={() => setView({ order: [...(view.order ?? []), ''] })}>
                      <Plus size={12} aria-hidden="true" />
                      {t('editor.addColumn')}
                    </button>
                  </section>

                  <section className="space-y-2">
                    <h3 className="text-sm font-medium">{t('editor.sort')}</h3>
                    {(view.sort ?? []).map((s, i, all) => (
                      <div key={i} className="flex items-center gap-1">
                        <PropertyInput value={s.property} listId={listId} label={t('editor.sortProperty')} onChange={(v) => setView({ sort: all.map((x, j) => (j === i ? { ...x, property: v } : x)) })} />
                        <select value={s.direction} aria-label={t('editor.direction')} onChange={(e) => setView({ sort: all.map((x, j) => (j === i ? { ...x, direction: e.target.value as 'ASC' | 'DESC' } : x)) })} className={fieldClass}>
                          <option value="ASC">{t('editor.asc')}</option>
                          <option value="DESC">{t('editor.desc')}</option>
                        </select>
                        <button type="button" className={iconButton} onClick={() => setView({ sort: all.filter((_, j) => j !== i) })} aria-label={t('editor.remove')}>
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                    <button type="button" className={smallButton} onClick={() => setView({ sort: [...(view.sort ?? []), { property: '', direction: 'ASC' }] })}>
                      <Plus size={12} aria-hidden="true" />
                      {t('editor.addSort')}
                    </button>
                  </section>

                  <section className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
                    <Field label={t('editor.groupBy')} hint={t('editor.groupHint')}>
                      <PropertyInput
                        value={view.groupBy?.property ?? ''}
                        listId={listId}
                        label={t('editor.groupBy')}
                        onChange={(v) => setView({ groupBy: v.trim() ? { property: v, direction: view.groupBy?.direction ?? 'ASC' } : undefined })}
                      />
                    </Field>
                    <Field label={t('editor.direction')}>
                      <select value={view.groupBy?.direction ?? 'ASC'} disabled={!view.groupBy} onChange={(e) => view.groupBy && setView({ groupBy: { ...view.groupBy, direction: e.target.value as 'ASC' | 'DESC' } })} className={inputClass}>
                        <option value="ASC">{t('editor.asc')}</option>
                        <option value="DESC">{t('editor.desc')}</option>
                      </select>
                    </Field>
                    <Field label={t('editor.limit')}>
                      <input
                        type="number"
                        min={1}
                        value={view.limit ?? ''}
                        onChange={(e) => setView({ limit: e.target.value === '' ? undefined : Math.max(1, Math.floor(Number(e.target.value))) })}
                        className={inputClass}
                      />
                    </Field>
                  </section>

                  {view.type === 'cards' && (
                    <Field label={t('editor.image')} hint={t('editor.imageHint')}>
                      <PropertyInput value={typeof view.image === 'string' ? view.image : ''} listId={listId} label={t('editor.image')} onChange={(v) => setView({ image: v.trim() ? v : undefined })} />
                    </Field>
                  )}

                  <section className="space-y-2">
                    <h3 className="text-sm font-medium">{t('editor.summaries')}</h3>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {(view.order ?? []).filter(Boolean).map((id) => (
                        <label key={id} className="flex items-center gap-2 text-sm">
                          <PropertyName id={id} widthClass="w-40" />
                          <select
                            value={view.summaries?.[id] ?? ''}
                            onChange={(e) => {
                              const next = { ...(view.summaries ?? {}) };
                              if (e.target.value) next[id] = e.target.value;
                              else delete next[id];
                              setView({ summaries: Object.keys(next).length ? next : undefined });
                            }}
                            className={inputClass}
                          >
                            <option value="">{t('editor.noSummary')}</option>
                            {[...BUILTIN_SUMMARIES, ...Object.keys(draft.summaries)].map((s) => (
                              <option key={s} value={s}>
                                {BUILTIN_SUMMARIES.includes(s) ? t(`summary.${s}`) : s}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>
                  </section>

                  {draft.views.length > 1 && (
                    <button
                      type="button"
                      className={`${smallButton} text-red-700 dark:text-red-300`}
                      onClick={() => {
                        setDraft({ ...draft, views: draft.views.filter((_, i) => i !== viewIndex) });
                        setViewIndex(0);
                      }}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                      {t('editor.deleteView')}
                    </button>
                  )}
                </div>
              )}

              {tab === 'filters' && draft && view && (
                <div key={viewIndex} className="space-y-5">
                  <FilterSection title={t('editor.filtersAll')} hint={t('editor.filtersAllHint')} filter={draft.filters} onChange={(f) => setDraft((d) => (d ? { ...d, filters: f } : d))} listId={listId} />
                  <FilterSection title={t('editor.filtersView', { name: view.name })} hint={t('editor.filtersViewHint')} filter={view.filters} onChange={(f) => setView({ filters: f })} listId={listId} />
                </div>
              )}

              {tab === 'properties' && draft && view && (
                <div className="space-y-5">
                  <section className="space-y-2">
                    <h3 className="text-sm font-medium">{t('editor.displayNames')}</h3>
                    {(view.order ?? []).filter(Boolean).map((id) => (
                      <label key={id} className="flex items-center gap-2 text-sm">
                        <PropertyName id={id} widthClass="w-48" />
                        <input
                          value={typeof draft.properties[id]?.displayName === 'string' ? (draft.properties[id].displayName as string) : ''}
                          placeholder={defaultLabelOf(id)}
                          onChange={(e) => {
                            const properties = { ...draft.properties };
                            const rest = { ...(properties[id] ?? {}) };
                            if (e.target.value) rest.displayName = e.target.value;
                            else delete rest.displayName;
                            if (Object.keys(rest).length) properties[id] = rest;
                            else delete properties[id];
                            setDraft({ ...draft, properties });
                          }}
                          className={inputClass}
                        />
                      </label>
                    ))}
                  </section>
                  <section className="space-y-2">
                    <h3 className="text-sm font-medium">{t('editor.formulas')}</h3>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('editor.formulasHint')}</p>
                    {Object.entries(draft.formulas).map(([name, expr], i) => (
                      <div key={i} className="flex flex-col gap-1 sm:flex-row sm:items-center">
                        <input
                          value={name}
                          aria-label={t('editor.formulaName')}
                          onChange={(e) => {
                            const entries = Object.entries(draft.formulas).map(([n, x], j) => (j === i ? [e.target.value, x] : [n, x]));
                            setDraft({ ...draft, formulas: Object.fromEntries(entries) });
                          }}
                          className={`${inputClass} sm:w-40`}
                        />
                        <input
                          value={expr}
                          aria-label={t('editor.formulaExpression')}
                          onChange={(e) => setDraft({ ...draft, formulas: { ...draft.formulas, [name]: e.target.value } })}
                          className={`${inputClass} flex-1 font-mono text-xs`}
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className={iconButton}
                          aria-label={t('editor.remove')}
                          onClick={() => {
                            const formulas = { ...draft.formulas };
                            delete formulas[name];
                            setDraft({ ...draft, formulas });
                          }}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className={smallButton}
                      onClick={() => setDraft({ ...draft, formulas: { ...draft.formulas, [uniqueName('formula', Object.keys(draft.formulas))]: '' } })}
                    >
                      <Plus size={12} aria-hidden="true" />
                      {t('editor.addFormula')}
                    </button>
                  </section>
                </div>
              )}

              {tab === 'yaml' && (
                <div className="space-y-2">
                  {loaded.error && (
                    <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                      {loaded.error.message}
                      {loaded.error.line ? ` (${t('error.line', { line: loaded.error.line })})` : ''}
                    </p>
                  )}
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('editor.yamlHint')}</p>
                  <textarea
                    value={yaml}
                    onChange={(e) => setYaml(e.target.value)}
                    aria-label={t('editor.tabYaml')}
                    spellCheck={false}
                    rows={20}
                    className={`${inputClass} font-mono text-xs leading-5`}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </PropertyLabels.Provider>
    </Modal>
  );
}
