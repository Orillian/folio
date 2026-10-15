import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { normalizeTagInput } from '../properties/propertyValues';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import '../i18n/register';

export interface RenameTagDialogProps {
  space: string;
  /** The normalized tag being renamed (`project/alpha`); its sub-tags follow. */
  tag: string;
  onClose: () => void;
}

/**
 * "Rename tag…": one POST that rewrites `#tag` (and `#tag/…`) in page text and in the `tags:`
 * front matter of every page the caller may edit, in a single commit. The answer says how many
 * pages changed and how many were skipped (no edit access), which the toast reports.
 */
export function RenameTagDialog({ space, tag, onClose }: RenameTagDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(tag);

  const target = normalizeTagInput(value);
  const valid = target !== null;
  const unchanged = target === tag;

  const rename = useMutation({
    mutationFn: () => api.renameTag(space, { from: tag, to: target ?? '' }),
    onSuccess: (result) => {
      // Bodies and front matter changed on many pages: the tag list, the tree (titles), search hits and any open page's properties are stale.
      void queryClient.invalidateQueries({ queryKey: ['space-tags', space] });
      void queryClient.invalidateQueries({ queryKey: ['tree', space] });
      void queryClient.invalidateQueries({ queryKey: ['search'] });
      void queryClient.invalidateQueries({ queryKey: ['page'] });
      void queryClient.invalidateQueries({ queryKey: ['page-properties'] });
      const changed = result?.pagesChanged ?? 0;
      const skipped = result?.pagesSkipped ?? 0;
      showToast(t(skipped > 0 ? 'tags.rename.doneSkipped' : 'tags.rename.done', { changed, skipped }), 'info');
      onClose();
    },
    onError: (err) => showToast(errorText(err, 'tags.rename.failed')),
  });

  function submit() {
    if (!valid || unchanged || rename.isPending) return;
    rename.mutate();
  }

  return (
    <Modal
      title={t('tags.rename.title', { tag })}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
            {t('ui.cancel')}
          </button>
          <button
            type="button"
            disabled={!valid || unchanged || rename.isPending}
            onClick={submit}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {rename.isPending ? t('ui.pleaseWait') : t('tags.rename.action')}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-neutral-500 dark:text-neutral-400">{t('tags.rename.hint', { tag })}</p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">{t('tags.rename.label')}</span>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            aria-invalid={!valid}
            className={`rounded-md border bg-transparent px-3 py-2 text-sm text-neutral-900 outline-none dark:text-neutral-100 ${
              valid ? 'border-neutral-300 focus:border-neutral-500 dark:border-neutral-700' : 'border-red-400 dark:border-red-600'
            }`}
          />
          {!valid && <span className="text-xs text-red-600 dark:text-red-400">{t('tags.rename.invalid')}</span>}
        </label>
      </div>
    </Modal>
  );
}
