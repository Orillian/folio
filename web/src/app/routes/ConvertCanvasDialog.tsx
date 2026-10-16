import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { LabeledInput } from '../ui/LabeledInput';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import '../../canvas/i18n/register';

export interface ConvertCanvasDialogProps {
  pageId: string;
  space: string;
  /** The canvas's own path: the board goes into its folder by default. */
  pagePath: string;
  title: string;
  onClose: () => void;
}

function folderOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/**
 * "Convert to Folio board": name, folder (the canvas's own by default), "keep
 * the canvas" (always on — Folio never changes or removes the canvas file) and
 * the list of what the board loses, asked from the server before anything is
 * written (GET /api/pages/:id/canvas/convert). Creating opens the new board.
 */
export function ConvertCanvasDialog({ pageId, space, pagePath, title, onClose }: ConvertCanvasDialogProps) {
  const { t } = useTranslation('canvas');
  const { t: tApp } = useTranslation('app');
  const navigate = useNavigate();
  const errorText = useApiErrorText();
  const [name, setName] = useState(`${title} (board)`);
  const [folder, setFolder] = useState(folderOf(pagePath));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = useQuery({ queryKey: ['canvas-convert-report', pageId], queryFn: () => api.getCanvasConversionReport(pageId), staleTime: 10_000 });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.convertCanvas(pageId, { title: name.trim() || undefined, parentPath: folder.trim().replace(/^\/+|\/+$/g, '') });
      onClose();
      navigate(`/s/${space}/p/${result.board.id}`);
    } catch (err) {
      setError(`${t('convert.failed')}: ${errorText(err)}`);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('convert.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
            {tApp('ui.cancel')}
          </button>
          <button
            type="button"
            disabled={busy || !name.trim() || report.isError}
            onClick={() => void submit()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {busy ? t('convert.creating') : t('convert.submit')}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-neutral-600 dark:text-neutral-400">{t('convert.intro')}</p>
        <LabeledInput label={t('convert.name')} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={200} />
        <LabeledInput label={t('convert.location')} value={folder} placeholder={t('convert.locationRoot')} onChange={(e) => setFolder(e.target.value)} />
        <label className="flex items-start gap-2">
          <input type="checkbox" checked disabled className="mt-0.5" />
          <span>
            {t('convert.keep')}
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">{t('convert.keepHint')}</span>
          </span>
        </label>
        <div>
          <div className="mb-1 font-medium">{t('convert.lossesTitle')}</div>
          {report.isLoading && <p className="text-neutral-500">{t('convert.lossesLoading')}</p>}
          {report.isError && <p className="text-red-600 dark:text-red-400">{errorText(report.error)}</p>}
          {report.data &&
            (report.data.losses.length === 0 ? (
              <p className="text-neutral-600 dark:text-neutral-400">{t('convert.noLosses')}</p>
            ) : (
              <ul className="list-disc space-y-0.5 pl-5 text-neutral-700 dark:text-neutral-300" data-testid="canvas-convert-losses">
                {report.data.losses.map((loss) => (
                  <li key={loss.code}>{t(`convert.loss.${loss.code}`, { count: loss.count })}</li>
                ))}
              </ul>
            ))}
        </div>
        {error && (
          <p role="alert" className="text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
