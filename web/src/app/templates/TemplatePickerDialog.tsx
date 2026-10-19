import { useEffect, useRef, useState } from 'react';
import { ClipboardList, Database, FileText, LayoutDashboard, Plus, Table2, Waypoints } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PageKind, PageMeta } from '@shared/contracts';
import { Modal } from '../ui/Modal';
import { MakeTemplateDialog } from './MakeTemplateDialog';
import { useCreateFromTemplate, useTemplates } from './useTemplates';
import type { TemplateOption } from './useTemplates';
import '../i18n/register';

/** The filter input appears once there are more templates than this. */
export const TEMPLATE_FILTER_THRESHOLD = 6;

/** Label keys under sidebar.templates.kinds; any kind not listed reads as a page. */
const KIND_LABELS: Partial<Record<PageKind, string>> = {
  doc: 'doc',
  board: 'board',
  table: 'table',
  form: 'form',
  base: 'base',
  canvas: 'canvas',
};

function KindIcon({ kind }: { kind: PageKind }) {
  const props = { size: 15, className: 'shrink-0 opacity-60', 'aria-hidden': true } as const;
  if (kind === 'board') return <LayoutDashboard {...props} />;
  if (kind === 'table') return <Table2 {...props} />;
  if (kind === 'form') return <ClipboardList {...props} />;
  if (kind === 'base') return <Database {...props} />;
  if (kind === 'canvas') return <Waypoints {...props} />;
  return <FileText {...props} />;
}

export interface TemplatePickerDialogProps {
  space: string;
  /** Directory the new page is created in, relative to the space root ("" for the root) — the «+» menu's own target. */
  parentPath: string;
  onClose: () => void;
  /** The page created from the chosen template (the dialog closes itself right after). */
  onCreated: (page: PageMeta) => void;
  /** A freshly made blank template, opened for editing (the dialog closes itself right after). */
  onTemplateCreated?: (page: PageMeta) => void;
}

/** "From template…": lists the space's templates; picking one creates a copy under `parentPath`. */
export function TemplatePickerDialog({ space, parentPath, onClose, onCreated, onTemplateCreated }: TemplatePickerDialogProps) {
  const { t } = useTranslation('app');
  const { templates, isLoading, isError, refetch } = useTemplates(space);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);

  const create = useCreateFromTemplate(
    space,
    (page) => {
      onCreated(page);
      onClose();
    },
    setError,
  );
  // "New template" (the empty state's button): the name + description dialog takes the picker's place.
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const busy = create.isPending;

  const showFilter = templates.length > TEMPLATE_FILTER_THRESHOLD;
  const needle = filter.trim().toLowerCase();
  const visible = needle ? templates.filter((template) => template.title.toLowerCase().includes(needle)) : templates;

  // Without a filter box the first template takes the focus, so Enter / arrows work at once.
  useEffect(() => {
    if (!showFilter && visible.length > 0) firstItemRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, showFilter]);

  function pick(template: TemplateOption) {
    if (busy) return;
    setError(null);
    create.mutate({ template, parentPath });
  }

  function moveFocus(from: HTMLElement, delta: 1 | -1) {
    const items = Array.from(from.closest('[role="dialog"]')?.querySelectorAll<HTMLElement>('[data-template-item]') ?? []);
    const next = items[items.indexOf(from) + delta];
    next?.focus();
  }

  if (creatingTemplate) {
    return (
      <MakeTemplateDialog
        space={space}
        mode="new"
        onClose={onClose}
        onCreated={(page) => {
          (onTemplateCreated ?? onCreated)(page);
        }}
      />
    );
  }

  return (
    <Modal
      title={t('sidebar.templates.picker.title')}
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
          {t('ui.cancel')}
        </button>
      }
    >
      {isLoading && <div className="py-3 text-sm text-neutral-400">{t('sidebar.templates.picker.loading')}</div>}

      {isError && (
        <div className="py-3 text-sm text-red-600 dark:text-red-400">
          {t('sidebar.templates.picker.loadFailed')}{' '}
          <button type="button" onClick={() => void refetch()} className="underline underline-offset-2">
            {t('auth.retry')}
          </button>
        </div>
      )}

      {!isLoading && !isError && templates.length === 0 && (
        <div className="py-2 text-sm">
          <p className="mb-1 font-medium">{t('sidebar.templates.picker.empty')}</p>
          <p className="mb-3 text-neutral-500 dark:text-neutral-400">{t('sidebar.templates.picker.emptyHint')}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null);
              setCreatingTemplate(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            <Plus size={14} aria-hidden="true" />
            {t('sidebar.templates.add')}
          </button>
        </div>
      )}

      {templates.length > 0 && (
        <>
          {showFilter && (
            <input
              autoFocus
              type="text"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && visible.length > 0) {
                  event.preventDefault();
                  pick(visible[0]);
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  firstItemRef.current?.focus();
                }
              }}
              placeholder={t('sidebar.templates.picker.filter')}
              aria-label={t('sidebar.templates.picker.filter')}
              className="mb-2 h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
            />
          )}
          <div className="max-h-72 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700">
            {visible.map((template, index) => (
              <button
                key={template.id}
                ref={index === 0 ? firstItemRef : undefined}
                type="button"
                data-template-item=""
                disabled={busy}
                onClick={() => pick(template)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    moveFocus(event.currentTarget, 1);
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    moveFocus(event.currentTarget, -1);
                  }
                }}
                className="flex w-full items-center gap-2 border-b border-neutral-100 px-2.5 py-2 text-left text-sm last:border-b-0 hover:bg-neutral-50 focus:bg-neutral-100 focus:outline-none disabled:opacity-50 dark:border-neutral-800 dark:hover:bg-neutral-800 dark:focus:bg-neutral-800"
              >
                {template.icon ? (
                  <span className="w-[15px] shrink-0 text-center text-[14px] leading-none">{template.icon}</span>
                ) : (
                  <KindIcon kind={template.kind} />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{template.title}</span>
                  {template.description && (
                    <span className="truncate text-xs text-neutral-500 dark:text-neutral-400" title={template.description}>
                      {template.description.replace(/\s+/g, ' ')}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">
                  {t(`sidebar.templates.kinds.${KIND_LABELS[template.kind] ?? 'doc'}`)}
                </span>
              </button>
            ))}
            {visible.length === 0 && <div className="px-3 py-3 text-sm text-neutral-400">{t('sidebar.templates.picker.noMatch')}</div>}
          </div>
          {create.isPending && <p className="mt-2 text-xs text-neutral-500">{t('sidebar.templates.picker.creating')}</p>}
        </>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </Modal>
  );
}
