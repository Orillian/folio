import { useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SiteAssetInfo } from '@shared/contracts';
import { ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';
import { checkAssetFile, formatBytes } from './appearanceLogic';
import type { AppearanceController } from './useAppearance';
import '../i18n/register';

const ASSET_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.svg,.ico,.woff,.woff2';

const buttonClass =
  'inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800';

export interface AssetUploadButtonProps {
  controller: AppearanceController;
  label: string;
  onUploaded?: (name: string) => void;
}

/** "Upload…": picks a file, checks its name and size, uploads it as the raw body, and asks before replacing a file with the same name. */
export function AssetUploadButton({ controller, label, onUploaded }: AssetUploadButtonProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState<{ blob: Blob; name: string } | null>(null);

  async function upload(blob: Blob, name: string, replace: boolean) {
    setBusy(true);
    try {
      const info = await controller.uploadAsset(blob, name, replace);
      setReplacing(null);
      showToast(t('spaceSettings.assets.uploaded', { name: info.name }), 'info');
      onUploaded?.(info.name);
    } catch (err) {
      if (!replace && err instanceof ApiError && err.status === 409) {
        setReplacing({ blob, name });
      } else {
        setReplacing(null);
        showToast(errorText(err, 'spaceSettings.assets.uploadFailed'));
      }
    } finally {
      setBusy(false);
    }
  }

  function onPick(file: File | undefined) {
    if (!file) return;
    const check = checkAssetFile(file);
    if (!check.ok) {
      showToast(t(check.reason === 'size' ? 'spaceSettings.assets.tooBig' : 'spaceSettings.assets.badName'));
      return;
    }
    const blob = file.slice(0, file.size, check.type);
    if (controller.data?.assets.some((a) => a.name === check.name)) setReplacing({ blob, name: check.name });
    else void upload(blob, check.name, false);
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ASSET_ACCEPT}
        className="hidden"
        aria-label={label}
        tabIndex={-1}
        data-testid="asset-file-input"
        onChange={(e) => {
          onPick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <button type="button" disabled={busy} onClick={() => input.current?.click()} className={buttonClass}>
        <Upload size={13} aria-hidden="true" />
        {busy ? t('ui.pleaseWait') : label}
      </button>
      {replacing && (
        <ConfirmDialog
          title={t('spaceSettings.assets.replaceTitle', { name: replacing.name })}
          confirmLabel={t('spaceSettings.assets.replace')}
          busy={busy}
          onCancel={() => setReplacing(null)}
          onConfirm={() => void upload(replacing.blob, replacing.name, true)}
        >
          {t('spaceSettings.assets.replaceBody', { name: replacing.name })}
        </ConfirmDialog>
      )}
    </>
  );
}

export interface AssetPickerProps {
  id: string;
  label: string;
  value: string;
  assets: SiteAssetInfo[];
  onChange: (name: string) => void;
  controller: AppearanceController;
  disabled?: boolean;
}

/** One of site.json's image fields: choose from the uploaded files, upload a new one, or clear the field. */
export function AssetPicker({ id, label, value, assets, onChange, controller, disabled }: AssetPickerProps) {
  const { t } = useTranslation('app');
  // A name in site.json that is not (or no longer) in the folder still has to show, or the select would lie.
  const missing = value && !assets.some((a) => a.name === value);
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-800 outline-none focus:border-neutral-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        >
          <option value="">{t('spaceSettings.seo.noImage')}</option>
          {missing && <option value={value}>{t('spaceSettings.seo.missingFile', { name: value })}</option>}
          {assets.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
        {!disabled && <AssetUploadButton controller={controller} label={t('spaceSettings.seo.upload')} onUploaded={onChange} />}
        {value && !disabled && (
          <button type="button" onClick={() => onChange('')} className={buttonClass}>
            {t('spaceSettings.seo.remove')}
          </button>
        )}
      </div>
    </div>
  );
}

/** The files of `.folio/assets/`: what the site stylesheet and the PDF header can refer to by name. */
export function AssetsPanel({ controller }: { controller: AppearanceController }) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const assets = controller.data?.assets ?? [];
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove(name: string) {
    setBusy(true);
    try {
      await controller.deleteAsset(name);
      showToast(t('spaceSettings.assets.deleted', { name }), 'info');
      setDeleting(null);
    } catch (err) {
      showToast(errorText(err, 'spaceSettings.assets.deleteFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="settings-assets">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 id="settings-assets" className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          {t('spaceSettings.assets.title')}
        </h3>
        <AssetUploadButton controller={controller} label={t('spaceSettings.assets.upload')} />
      </div>
      <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">{t('spaceSettings.assets.hint')}</p>
      {assets.length === 0 ? (
        <p className="text-xs text-neutral-400">{t('spaceSettings.assets.empty')}</p>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 text-sm dark:divide-neutral-800 dark:border-neutral-800">
          {assets.map((a) => (
            <li key={a.name} className="flex items-center gap-2 px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-800 dark:text-neutral-200">{a.name}</span>
              <span className="shrink-0 text-xs text-neutral-400">{formatBytes(a.size)}</span>
              <button
                type="button"
                aria-label={t('spaceSettings.assets.deleteLabel', { name: a.name })}
                onClick={() => setDeleting(a.name)}
                className="shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {deleting && (
        <ConfirmDialog
          title={t('spaceSettings.assets.deleteTitle', { name: deleting })}
          confirmLabel={t('ui.delete')}
          destructive
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void remove(deleting)}
        >
          {t('spaceSettings.assets.deleteBody')}
        </ConfirmDialog>
      )}
    </section>
  );
}
