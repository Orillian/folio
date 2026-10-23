import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useApiErrorText } from '../../errorText';
import { Modal } from '../../ui/Modal';
import { LabeledInput } from '../../ui/LabeledInput';
import { isValidGroupSlug, slugFromName } from './groupsLogic';
import '../../i18n/register';

const FORM_ID = 'create-group-form';

export interface CreateGroupDialogProps {
  onClose: () => void;
  onCreated: (groupId: string) => void;
}

/** POST /api/groups — name, slug (derived from the name until edited by hand) and an optional description. */
export function CreateGroupDialog({ onClose, onCreated }: CreateGroupDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');

  const create = useMutation({
    mutationFn: () => api.createGroup({ name: name.trim(), slug, description: description.trim() }),
    onSuccess: (group) => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      queryClient.invalidateQueries({ queryKey: ['access', 'matrix'] });
      onCreated(group.id);
    },
  });

  const canSubmit = name.trim().length > 0 && isValidGroupSlug(slug);

  return (
    <Modal
      title={t('access.groups.createTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
            {t('ui.cancel')}
          </button>
          <button
            type="submit"
            form={FORM_ID}
            disabled={create.isPending || !canSubmit}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {create.isPending ? t('ui.pleaseWait') : t('access.groups.create')}
          </button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) create.mutate();
        }}
      >
        <LabeledInput
          label={t('access.groups.nameLabel')}
          required
          autoFocus
          maxLength={120}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugFromName(e.target.value));
          }}
        />
        <LabeledInput
          label={t('access.groups.slugLabel')}
          required
          maxLength={63}
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
        />
        <p className="-mt-2 text-xs text-neutral-500 dark:text-neutral-400">{t('access.groups.slugHint')}</p>
        <LabeledInput
          label={t('access.groups.descriptionLabel')}
          maxLength={1000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {create.error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {errorText(create.error, 'access.groups.createFailed')}
          </p>
        )}
      </form>
    </Modal>
  );
}
