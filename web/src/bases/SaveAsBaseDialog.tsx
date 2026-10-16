/**
 * "Save as base" from a search: the query's filters (tag:, kind:, status:,
 * in:, prop:) become a new `.base` page's filters in Obsidian syntax
 * (shared/bases/fromSearch.ts); its words cannot be (a base filters by
 * properties, not by text) and the dialog says so. One create = one commit.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { parseSearchQuery } from '@shared/searchQuery';
import { baseConfigFromSearch } from '@shared/bases/fromSearch';
import { serializeBaseConfig } from '@shared/bases/writer';
import { api } from '../app/api';
import { Modal } from '../app/ui/Modal';
import './i18n/register';

export interface SaveAsBaseDialogProps {
  query: string;
  space: string;
  onClose: () => void;
  /** After the base is created (the caller closes what opened the dialog). */
  onCreated?: () => void;
}

export default function SaveAsBaseDialog({ query, space, onClose, onCreated }: SaveAsBaseDialogProps) {
  const { t } = useTranslation('bases');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ast = useMemo(() => parseSearchQuery(query), [query]);
  const [name, setName] = useState(() => [...ast.words, ...ast.tags].join(' ').slice(0, 80) || t('saveAs.defaultName'));
  const [folder, setFolder] = useState(ast.pathPrefixes.length === 1 ? ast.pathPrefixes[0].replace(/\/+$/, '') : '');
  const { config, dropped } = useMemo(() => baseConfigFromSearch(ast, t('defaultView')), [ast, t]);
  const source = useMemo(() => serializeBaseConfig(config), [config]);
  const create = useMutation({
    mutationFn: () => api.createPage({ space, parentPath: folder.trim().replace(/^\/+|\/+$/g, ''), title: name.trim(), kind: 'base', base: source }),
    onSuccess: (page) => {
      void queryClient.invalidateQueries({ queryKey: ['tree', space] });
      onClose();
      onCreated?.();
      navigate(`/s/${space}/p/${page.id}`);
    },
  });
  return (
    <Modal
      title={t('saveAs.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
            {t('editor.cancel')}
          </button>
          <button
            type="button"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {create.isPending ? t('saveAs.creating') : t('saveAs.create')}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <code className="block truncate rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300" title={query}>
          {query}
        </code>
        <label className="flex flex-col gap-1">
          <span className="text-neutral-600 dark:text-neutral-400">{t('saveAs.name')}</span>
          <input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className="rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-600 dark:bg-neutral-900" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-neutral-600 dark:text-neutral-400">{t('saveAs.folder')}</span>
          <input value={folder} onChange={(e) => setFolder(e.target.value)} className="rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-600 dark:bg-neutral-900" />
          <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('saveAs.folderHint')}</span>
        </label>
        {config.filters === undefined && <p className="text-xs text-amber-700 dark:text-amber-300">{t('saveAs.nothing')}</p>}
        {dropped.length > 0 && <p className="text-xs text-amber-700 dark:text-amber-300">{t('saveAs.dropped', { parts: dropped.join(', ') })}</p>}
        <pre className="max-h-48 overflow-auto rounded bg-neutral-50 p-2 font-mono text-xs dark:bg-neutral-800/60">{source}</pre>
        {create.isError && <p className="text-xs text-red-600 dark:text-red-400">{create.error instanceof Error ? create.error.message : String(create.error)}</p>}
      </div>
    </Modal>
  );
}
