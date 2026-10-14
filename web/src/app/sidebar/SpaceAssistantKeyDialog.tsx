import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { SharedKeyPanel } from '../assistant/SharedKeyPanel';
import '../i18n/register';

export interface SpaceAssistantKeyDialogProps {
  space: string;
  onClose: () => void;
}

/**
 * The shared Folio AI (Cursor) key of one space — opened from the sidebar's space
 * menu (space admins; the API is gated the same way server-side). Members chatting
 * with the assistant in this space use it when they have no personal key; an
 * instance-wide key and the personal-key policy are managed by instance admins on
 * /admin/assistant.
 */
export function SpaceAssistantKeyDialog({ space, onClose }: SpaceAssistantKeyDialogProps) {
  const { t } = useTranslation('app');
  return (
    <Modal
      title={t('assistant.sharedKey.titleSpace')}
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {t('ui.close')}
        </button>
      }
    >
      <SharedKeyPanel scope="space" space={space} />
    </Modal>
  );
}
