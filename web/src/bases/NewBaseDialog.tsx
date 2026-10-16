/**
 * "New base": a small dialog instead of a blind create. The owner clicked
 * "New base" on prod, nothing seemed to happen, a second click made a second
 * base — and neither was visible, because the page it was created under was
 * collapsed in the tree. So: a name and an explicit location, a spinner and a
 * disabled button while the request runs (one request, however often the
 * button is pressed), and after the create the tree is refreshed, the new row
 * revealed and selected, the base opened with its "Configure" editor.
 */
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Database, Folder, Loader2, Search } from 'lucide-react';
import type { PageMeta } from '@shared/contracts';
import { quoteString } from '@shared/bases/expr';
import type { BaseConfig } from '@shared/bases/types';
import { serializeBaseConfig } from '@shared/bases/writer';
import { api } from '../app/api';
import { useApiErrorText } from '../app/errorText';
import { isValidFileName, normalizeFileName } from '../app/sidebar/slugUtils';
import { requestTreeReveal } from '../app/sidebar/treeReveal';
import { Modal } from '../app/ui/Modal';
import { useToast } from '../app/ui/Toast';
import { collectBaseLocations, locationLabel } from './baseLocations';
import './i18n/register';

/** Route state the base page reads to open its "Configure" editor right after creation. */
export interface ConfigureBaseState {
  folioConfigureBase: string;
}

export interface NewBaseDialogProps {
  space: string;
  /** The directory the base is created in unless the user picks another ("" = space root). */
  initialParentPath: string;
  onClose: () => void;
  /** After the base exists and is opened (a caller that opened the dialog from a popup closes it here). */
  onCreated?: (page: PageMeta) => void;
}

/** The first view of a new base: a table of name, folder, tags and last-updated, newest first, limited to `folder` when given. */
export function starterBaseSource(folder: string, viewName: string): string {
  const config: BaseConfig = {
    ...(folder ? { filters: { and: [`file.inFolder(${quoteString(folder)})`] } } : {}),
    formulas: {},
    properties: {},
    summaries: {},
    views: [{ type: 'table', name: viewName, order: ['file.name', 'file.folder', 'file.tags', 'file.mtime'], sort: [{ property: 'file.mtime', direction: 'DESC' }] }],
  };
  return serializeBaseConfig(config);
}

