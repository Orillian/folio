import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PageMeta } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { Modal } from '../ui/Modal';
import { openTemplatesSection } from './templatesSectionState';
import { invalidateTemplates } from './useTemplates';
import '../i18n/register';

export const TEMPLATE_NAME_MAX = 300;
export const TEMPLATE_DESCRIPTION_MAX = 1000;

export interface MakeTemplateDialogProps {
  space: string;
  /**
   * `make`: a copy of `page` goes to the space's templates (with its subpages, when `hasChildren`).
   * `new`: a blank document template is created.
   */
  mode: 'make' | 'new';
  /** The page to copy, for `make`. */
  page?: { id: string; title: string };
  /** The page has subpages: the "Include subpages" box is shown (on by default). */
  hasChildren?: boolean;
  onClose: () => void;
  /** The template that was created (the dialog closes itself right after). */
  onCreated: (template: PageMeta) => void;
}

/**
 * "Make template" / "New template": a name and an optional description (kept in the template's
 * `template-description` property), then the server call — which can take a while on a big space, hence the pending
 * state: inputs locked, the dialog cannot be dismissed by accident, the button says it is working.
 */
export function MakeTemplateDialog({ space, mode, page, hasChildren = false, onClose, onCreated }: MakeTemplateDialogProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const [name, setName] = useState(mode === 'make' ? (page?.title ?? '') : '');
  const [description, setDescription] = useState('');
  const [includeChildren, setIncludeChildren] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const create = useMutation({
    mutationFn: (): Promise<PageMeta> => {
      const title = name.trim();
      const desc = description.trim();
      if (mode === 'make' && page) {
        return api.makeTemplate(page.id, { includeChildren: hasChildren ? includeChildren : false, title, ...(desc ? { description: desc } : {}) });
      }
      return api.createBlankTemplate(space, { title, ...(desc ? { description: desc } : {}) });
    },
    onSuccess: (template) => {
      invalidateTemplates(queryClient, space);
      queryClient.invalidateQueries({ queryKey: ['tree', space] });
      openTemplatesSection(space);
      onCreated(template);
      onClose();
    },
    onError: (err) => setError(errorText(err, mode === 'make' ? 'sidebar.tree.makeTemplateFailed' : 'sidebar.templates.createBlankFailed')),
  });

  const pending = create.isPending;
  const valid = name.trim().length > 0;

  function submit() {
    if (!valid || pending) return;
    setError(null);
    create.mutate();
  }

  const inputClass =
    'w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-100 dark:focus:border-neutral-500';

  return (
    <Modal
      title={mode === 'make' ? t('sidebar.tree.makeTemplate') : t('sidebar.templates.add')}
      // While the server works the dialog stays: Escape, the backdrop and the X do nothing.
      onClose={pending ? () => undefined : onClose}
      footer={
        <>
          <button
            type="button"
            disabled={pending}
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
          >
            {t('ui.cancel')}
          </button>
          <button
            type="button"
            disabled={!valid || pending}
            onClick={submit}
            className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {pending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {pending ? t('sidebar.templates.make.creating') : t('sidebar.templates.make.submit')}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3" aria-busy={pending}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">{t('sidebar.templates.make.name')}</span>
          <input
            ref={nameRef}
            value={name}
            maxLength={TEMPLATE_NAME_MAX}
            disabled={pending}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">{t('sidebar.templates.make.description')}</span>
          <textarea
            value={description}
            rows={3}
            maxLength={TEMPLATE_DESCRIPTION_MAX}
            disabled={pending}
            placeholder={t('sidebar.templates.make.descriptionHint')}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            className={`${inputClass} resize-y`}
          />
        </label>
        {mode === 'make' && hasChildren && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeChildren} disabled={pending} onChange={(e) => setIncludeChildren(e.target.checked)} />
            <span>{t('sidebar.templates.make.includeChildren')}</span>
          </label>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
