import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LayoutDashboard } from 'lucide-react';
import type { PageDoc } from '@shared/contracts';
import { CanvasPane, spaceFileUrl } from '../../canvas';
import { api } from '../api';
import { ConvertCanvasDialog } from './ConvertCanvasDialog';
import '../../canvas/i18n/register';

export interface CanvasPageViewProps {
  page: PageDoc;
  /** Editor+ on the space: may make a board from the canvas. */
  canConvert: boolean;
}

/**
 * A canvas page in the app (session): the read-only canvas plus "Convert to
 * Folio board" in its toolbar for editors. File cards open their pages in the
 * app; a PDF card previews through the session file route.
 */
export function CanvasPageView({ page, canConvert }: CanvasPageViewProps) {
  const { t } = useTranslation('canvas');
  const [converting, setConverting] = useState(false);
  if (!page.canvas) return null;
  return (
    <>
      <CanvasPane
        payload={page.canvas}
        pageId={page.id}
        space={page.space}
        pagePath={page.path}
        pageHref={(id) => `/s/${page.space}/p/${id}`}
        fileUrl={(p) => spaceFileUrl(page.space, p)}
        pdfUrl={(id) => api.pageFileUrl(id)}
        toolbarExtra={
          canConvert && page.canvas.document ? (
            <button type="button" onClick={() => setConverting(true)} title={t('toolbar.convert')} aria-label={t('toolbar.convert')}>
              <LayoutDashboard size={16} />
              <span className="folio-canvas-convert-label">{t('toolbar.convert')}</span>
            </button>
          ) : undefined
        }
      />
      {converting && <ConvertCanvasDialog pageId={page.id} space={page.space} pagePath={page.path} title={page.title} onClose={() => setConverting(false)} />}
    </>
  );
}
