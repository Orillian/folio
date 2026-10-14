import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { SpaceAssetMode } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { Modal } from '../ui/Modal';
import '../i18n/register';

export interface ImageStorageDialogProps {
  space: string;
  onClose: () => void;
}

/**
 * Space setting "Store images in the repository" (space menu, admins only; the
 * API is gated the same way server-side). Off = pasted/uploaded images go to
 * Folio's own object storage (the default); on = they are written to `assets/`
 * of the space's repository and linked from the page with a RELATIVE path, so
 * they render on GitHub too and travel with the docs. Only NEW uploads are
 * affected — images already in a page stay where they are.
 */
export function ImageStorageDialog({ space, onClose }: ImageStorageDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  // Shares the ['spaces'] cache with the sidebar — the current mode is already there.
  const { data } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const current: SpaceAssetMode = data?.spaces.find((s) => s.slug === space)?.assetMode ?? 'store';
  const [draft, setDraft] = useState<SpaceAssetMode | null>(null);
  const mode = draft ?? current;

  const save = useMutation({
    mutationFn: () => api.setSpaceAssetMode(space, mode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      onClose();
    },
  });

  return (
    <Modal
      title={t('sidebar.imageStorage.title')}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {t('ui.cancel')}
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending || mode === current}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {save.isPending ? t('sidebar.imageStorage.saving') : t('sidebar.imageStorage.save')}
          </button>
        </>
      }
    >
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          role="switch"
          checked={mode === 'repo'}
          onChange={(e) => setDraft(e.target.checked ? 'repo' : 'store')}
          className="mt-1 h-4 w-4 shrink-0"
        />
        <span className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t('sidebar.imageStorage.label')}</span>
          <span className="text-xs leading-snug text-neutral-500 dark:text-neutral-400">{t('sidebar.imageStorage.hint')}</span>
        </span>
      </label>
      {save.isError && (
        <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">
          {errorText(save.error, 'sidebar.imageStorage.saveFailed')}
        </p>
      )}
    </Modal>
  );
}
