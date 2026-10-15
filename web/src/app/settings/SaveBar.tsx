import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppearanceFile } from '@shared/contracts';
import type { AppearanceController } from './useAppearance';
import type { SettingsTab } from './appearanceLogic';
import { collapseUnchanged, diffLines } from './lineDiff';
import '../i18n/register';

export interface SaveBarProps {
  tab: SettingsTab;
  controller: AppearanceController;
  /** The save is refused while the tab's content is not valid (e.g. a malformed language code). */
  invalid?: boolean;
  /** Extra buttons on the left of Save (e.g. "Test PDF"). */
  extra?: ReactNode;
}

/** The tab's one Save button, the unsaved-changes note and, after a lost race, the "Changed in the repository" panel. */
export function SaveBar({ tab, controller, invalid, extra }: SaveBarProps) {
  const { t } = useTranslation('app');
  const dirty = controller.tabDirty(tab);
  const saving = controller.saving === tab;
  const conflict = controller.conflict?.tab === tab ? controller.conflict : null;
  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-6 border-t border-neutral-200 bg-white/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6 dark:border-neutral-800 dark:bg-neutral-950/95">
      {conflict && <ConflictPanel controller={controller} files={conflict.files} />}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="mr-auto text-xs text-neutral-500 dark:text-neutral-400" aria-live="polite">
          {dirty ? t('spaceSettings.unsaved') : ''}
        </span>
        {extra}
        <button
          type="button"
          onClick={() => void controller.save(tab)}
          disabled={!dirty || saving || invalid}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          {saving ? t('ui.pleaseWait') : t('spaceSettings.save')}
        </button>
      </div>
    </div>
  );
}

function ConflictPanel({ controller, files }: { controller: AppearanceController; files: AppearanceFile[] }) {
  const { t } = useTranslation('app');
  const [diffOpen, setDiffOpen] = useState(false);
  const paths = files.map((file) => controller.fileState(file)?.path ?? `.folio/${file}`);
  const buttonClass =
    'rounded-md border border-amber-400 px-2.5 py-1 text-xs text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/40';
  return (
    <div role="alert" className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
      <p className="font-medium">{t('spaceSettings.conflict.title')}</p>
      <p className="mt-1 text-xs">{t('spaceSettings.conflict.body', { files: paths.join(', ') })}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => void controller.reloadConflict()} className={buttonClass}>
          {t('spaceSettings.conflict.reload')}
        </button>
        <button type="button" onClick={() => setDiffOpen((open) => !open)} aria-expanded={diffOpen} className={buttonClass}>
          {diffOpen ? t('spaceSettings.conflict.hideDiff') : t('spaceSettings.conflict.showDiff')}
        </button>
        <button type="button" onClick={() => void controller.keepMine()} className={buttonClass}>
          {t('spaceSettings.conflict.keepMine')}
        </button>
      </div>
      {diffOpen && (
        <div className="mt-3 space-y-3">
          {files.map((file) => (
            <FileDiff key={file} file={file} controller={controller} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The repository's text (`-`) against the draft (`+`), unchanged runs folded. */
function FileDiff({ file, controller }: { file: AppearanceFile; controller: AppearanceController }) {
  const { t } = useTranslation('app');
  const theirs = controller.conflict?.theirs.find((f) => f.file === file)?.content;
  if (theirs === undefined) return <p className="text-xs">{t('spaceSettings.conflict.noDiff')}</p>;
  const rows = collapseUnchanged(diffLines(theirs, controller.value(file)));
  return (
    <div>
      <p className="mb-1 font-mono text-xs">{controller.fileState(file)?.path ?? `.folio/${file}`}</p>
      <pre className="max-h-64 overflow-auto rounded border border-amber-200 bg-white p-2 text-[11px] leading-snug text-neutral-800 dark:border-amber-900 dark:bg-neutral-950 dark:text-neutral-200" aria-label={t('spaceSettings.conflict.diffLabel')}>
        <span className="mb-1 block text-neutral-500">{t('spaceSettings.conflict.legend')}</span>
        {rows.map((row, index) =>
          row.kind === 'skip' ? (
            <span key={index} className="block text-neutral-400">
              {t('spaceSettings.conflict.unchanged', { count: row.count })}
            </span>
          ) : (
            <span
              key={index}
              className={`block whitespace-pre-wrap break-all ${
                row.kind === 'del' ? 'bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200' : row.kind === 'add' ? 'bg-green-100 text-green-900 dark:bg-green-950/60 dark:text-green-200' : ''
              }`}
            >
              {row.kind === 'del' ? '- ' : row.kind === 'add' ? '+ ' : '  '}
              {row.text}
            </span>
          ),
        )}
      </pre>
    </div>
  );
}
