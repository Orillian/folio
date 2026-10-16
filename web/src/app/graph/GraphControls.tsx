import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Plus, RotateCcw, X } from 'lucide-react';
import { PALETTE, type ColorBy, type GraphSettings } from './graphModel';
import '../i18n/register';

export interface GraphControlsProps {
  settings: GraphSettings;
  onChange: (patch: Partial<GraphSettings> | 'reset') => void;
  /** The local graph: depth and direction are offered. */
  local: boolean;
  onClose: () => void;
}

function Section({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="border-b border-neutral-200 py-1.5 last:border-b-0 dark:border-neutral-800">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-xs font-semibold text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        {title}
      </button>
      {open && <div className="flex flex-col gap-2 px-1 pb-1 pt-1.5">{children}</div>}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label title={hint} className="flex cursor-pointer items-center justify-between gap-2 text-xs text-neutral-700 dark:text-neutral-300">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5 accent-indigo-600" />
    </label>
  );
}

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-0.5 text-xs text-neutral-700 dark:text-neutral-300">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="tabular-nums text-neutral-400">{Number.isInteger(step) ? value : value.toFixed(step < 0.1 ? 2 : 1)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-indigo-600" />
    </label>
  );
}

const inputClass =
  'w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-800 placeholder:text-neutral-400 focus:border-indigo-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100';

/** Obsidian-like settings panel: filters, groups, display, forces; compact, everything remembered per space. */
export function GraphControls({ settings, onChange, local, onClose }: GraphControlsProps) {
  const { t } = useTranslation('app');
  const s = settings;
  const setGroup = (i: number, patch: Partial<{ query: string; color: string }>) =>
    onChange({ groups: s.groups.map((g, j) => (j === i ? { ...g, ...patch } : g)) });

  return (
    <div className="flex max-h-full flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white/95 shadow-lg backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/95">
      <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
        <span className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">{t('graph.settings')}</span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => onChange('reset')}
            title={t('graph.reset')}
            aria-label={t('graph.reset')}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <RotateCcw size={13} />
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t('ui.close')}
            aria-label={t('ui.close')}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <X size={13} />
          </button>
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto px-2">
        {local && (
          <Section title={t('graph.local.title')} defaultOpen>
            <Slider label={t('graph.local.depth')} value={s.depth} min={1} max={3} step={1} onChange={(depth) => onChange({ depth })} />
            <label className="flex items-center justify-between gap-2 text-xs text-neutral-700 dark:text-neutral-300">
              <span>{t('graph.local.direction')}</span>
              <select value={s.direction} onChange={(e) => onChange({ direction: e.target.value as GraphSettings['direction'] })} className={`${inputClass} w-auto`}>
                <option value="both">{t('graph.local.both')}</option>
                <option value="out">{t('graph.local.out')}</option>
                <option value="in">{t('graph.local.in')}</option>
              </select>
            </label>
          </Section>
        )}
        <Section title={t('graph.filters.title')} defaultOpen>
          <input
            type="search"
            value={s.search}
            onChange={(e) => onChange({ search: e.target.value })}
            placeholder={t('graph.filters.search')}
            aria-label={t('graph.filters.search')}
            className={inputClass}
          />
          <p className="text-[11px] leading-snug text-neutral-400">{t('graph.filters.hint')}</p>
          <Toggle label={t('graph.filters.tags')} checked={s.showTags} onChange={(showTags) => onChange({ showTags })} />
          <Toggle label={t('graph.filters.files')} checked={s.showFiles} onChange={(showFiles) => onChange({ showFiles })} />
          <Toggle label={t('graph.filters.unresolved')} checked={s.showUnresolved} onChange={(showUnresolved) => onChange({ showUnresolved })} />
          <Toggle label={t('graph.filters.orphans')} checked={s.showOrphans} onChange={(showOrphans) => onChange({ showOrphans })} />
          <Toggle label={t('graph.filters.tree')} hint={t('graph.filters.treeHint')} checked={s.showTree} onChange={(showTree) => onChange({ showTree })} />
        </Section>
        <Section title={t('graph.groups.title')} defaultOpen>
          <label className="flex items-center justify-between gap-2 text-xs text-neutral-700 dark:text-neutral-300">
            <span>{t('graph.groups.colorBy')}</span>
            <select value={s.colorBy} onChange={(e) => onChange({ colorBy: e.target.value as ColorBy })} className={`${inputClass} w-auto`}>
              <option value="kind">{t('graph.groups.byKind')}</option>
              <option value="folder">{t('graph.groups.byFolder')}</option>
              <option value="tag">{t('graph.groups.byTag')}</option>
              <option value="none">{t('graph.groups.none')}</option>
            </select>
          </label>
          {s.groups.map((g, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="color"
                value={g.color}
                onChange={(e) => setGroup(i, { color: e.target.value })}
                aria-label={t('graph.groups.color')}
                className="h-6 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
              />
              <input value={g.query} onChange={(e) => setGroup(i, { query: e.target.value })} placeholder={t('graph.groups.query')} aria-label={t('graph.groups.query')} className={inputClass} />
              <button
                type="button"
                onClick={() => onChange({ groups: s.groups.filter((_, j) => j !== i) })}
                aria-label={t('graph.groups.remove')}
                title={t('graph.groups.remove')}
                className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {s.groups.length < 12 && (
            <button
              type="button"
              onClick={() => onChange({ groups: [...s.groups, { query: '', color: PALETTE[s.groups.length % PALETTE.length] }] })}
              className="flex items-center gap-1 self-start rounded px-1.5 py-1 text-xs text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/50"
            >
              <Plus size={12} /> {t('graph.groups.add')}
            </button>
          )}
        </Section>
        <Section title={t('graph.display.title')}>
          <Toggle label={t('graph.display.arrows')} checked={s.arrows} onChange={(arrows) => onChange({ arrows })} />
          <Toggle label={t('graph.display.sizeByDegree')} checked={s.sizeByDegree} onChange={(sizeByDegree) => onChange({ sizeByDegree })} />
          <Slider label={t('graph.display.labelZoom')} value={s.labelZoom} min={0.2} max={4} step={0.1} onChange={(labelZoom) => onChange({ labelZoom })} />
          <Slider label={t('graph.display.nodeSize')} value={s.nodeSize} min={0.4} max={3} step={0.1} onChange={(nodeSize) => onChange({ nodeSize })} />
          <Slider label={t('graph.display.linkThickness')} value={s.linkThickness} min={0.2} max={4} step={0.1} onChange={(linkThickness) => onChange({ linkThickness })} />
        </Section>
        <Section title={t('graph.forces.title')}>
          <Slider label={t('graph.forces.center')} value={s.centerForce} min={0} max={1} step={0.05} onChange={(centerForce) => onChange({ centerForce })} />
          <Slider label={t('graph.forces.repel')} value={s.repelForce} min={0} max={20} step={0.5} onChange={(repelForce) => onChange({ repelForce })} />
          <Slider label={t('graph.forces.link')} value={s.linkForce} min={0} max={1} step={0.05} onChange={(linkForce) => onChange({ linkForce })} />
          <Slider label={t('graph.forces.distance')} value={s.linkDistance} min={10} max={300} step={5} onChange={(linkDistance) => onChange({ linkDistance })} />
        </Section>
      </div>
    </div>
  );
}
