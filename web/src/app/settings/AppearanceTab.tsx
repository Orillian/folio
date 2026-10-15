import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AssetsPanel } from './AssetControls';
import { CodeField } from './CodeField';
import { RepoFileBadge } from './RepoFileBadge';
import { SaveBar } from './SaveBar';
import { SITE_CSS_HOOKS } from './appearanceLogic';
import { syncPreviewStyle, watchPreviewDocument } from './previewCss';
import { sanitizeDraftCss } from './sanitizeDraft';
import type { AppearanceController } from './useAppearance';
import '../i18n/register';

const PREVIEW_DEBOUNCE_MS = 250;

/** Tab 2: the site's own stylesheet (`.folio/site.css`) next to a live preview of the published site. */
export function AppearanceTab({ space, controller }: { space: string; controller: AppearanceController }) {
  const { t } = useTranslation('app');
  const css = controller.value('site.css');
  // What visitors will get: the same sanitizer as the server's, so the warnings and the preview are the real ones.
  const sanitized = useMemo(() => sanitizeDraftCss(css, space), [css, space]);
  const data = controller.data;

  return (
    <div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <section aria-labelledby="settings-css">
            <h2 id="settings-css" className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {t('spaceSettings.appearance.title')}
            </h2>
            <p className="mb-2 mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('spaceSettings.appearance.intro')}</p>
            {data && <RepoFileBadge file="site.css" state={controller.fileState('site.css')} contentRoot={data.contentRoot} repoFileBaseUrl={data.repoFileBaseUrl} showWarnings={false} />}
            <div className="mt-2">
              <CodeField
                value={css}
                onChange={(next) => controller.setValue('site.css', next)}
                language="css"
                lineNumbers
                ariaLabel={t('spaceSettings.appearance.editorLabel')}
                placeholder={'.folio-site {\n  --accent: #0b6bcb;\n}'}
                className="h-[26rem]"
              />
            </div>
            {sanitized.warnings.length > 0 && (
              <div role="status" className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                <p className="font-medium">{t('spaceSettings.appearance.warnings')}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {sanitized.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section aria-labelledby="settings-hooks">
            <h3 id="settings-hooks" className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              {t('spaceSettings.appearance.hooks')}
            </h3>
            <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">{t('spaceSettings.appearance.hooksHint')}</p>
            <ul className="flex flex-wrap gap-1.5">
              {SITE_CSS_HOOKS.map((hook) => (
                <li key={hook}>
                  <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">{hook}</code>
                </li>
              ))}
            </ul>
          </section>

          <AssetsPanel controller={controller} />
        </div>

        <section aria-labelledby="settings-preview" className="min-w-0">
          <h3 id="settings-preview" className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {t('spaceSettings.appearance.preview')}
          </h3>
          {data?.isPublic ? (
            <>
              <PreviewFrame space={space} css={sanitized.css} title={t('spaceSettings.appearance.previewTitle')} />
              <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">{t('spaceSettings.appearance.previewHint')}</p>
            </>
          ) : (
            data && (
              <p className="rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                {t('spaceSettings.appearance.previewNeedsPublic')}
              </p>
            )
          )}
        </section>
      </div>
      <SaveBar tab="appearance" controller={controller} />
    </div>
  );
}

/**
 * The public site in a same-origin iframe. The draft CSS goes into the iframe's own `<head>` (see
 * previewCss.ts), debounced; a navigation inside the frame is picked up by its `load` event.
 */
function PreviewFrame({ space, css, title }: { space: string; css: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  // The debounced text: what the frame shows, and what its observer re-applies when the site adds to its <head>.
  const shown = useRef(css);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => {
      shown.current = css;
      const doc = readDocument(frame.current);
      if (doc) syncPreviewStyle(doc, css);
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [css]);

  useEffect(() => () => stop.current?.(), []);

  function onLoad() {
    stop.current?.();
    const doc = readDocument(frame.current);
    stop.current = doc ? watchPreviewDocument(doc, () => shown.current) : null;
  }

  return (
    <iframe
      ref={frame}
      src={`/public/${encodeURIComponent(space)}`}
      title={title}
      onLoad={onLoad}
      className="h-[34rem] w-full rounded-md border border-neutral-300 bg-white dark:border-neutral-700"
    />
  );
}

/** The frame's document, or null when it is not reachable (not loaded yet, or a different origin). */
function readDocument(frame: HTMLIFrameElement | null): Document | null {
  try {
    return frame?.contentDocument ?? null;
  } catch {
    return null;
  }
}