export default function NewBaseDialog({ space, initialParentPath, onClose, onCreated }: NewBaseDialogProps) {
  const { t } = useTranslation('bases');
  const errorText = useApiErrorText();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [name, setName] = useState(() => t('new.defaultName'));
  const [dir, setDir] = useState(initialParentPath);
  const [scoped, setScoped] = useState(true);
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState('');
  // A second press (click, Enter) before the first request answers must not send a second request:
  // the mutation's own `isPending` only reaches the DOM on the next render.
  const submitting = useRef(false);

  const tree = useQuery({ queryKey: ['tree', space], queryFn: () => api.getTree(space) });
  const rootLabel = t('new.rootLabel');
  const locations = useMemo(() => collectBaseLocations(tree.data, rootLabel), [tree.data, rootLabel]);
  const currentLabel = locationLabel(locations, dir, rootLabel);
  const shown = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return needle ? locations.filter((l) => l.label.toLocaleLowerCase().includes(needle) || l.dir.toLocaleLowerCase().includes(needle)) : locations;
  }, [locations, filter]);

  const nameValid = isValidFileName(name, 'base');
  const limitToFolder = scoped && dir !== '';

  const create = useMutation({
    mutationFn: () => api.createPage({ space, parentPath: dir, title: normalizeFileName(name, 'base'), kind: 'base', base: starterBaseSource(limitToFolder ? dir : '', t('defaultView')) }),
    onSuccess: (page) => {
      void queryClient.invalidateQueries({ queryKey: ['tree', space] });
      requestTreeReveal(space, page.id);
      showToast(t('new.created', { location: currentLabel }), 'info');
      navigate(`/s/${space}/p/${page.id}`, { state: { folioConfigureBase: page.id } satisfies ConfigureBaseState });
      onCreated?.(page);
      onClose();
    },
    onSettled: () => {
      submitting.current = false;
    },
  });

  function submit() {
    if (submitting.current || create.isPending || !nameValid) return;
    submitting.current = true;
    create.mutate();
  }

  return (
    <Modal
      title={t('new.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
            {t('editor.cancel')}
          </button>
          <button
            type="submit"
            form="new-base-form"
            disabled={!nameValid || create.isPending}
            aria-busy={create.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {create.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {create.isPending ? t('new.creating') : t('new.create')}
          </button>
        </>
      }
    >
      <form
        id="new-base-form"
        className="flex flex-col gap-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="new-base-name" className="text-neutral-600 dark:text-neutral-400">
            {t('new.name')}
          </label>
          <input
            id="new-base-name"
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            value={name}
            maxLength={120}
            disabled={create.isPending}
            aria-invalid={!nameValid}
            aria-describedby="new-base-name-hint"
            onChange={(e) => setName(e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-600 dark:bg-neutral-900"
          />
          <span id="new-base-name-hint" className={`text-xs ${nameValid ? 'text-neutral-500 dark:text-neutral-400' : 'text-red-600 dark:text-red-400'}`}>
            {nameValid ? t('new.nameHint') : t('new.nameInvalid')}
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-neutral-600 dark:text-neutral-400">{t('new.location')}</span>
          <button
            type="button"
            aria-expanded={picking}
            disabled={create.isPending}
            onClick={() => setPicking((v) => !v)}
            className="flex items-center gap-2 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-left hover:bg-neutral-50 dark:border-neutral-600 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          >
            <Folder size={14} className="shrink-0 opacity-60" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{currentLabel}</span>
              {dir !== '' && <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">{dir}</span>}
            </span>
            <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-neutral-500">
              {t('new.change')}
              {picking ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
            </span>
          </button>
          {picking && (
            <div className="rounded-md border border-neutral-200 dark:border-neutral-700">
              <label className="flex items-center gap-2 border-b border-neutral-200 px-2 py-1 dark:border-neutral-700">
                <Search size={13} className="shrink-0 opacity-50" aria-hidden="true" />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t('new.searchLocations')}
                  aria-label={t('new.searchLocations')}
                  className="min-w-0 flex-1 bg-transparent outline-none"
                />
              </label>
              <div className="max-h-48 overflow-y-auto" role="listbox" aria-label={t('new.location')}>
                {shown.length === 0 && <p className="px-2.5 py-2 text-xs text-neutral-500">{t('new.noLocations')}</p>}
                {shown.map((l) => (
                  <button
                    key={l.dir || '.'}
                    type="button"
                    role="option"
                    aria-selected={l.dir === dir}
                    onClick={() => {
                      setDir(l.dir);
                      setPicking(false);
                      setFilter('');
                    }}
                    style={{ paddingLeft: `${10 + (filter ? 0 : l.depth) * 14}px` }}
                    className={`flex w-full items-center gap-2 border-b border-neutral-100 px-2.5 py-1.5 text-left last:border-b-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800 ${
                      l.dir === dir ? 'bg-neutral-100 font-medium dark:bg-neutral-800' : ''
                    }`}
                  >
                    <Folder size={14} className="shrink-0 opacity-60" aria-hidden="true" />
                    <span className="truncate">{l.label}</span>
                    {l.dir !== '' && <span className="ml-auto max-w-[45%] shrink-0 truncate text-xs text-neutral-500 dark:text-neutral-400">{l.dir}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <fieldset className="flex flex-col gap-1.5" disabled={create.isPending}>
          <legend className="mb-1 text-neutral-600 dark:text-neutral-400">{t('new.startingPoint')}</legend>
          {dir === '' ? (
            <p className="flex items-start gap-2 text-neutral-700 dark:text-neutral-300">
              <Database size={14} className="mt-0.5 shrink-0 opacity-60" aria-hidden="true" />
              {t('new.scopeRoot')}
            </p>
          ) : (
            <>
              <label className="flex items-start gap-2">
                <input type="radio" name="new-base-scope" checked={scoped} onChange={() => setScoped(true)} className="mt-1" />
                <span>{t('new.scopeFolder', { location: currentLabel })}</span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="new-base-scope" checked={!scoped} onChange={() => setScoped(false)} className="mt-1" />
                <span>{t('new.scopeAll')}</span>
              </label>
            </>
          )}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('new.viewHint')}</p>
        </fieldset>

        {create.isError && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {errorText(create.error, 'sidebar.createPageFailed')}
          </p>
        )}
      </form>
    </Modal>
  );
}
