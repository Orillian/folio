/**
 * "Artifact…": bring an interactive HTML page into the space — by link (a direct file URL, or Claude's embed code),
 * from a file (.html, .htm, .zip, .svg, .md) or from pasted HTML. The same dialog, with `replacePageId`, swaps the
 * content of an existing artifact (PUT /api/pages/:id/artifact) and keeps its id, properties, title and icon.
 *
 * Folio never downloads claude.ai / Cursor pages (Anthropic's terms): the server answers 422 `useMcp` and the dialog
 * explains the two ways in — the embed code, or "publish this artifact to Folio" said to Claude with the Folio MCP.
 */
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, Copy, FileUp, Folder, Loader2 } from 'lucide-react';
import type { ArtifactErrorCode, ArtifactPublishBody } from '@shared/contracts';
import { api, ApiError } from '../app/api';
import { useApiErrorText } from '../app/errorText';
import { requestTreeReveal } from '../app/sidebar/treeReveal';
import { Modal } from '../app/ui/Modal';
import { Tabs } from '../app/ui/Tabs';
import { useToast } from '../app/ui/Toast';
import './i18n/register';

export interface ArtifactImportDialogProps {
  space: string;
  /** The directory a NEW artifact is created in ("" = space root). Ignored when replacing. */
  initialParentPath?: string;
  /** Set to replace the content of this artifact instead of creating a new one. */
  replacePageId?: string;
  onClose: () => void;
  /** After a replace went through (the page view reloads its frame). */
  onReplaced?: () => void;
}

type Tab = 'link' | 'file' | 'paste';

const FILE_ACCEPT = '.html,.htm,.zip,.svg,.md';

