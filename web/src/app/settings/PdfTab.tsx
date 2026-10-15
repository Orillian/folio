import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileDown } from 'lucide-react';
import type { AppearanceFile, TreeNode } from '@shared/contracts';
import { api, type TreeResponse } from '../api';
import { exportUrl } from '../export/pageExport';
import { findSpaceRootPage, getTopLevelNodes } from '../sidebar/treeUtils';
import { useToast } from '../ui/Toast';
import { AssetUploadButton } from './AssetControls';
import { CodeField, type CodeFieldHandle } from './CodeField';
import { RepoFileBadge } from './RepoFileBadge';
import { SaveBar } from './SaveBar';
import { PDF_PLACEHOLDERS } from './appearanceLogic';
import type { AppearanceController } from './useAppearance';
import '../i18n/register';

/** The page "Test PDF" prints: the space's home page, else the first page in the tree. */
export function pickHomePage(tree: TreeResponse): TreeNode | undefined {
  const home = findSpaceRootPage(tree);
  if (home) return home;
  const firstDoc = (nodes: TreeNode[]): TreeNode | undefined => {
    for (const node of nodes) {
      if (node.kind === 'doc') return node;
      const inner = firstDoc(node.children);
      if (inner) return inner;
    }
    return undefined;
  };
  return firstDoc(getTopLevelNodes(tree));
}

/** Tab 3: the PDF running header and footer, and the print stylesheet. */
export function PdfTab({ space, controller }: { space: string; controller: AppearanceController }) {
  const { t } = useTranslation('app');
  const showToast = useToast();
  const data = controller.data;
  const tree = useQuery({ queryKey: ['tree', space], queryFn: () => api.getTree(space), retry: false });
  const home = tree.data ? pickHomePage(tree.data) : undefined;

  async function testPdf() {
    if (!home) {
      showToast(t('spaceSettings.pdf.noPages'));
      return;
    }
    // A tab opened inside the click survives popup blockers; the save is awaited before it is pointed at the PDF.
    const popup = controller.tabDirty('pdf') ? window.open('', '_blank') : null;
    const saved = await controller.save('pdf');
    if (!saved) {
      popup?.close();
      return;
    }
    const url = exportUrl(home.id, 'pdf');
    if (popup) popup.location.href = url;
    else window.open(url, '_blank');
  }

  return (
    <div>
      {data?.legacyPending && (
        <p role="status" className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
          {t('spaceSettings.pdf.legacyBanner')}
        </p>
      )}
      <p className="mb-4 text-xs text-neutral-500 dark:text-neutral-400">{t('spaceSettings.pdf.separateDocs')}</p>

      <div className="space-y-6">
        <ChromeField controller={controller} file="pdf-header.html" label={t('spaceSettings.pdf.header')} placeholder={'<span>{{space}}</span><span>{{title}}</span>'} />
        <ChromeField controller={controller} file="pdf-footer.html" label={t('spaceSettings.pdf.footer')} placeholder={'<span>{{date}}</span><span>{{page}} / {{pages}}</span>'} />

        <section aria-labelledby="pdf-css-label">
          <h2 id="pdf-css-label" className="mb-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {t('spaceSettings.pdf.css')}
          </h2>
          <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">{t('spaceSettings.pdf.cssHint')}</p>
          {data && <RepoFileBadge file="export.css" state={controller.fileState('export.css')} contentRoot={data.contentRoot} repoFileBaseUrl={data.repoFileBaseUrl} />}
          <div className="mt-2">
            <CodeField
              value={controller.value('export.css')}
              onChange={(next) => controller.setValue('export.css', next)}
              language="css"
              lineNumbers
              ariaLabel={t('spaceSettings.pdf.css')}
              className="h-64"
            />
          </div>
        </section>
      </div>

      <SaveBar
        tab="pdf"
        controller={controller}
        extra={
          <button
            type="button"
            onClick={() => void testPdf()}
            disabled={controller.saving === 'pdf' || tree.isLoading}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <FileDown size={14} aria-hidden="true" />
            {t('spaceSettings.pdf.test')}
          </button>
        }
      />
    </div>
  );
}

/** The PDF header or footer: a small HTML editor, the placeholder chips and the logo upload. */
function ChromeField({ controller, file, label, placeholder }: { controller: AppearanceController; file: AppearanceFile; label: string; placeholder: string }) {
  const { t } = useTranslation('app');
  const editor = useRef<CodeFieldHandle>(null);
  const data = controller.data;
  const headingId = `pdf-${file}-label`;
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="mb-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
        {label}
      </h2>
      {data && <RepoFileBadge file={file} state={controller.fileState(file)} contentRoot={data.contentRoot} repoFileBaseUrl={data.repoFileBaseUrl} />}
      <div className="mt-2">
        <CodeField ref={editor} value={controller.value(file)} onChange={(next) => controller.setValue(file, next)} language="html" ariaLabel={label} placeholder={placeholder} className="h-36" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label={t('spaceSettings.pdf.placeholders', { field: label })}>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('spaceSettings.pdf.insert')}</span>
        {PDF_PLACEHOLDERS.map((placeholderText) => (
          <button
            key={placeholderText}
            type="button"
            onClick={() => editor.current?.insertAtCursor(placeholderText)}
            className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          >
            {placeholderText}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-neutral-200 dark:bg-neutral-700" aria-hidden="true" />
        <AssetUploadButton
          controller={controller}
          label={t('spaceSettings.pdf.uploadLogo')}
          onUploaded={(name) => editor.current?.insertAtCursor(`<img src="${name}" style="height:24px">`)}
        />
      </div>
    </section>
  );
}
