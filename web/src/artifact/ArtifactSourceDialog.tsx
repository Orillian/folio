/**
 * "Show source": the original JSX / TSX (or whatever was kept as `source.file`) of an artifact, read-only. The URL is
 * the same signed one as the page's iframe, served with CORS open, so a plain fetch from the app works.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Loader2 } from 'lucide-react';
import { Modal } from '../app/ui/Modal';
import './i18n/register';

export interface ArtifactSourceDialogProps {
  url: string;
  /** The file's name, for the title. */
  name: string;
  onClose: () => void;
}

type Loaded = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; text: string };

export function ArtifactSourceDialog({ url, name, onClose }: ArtifactSourceDialogProps) {
  const { t } = useTranslation('artifact');
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { credentials: 'omit', signal: controller.signal })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((text) => setLoaded({ status: 'ready', text }))
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ status: 'failed' });
      });
    return () => controller.abort();
  }, [url]);

  function copy() {
    if (loaded.status !== 'ready') return;
    void navigator.clipboard?.writeText(loaded.text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  }

  return (
    <Modal
      title={t('sourceDialog.title', { name })}
      size="xl"
      onClose={onClose}
      footer={
        loaded.status === 'ready' ? (
          <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            {copied ? t('sourceDialog.copied') : t('sourceDialog.copy')}
          </button>
        ) : undefined
      }
    >
      {loaded.status === 'loading' && (
        <div role="status" aria-label={t('sourceDialog.loading')} className="flex min-h-40 items-center justify-center text-neutral-500">
          <Loader2 size={20} className="animate-spin" aria-hidden="true" />
        </div>
      )}
      {loaded.status === 'failed' && (
        <p role="alert" className="text-red-600 dark:text-red-400">
          {t('sourceDialog.failed')}
        </p>
      )}
      {loaded.status === 'ready' && (
        <pre className="max-h-[65vh] overflow-auto rounded-md bg-neutral-50 p-3 font-mono text-xs leading-relaxed whitespace-pre dark:bg-neutral-950">
          <code>{loaded.text}</code>
        </pre>
      )}
    </Modal>
  );
}