/** The server's 422 refusal: `{ code, message }`. */
function artifactErrorCode(err: unknown): ArtifactErrorCode | null {
  if (!(err instanceof ApiError) || err.status !== 422) return null;
  const code = (err.body as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? (code as ArtifactErrorCode) : null;
}

const KNOWN_CODES = new Set<ArtifactErrorCode>(['badUrl', 'tooLarge', 'tooManyFiles', 'badZip', 'badPath', 'noEntry', 'unsupportedType']);

export function ArtifactImportDialog({ space, initialParentPath = '', replacePageId, onClose, onReplaced }: ArtifactImportDialogProps) {
  const { t } = useTranslation('artifact');
  const errorText = useApiErrorText();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const replacing = replacePageId !== undefined;
  const [tab, setTab] = useState<Tab>('link');
  const [title, setTitle] = useState('');
  const [link, setLink] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [html, setHtml] = useState('');
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // A second press before the first request answers must not send a second one (and make a second page).
  const submitting = useRef(false);

  const hasInput = tab === 'link' ? link.trim() !== '' : tab === 'file' ? file !== null : html.trim() !== '';

  const run = useMutation({
    mutationFn: async () => {
      const fields: Partial<ArtifactPublishBody> = {};
      const name = title.trim();
      if (name && !replacing) fields.title = name;
      let upload: File | undefined;
      if (tab === 'link') {
        const value = link.trim();
        if (/<iframe[\s>]/i.test(value)) fields.embedCode = value;
        else fields.url = value;
      } else if (tab === 'file' && file) {
        fields.origin = 'upload';
        upload = file;
      } else {
        fields.origin = 'other';
        fields.html = html;
      }
      if (replacePageId) return api.replaceArtifact(replacePageId, fields, upload);
      return api.publishArtifact(space, { parentPath: initialParentPath, ...fields }, upload);
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['tree', space] });
      if (replacePageId) {
        void queryClient.invalidateQueries({ queryKey: ['page', replacePageId] });
        showToast(t('import.replaced'), 'info');
        onReplaced?.();
      } else {
        requestTreeReveal(space, result.page.id);
        showToast(t('import.created'), 'info');
        navigate(`/s/${space}/p/${result.page.id}`);
      }
      onClose();
    },
    onSettled: () => {
      submitting.current = false;
    },
  });

  function submit() {
    if (submitting.current || run.isPending || !hasInput) return;
    submitting.current = true;
    run.mutate();
  }

  const code = run.isError ? artifactErrorCode(run.error) : null;
  const mcpPrompt = t('import.useMcp.prompt');

  function copyPrompt() {
    void navigator.clipboard?.writeText(mcpPrompt).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  }

  const inputClass = 'w-full rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-600 dark:bg-neutral-900';

  return (
    <Modal
      title={replacing ? t('import.replaceTitle') : t('import.title')}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
            {t('import.cancel')}
          </button>
          <button
            type="submit"
            form="artifact-import-form"
            disabled={!hasInput || run.isPending}
            aria-busy={run.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {run.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {replacing ? (run.isPending ? t('import.replacing') : t('import.replace')) : run.isPending ? t('import.creating') : t('import.create')}
          </button>
        </>
      }
    >
      <form
        id="artifact-import-form"
        className="flex flex-col gap-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {!replacing && (
          <>
            <div className="flex flex-col gap-1">
              <label htmlFor="artifact-import-title" className="text-neutral-600 dark:text-neutral-400">
                {t('import.name')}
              </label>
              <input
                id="artifact-import-title"
                autoFocus
                value={title}
                maxLength={200}
                disabled={run.isPending}
                placeholder={t('import.namePlaceholder')}
                onChange={(e) => {
                  setTitle(e.target.value);
                  run.reset();
                }}
                className={inputClass}
              />
            </div>
            <p className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <Folder size={13} className="shrink-0 opacity-60" aria-hidden="true" />
              <span>{t('import.location')}:</span>
              <span className="min-w-0 truncate font-medium text-neutral-700 dark:text-neutral-300">{initialParentPath || t('import.rootLabel')}</span>
            </p>
          </>
        )}

        <Tabs
          items={[
            { key: 'link', label: t('import.tabs.link') },
            { key: 'file', label: t('import.tabs.file') },
            { key: 'paste', label: t('import.tabs.paste') },
          ]}
          active={tab}
          onSelect={(key) => {
            setTab(key as Tab);
            run.reset();
          }}
        />

        {tab === 'link' && (
          <div className="flex flex-col gap-1">
            <label htmlFor="artifact-import-link" className="text-neutral-600 dark:text-neutral-400">
              {t('import.link.label')}
            </label>
            <textarea
              id="artifact-import-link"
              rows={3}
              value={link}
              maxLength={8192}
              disabled={run.isPending}
              placeholder={t('import.link.placeholder')}
              spellCheck={false}
              onChange={(e) => {
                setLink(e.target.value);
                run.reset();
              }}
              className={`${inputClass} font-mono text-xs`}
            />
            <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('import.link.hint')}</span>
          </div>
        )}

        {tab === 'file' && (
          <div className="flex flex-col gap-1">
            <span className="text-neutral-600 dark:text-neutral-400">{t('import.file.label')}</span>
            <input
              ref={fileInput}
              type="file"
              accept={FILE_ACCEPT}
              hidden
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                run.reset();
                e.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={run.isPending}
              onClick={() => fileInput.current?.click()}
              className="flex items-center gap-2 rounded-md border border-dashed border-neutral-300 px-3 py-3 text-left hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
            >
              <FileUp size={16} className="shrink-0 opacity-60" aria-hidden="true" />
              <span className={`min-w-0 truncate ${file ? 'font-medium' : 'text-neutral-500'}`}>{file ? file.name : t('import.file.choose')}</span>
            </button>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('import.file.hint')}</span>
          </div>
        )}

        {tab === 'paste' && (
          <div className="flex flex-col gap-1">
            <label htmlFor="artifact-import-html" className="text-neutral-600 dark:text-neutral-400">
              {t('import.paste.label')}
            </label>
            <textarea
              id="artifact-import-html"
              rows={10}
              value={html}
              disabled={run.isPending}
              placeholder={t('import.paste.placeholder')}
              spellCheck={false}
              onChange={(e) => {
                setHtml(e.target.value);
                run.reset();
              }}
              className={`${inputClass} font-mono text-xs`}
            />
          </div>
        )}

        <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('import.mcpHint')}</p>

        {code === 'useMcp' && (
          <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
            <p className="font-semibold">{t('import.useMcp.title')}</p>
            <p className="mt-1">{t('import.useMcp.body')}</p>
            <ol className="mt-1 list-decimal space-y-1 pl-5">
              <li>{t('import.useMcp.optionEmbed')}</li>
              <li>
                {t('import.useMcp.optionMcp')}
                <span className="mt-1 flex items-center gap-2">
                  <q className="font-medium">{mcpPrompt}</q>
                  <button
                    type="button"
                    onClick={copyPrompt}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-400 px-2 py-0.5 hover:bg-amber-100 dark:border-amber-600 dark:hover:bg-amber-900/50"
                  >
                    {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                    {copied ? t('import.useMcp.copied') : t('import.useMcp.copy')}
                  </button>
                </span>
              </li>
            </ol>
          </div>
        )}

        {run.isError && code !== 'useMcp' && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {code && KNOWN_CODES.has(code) ? t(`import.errors.${code}`) : code ? t('import.errors.generic') : errorText(run.error, 'sidebar.createPageFailed')}
          </p>
        )}
      </form>
    </Modal>
  );
}
