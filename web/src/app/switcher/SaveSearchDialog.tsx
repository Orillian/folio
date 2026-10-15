import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import '../i18n/register';

export interface SaveSearchDialogProps {
  /** The query as typed (operators included). */
  query: string;
  /** Where the search runs: a space slug, or '' for every space. */
  space: string;
  onClose: () => void;
  onSaved: () => void;
}

/** "Save this search": a name for the query, and whether it stays pinned to the space it was run in. */
export function SaveSearchDialog({ query, space, onClose, onSaved }: SaveSearchDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(query.slice(0, 80));
  const [pinned, setPinned] = useState(space !== '');

  const trimmed = name.trim();

  const save = useMutation({
    mutationFn: () => api.createSavedSearch({ name: trimmed, query, space: pinned && space !== '' ? space : null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['saved-searches'] });
      showToast(t('search.saved.saved'), 'info');
      onSaved();
    },
    onError: (err) => showToast(errorText(err, 'search.saved.saveFailed')),
  });

  function submit() {
    if (!trimmed || save.isPending) return;
    save.mutate();
  }

  return (
    <Modal
      title={t('search.saved.dialogTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
            {t('ui.cancel')}
          </button>
          <button
            type="button"
            disabled={!trimmed || save.isPending}
            onClick={submit}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {save.isPending ? t('ui.pleaseWait') : t('search.saved.saveAction')}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <code className="block truncate rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300" title={query}>
          {query}
        </code>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">{t('search.saved.nameLabel')}</span>
          <input
            autoFocus
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:text-neutral-100"
          />
        </label>
        {space !== '' && (
          <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            {t('search.saved.onlyThisSpace', { space })}
          </label>
        )}
      </div>
    </Modal>
  );
}
