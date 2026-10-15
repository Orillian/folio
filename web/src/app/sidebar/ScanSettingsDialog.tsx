import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { DEFAULT_SCAN_IGNORE, MAX_SCAN_IGNORE_ENTRIES, normalizeScanIgnoreEntry } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { Modal } from '../ui/Modal';
import '../i18n/register';

export interface ScanSettingsDialogProps {
  space: string;
  onClose: () => void;
}

/** One entry per line; blank lines dropped. Returns the normalized list, or the first line that is not an acceptable entry. */
export function parseScanIgnoreText(text: string): { entries: string[]; invalid?: string } {
  const entries: string[] = [];
  for (const line of text.split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    const normalized = normalizeScanIgnoreEntry(raw);
    if (normalized === null) return { entries, invalid: raw };
    if (!entries.includes(normalized)) entries.push(normalized);
  }
  return { entries };
}

/**
 * Space settings "Indexing & files" (space menu, admins only; the API is gated
 * the same way server-side): the top-level files and folders Folio does not
 * index (on top of the defaults, which are always skipped), and the light
 * footprint flag. Saving a changed list rescans the space; files on disk are
 * never touched.
 */
export function ScanSettingsDialog({ space, onClose }: ScanSettingsDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  // Shares the ['spaces'] cache with the sidebar — the current settings are already there (admins get them).
  const { data } = useQuery({ queryKey: ['spaces'], queryFn: api.listSpaces });
  const info = data?.spaces.find((s) => s.slug === space);
  const currentList = info?.scanIgnore ?? [];
  const rootPathSet = (info?.git?.rootPath ?? '') !== '';
  const currentLight = info?.lightFootprint === true;
  const [draftText, setDraftText] = useState<string | null>(null);
  const [draftLight, setDraftLight] = useState<boolean | null>(null);
  const text = draftText ?? currentList.join('\n');
  const light = rootPathSet || (draftLight ?? currentLight);
  const parsed = parseScanIgnoreText(text);
  const tooMany = parsed.entries.length > MAX_SCAN_IGNORE_ENTRIES;
  const listChanged = JSON.stringify(parsed.entries) !== JSON.stringify(currentList);
  const lightChanged = !rootPathSet && light !== currentLight;
  const canSave = !parsed.invalid && !tooMany && (listChanged || lightChanged);

  const save = useMutation({
    mutationFn: () =>
      api.updateScanSettings(space, {
        ...(listChanged ? { scanIgnore: parsed.entries } : {}),
        ...(lightChanged ? { lightFootprint: light } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['spaces'] });
      queryClient.invalidateQueries({ queryKey: ['tree', space] });
      onClose();
    },
  });

  return (
    <Modal
      title={t('sidebar.scanSettings.title')}
      onClose={save.isPending ? () => {} : onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={save.isPending}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {t('ui.cancel')}
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending || !canSave}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {save.isPending ? t('sidebar.scanSettings.saving') : t('sidebar.scanSettings.save')}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{t('sidebar.scanSettings.ignoreLabel')}</span>
          <span className="text-xs leading-snug text-neutral-500 dark:text-neutral-400">{t('sidebar.scanSettings.ignoreHint')}</span>
          <textarea
            value={text}
            onChange={(e) => setDraftText(e.target.value)}
            rows={5}
            spellCheck={false}
            placeholder={t('sidebar.scanSettings.ignorePlaceholder')}
            aria-label={t('sidebar.scanSettings.ignoreLabel')}
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 font-mono text-xs dark:border-neutral-700"
          />
        </label>
        <p className="-mt-2 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          <span>{t('sidebar.scanSettings.defaultsLabel')}</span>
          {DEFAULT_SCAN_IGNORE.map((entry) => (
            <code key={entry} className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
              {entry}
            </code>
          ))}
        </p>
        {parsed.invalid && (
          <p role="alert" className="-mt-2 text-xs text-red-600 dark:text-red-400">
            {t('sidebar.scanSettings.invalid', { entry: parsed.invalid })}
          </p>
        )}
        {tooMany && (
          <p role="alert" className="-mt-2 text-xs text-red-600 dark:text-red-400">
            {t('sidebar.scanSettings.tooMany', { max: MAX_SCAN_IGNORE_ENTRIES })}
          </p>
        )}
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            role="switch"
            checked={light}
            disabled={rootPathSet}
            onChange={(e) => setDraftLight(e.target.checked)}
            className="mt-1 h-4 w-4 shrink-0"
          />
          <span className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t('sidebar.scanSettings.lightLabel')}</span>
            <span className="text-xs leading-snug text-neutral-500 dark:text-neutral-400">
              {rootPathSet ? t('sidebar.scanSettings.lightAlways') : t('sidebar.scanSettings.lightHint')}
            </span>
          </span>
        </label>
        {listChanged && !parsed.invalid && <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('sidebar.scanSettings.rescanNote')}</p>}
        {save.isError && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {errorText(save.error, 'sidebar.scanSettings.saveFailed')}
          </p>
        )}
      </div>
    </Modal>
  );
}
