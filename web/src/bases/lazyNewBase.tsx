/**
 * The "New base" dialog is its own chunk (it pulls the YAML writer). Clicking "New base" used to wait for that
 * chunk (and for a fresh tree) before anything appeared. Now the chunk is requested as soon as the "+" menu
 * opens (`preloadNewBaseDialog`), and while it is still on its way the dialog's shell (title and a spinner) is
 * on screen at once.
 */
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Modal } from '../app/ui/Modal';
import type { NewBaseDialogProps } from './NewBaseDialog';
import './i18n/register';

let chunk: Promise<typeof import('./NewBaseDialog')> | null = null;

/** Requests the dialog's chunk (once; a failed request is retried on the next call). */
export function preloadNewBaseDialog(): Promise<typeof import('./NewBaseDialog')> {
  if (!chunk) {
    chunk = import('./NewBaseDialog');
    chunk.catch(() => {
      chunk = null;
    });
  }
  return chunk;
}

const Dialog = lazy(preloadNewBaseDialog);

function Shell({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('bases');
  return (
    <Modal title={t('new.title')} onClose={onClose}>
      <div role="status" aria-label={t('loading')} className="flex min-h-40 items-center justify-center text-neutral-500">
        <Loader2 size={20} className="animate-spin" aria-hidden="true" />
      </div>
    </Modal>
  );
}

export function NewBaseDialog(props: NewBaseDialogProps) {
  return (
    <Suspense fallback={<Shell onClose={props.onClose} />}>
      <Dialog {...props} />
    </Suspense>
  );
}
