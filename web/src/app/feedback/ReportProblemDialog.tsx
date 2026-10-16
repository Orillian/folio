import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent } from 'react';
import { useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ImagePlus, X } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { describePath, MAX_IMAGE_BYTES, sendFeedback } from '../../sentry';
import '../i18n/register';

export interface ReportProblemDialogProps {
  onClose: () => void;
}

function firstImage(files: FileList | File[] | null | undefined): File | null {
  for (const file of Array.from(files ?? [])) if (file.type.startsWith('image/')) return file;
  return null;
}

/**
 * "Report a problem": a message, an optional screenshot (picked or pasted), and the page the person is on. Goes to
 * Sentry only (web/src/sentry). The menu offers it only while error reporting is configured.
 */
export function ReportProblemDialog({ onClose }: ReportProblemDialogProps) {
  const { t } = useTranslation('app');
  const toast = useToast();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!image) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  function pick(file: File | null) {
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setError(t('feedback.tooLarge'));
      return;
    }
    setError(null);
    setImage(file);
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file = firstImage(event.clipboardData.files);
    if (!file) return;
    event.preventDefault();
    pick(file);
  }

  async function submit() {
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const pageId = /^\/s\/[^/]+\/p\/([^/]+)/.exec(location.pathname)?.[1];
      const cached = pageId ? queryClient.getQueryData<{ kind?: string }>(['page', decodeURIComponent(pageId)]) : undefined;
      await sendFeedback({ message: text, context: describePath(location.pathname, cached?.kind), image });
      toast(t('feedback.thanks'), 'info');
      onClose();
    } catch {
      setError(t('feedback.failed'));
      setSending(false);
    }
  }

  return (
    <Modal
      title={t('feedback.title')}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">
            {t('ui.cancel')}
          </button>
          <button
            type="button"
            disabled={!message.trim() || sending}
            onClick={() => void submit()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {sending ? t('feedback.sending') : t('feedback.send')}
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">{t('feedback.messageLabel')}</span>
          <textarea
            autoFocus
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onPaste={onPaste}
            rows={5}
            maxLength={5000}
            placeholder={t('feedback.messagePlaceholder')}
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
        <div>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            data-testid="feedback-file"
            onChange={(e) => {
              pick(firstImage(e.target.files));
              e.target.value = '';
            }}
          />
          {preview && image ? (
            <div className="flex items-center gap-2">
              <img src={preview} alt="" className="h-14 w-20 rounded border border-neutral-200 object-cover dark:border-neutral-700" />
              <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">{image.name}</span>
              <button type="button" aria-label={t('feedback.removeImage')} onClick={() => setImage(null)} className="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800">
                <X size={14} />
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => fileInput.current?.click()} className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">
              <ImagePlus size={14} />
              {t('feedback.attach')}
            </button>
          )}
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('feedback.privacy')}</p>
        {error && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
