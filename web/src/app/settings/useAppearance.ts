import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { AppearanceFile, AppearanceFileState, SiteAssetInfo, SpaceAppearanceResponse } from '@shared/contracts';
import { api, ApiError } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import {
  TAB_FILES,
  adoptServerFiles,
  applySaved,
  changesFor,
  fallbackPath,
  filesFromConflictBody,
  isDraftDirty,
  mergeServerFiles,
  setDraft,
  type FilesState,
  type SettingsTab,
} from './appearanceLogic';
import '../i18n/register';

export const appearanceKey = (space: string) => ['space-appearance', space] as const;

/** A save that lost the race with a commit made in the repository. Nothing was written. */
export interface AppearanceConflict {
  tab: SettingsTab;
  /** The files whose stored version differs from the one the editor started from. */
  files: AppearanceFile[];
  /** The repository's current files, from the 409 body (empty when the body carried none — Reload then asks again). */
  theirs: AppearanceFileState[];
}

export interface AppearanceController {
  space: string;
  query: UseQueryResult<SpaceAppearanceResponse>;
  data: SpaceAppearanceResponse | undefined;
  fileState: (file: AppearanceFile) => AppearanceFileState | undefined;
  /** The text the editor shows: the draft, else the stored content. */
  value: (file: AppearanceFile) => string;
  setValue: (file: AppearanceFile, content: string) => void;
  dirty: (file: AppearanceFile) => boolean;
  tabDirty: (tab: SettingsTab) => boolean;
  anyDirty: boolean;
  /** The tab whose save is in flight. */
  saving: SettingsTab | null;
  /** Resolves to true when there was nothing to save or the save went through. */
  save: (tab: SettingsTab) => Promise<boolean>;
  conflict: AppearanceConflict | null;
  /** Take the repository's version of the conflicting files; drafts of other files stay. */
  reloadConflict: () => Promise<void>;
  /** Keep my draft: its etag becomes the repository's current one, so the next Save overwrites it. */
  keepMine: () => Promise<void>;
  uploadAsset: (file: Blob, name: string, replace: boolean) => Promise<SiteAssetInfo>;
  deleteAsset: (name: string) => Promise<void>;
}

/** The server's state for the settings page plus the editor's drafts (kept across tabs), saves and conflicts. */
export function useAppearance(space: string): AppearanceController {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const showToast = useToast();
  const queryClient = useQueryClient();

  const query = useQuery({ queryKey: appearanceKey(space), queryFn: () => api.getSpaceAppearance(space), retry: false });
  const data = query.data;

  const [files, setFiles] = useState<FilesState>({});
  const [saving, setSaving] = useState<SettingsTab | null>(null);
  const [conflict, setConflict] = useState<AppearanceConflict | null>(null);

  // A different space is a different editor.
  const lastSpace = useRef(space);
  useEffect(() => {
    if (lastSpace.current === space) return;
    lastSpace.current = space;
    setFiles({});
    setConflict(null);
  }, [space]);

  useEffect(() => {
    if (data) setFiles((prev) => mergeServerFiles(prev, data.files));
  }, [data]);

  const fileState = useCallback((file: AppearanceFile) => data?.files.find((f) => f.file === file), [data]);

  // Until the effect above has copied a fresh load into `files`, the server's own text is the value.
  const baseOf = useCallback(
    (file: AppearanceFile) => {
      const stored = fileState(file);
      return files[file]?.base ?? { content: stored?.content ?? '', etag: stored?.etag ?? null };
    },
    [files, fileState],
  );
  const value = useCallback((file: AppearanceFile) => files[file]?.draft ?? baseOf(file).content, [files, baseOf]);
  const dirty = useCallback((file: AppearanceFile) => isDraftDirty(files[file]), [files]);
  const tabDirty = useCallback((tab: SettingsTab) => TAB_FILES[tab].some((file) => isDraftDirty(files[file])), [files]);
  const anyDirty = useMemo(() => Object.values(files).some((entry) => isDraftDirty(entry)), [files]);

  const setValue = useCallback(
    (file: AppearanceFile, content: string) => {
      setFiles((prev) => {
        const stored = data?.files.find((f) => f.file === file);
        return setDraft(prev, file, content, { content: stored?.content ?? '', etag: stored?.etag ?? null });
      });
    },
    [data],
  );

  const filesRef = useRef(files);
  filesRef.current = files;

  const save = useCallback(
    async (tab: SettingsTab): Promise<boolean> => {
      const changes = changesFor(filesRef.current, TAB_FILES[tab]);
      if (changes.length === 0) return true;
      setSaving(tab);
      setConflict(null);
      try {
        const response = await api.putSpaceAppearance(space, { changes });
        // Take the server's word for the new state; if the answer is not the full state, ask for it.
        const next = Array.isArray(response?.files) ? response : await api.getSpaceAppearance(space);
        queryClient.setQueryData(appearanceKey(space), next);
        setFiles((prev) => applySaved(prev, changes, next.files));
        const paths = changes.map((c) => next.files.find((f) => f.file === c.file)?.path ?? fallbackPath(next.contentRoot, c.file));
        const message = `settings: update ${changes.map((c) => `.folio/${c.file}`).join(', ')}`;
        showToast(t('spaceSettings.saved', { paths: paths.join(', '), message }), 'info');
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const theirs = filesFromConflictBody(err.body);
          const differing = changes.filter((c) => theirs.length === 0 || theirs.find((f) => f.file === c.file)?.etag !== c.etag).map((c) => c.file);
          setConflict({ tab, files: differing.length ? differing : changes.map((c) => c.file), theirs });
        } else {
          showToast(errorText(err, 'spaceSettings.saveFailed'));
        }
        return false;
      } finally {
        setSaving(null);
      }
    },
    [space, queryClient, showToast, t, errorText],
  );

  /** The repository's current state: from the 409 body, or (when the body had none) asked for again. */
  const currentFiles = useCallback(async (): Promise<AppearanceFileState[]> => {
    if (conflict && conflict.theirs.length > 0) return conflict.theirs;
    const fresh = await api.getSpaceAppearance(space);
    queryClient.setQueryData(appearanceKey(space), fresh);
    return fresh.files;
  }, [conflict, space, queryClient]);

  const reloadConflict = useCallback(async () => {
    if (!conflict) return;
    try {
      const theirs = await currentFiles();
      const keep = (Object.keys(filesRef.current) as AppearanceFile[]).filter((f) => isDraftDirty(filesRef.current[f]) && !conflict.files.includes(f));
      setFiles((prev) => adoptServerFiles(prev, theirs, keep));
      void queryClient.invalidateQueries({ queryKey: appearanceKey(space) });
      setConflict(null);
    } catch (err) {
      showToast(errorText(err, 'spaceSettings.loadFailed'));
    }
  }, [conflict, currentFiles, queryClient, space, showToast, errorText]);

  const keepMine = useCallback(async () => {
    if (!conflict) return;
    try {
      const theirs = await currentFiles();
      const keep = (Object.keys(filesRef.current) as AppearanceFile[]).filter((f) => isDraftDirty(filesRef.current[f]));
      setFiles((prev) => adoptServerFiles(prev, theirs, keep));
      setConflict(null);
    } catch (err) {
      showToast(errorText(err, 'spaceSettings.loadFailed'));
    }
  }, [conflict, currentFiles, showToast, errorText]);

  const uploadAsset = useCallback(
    async (file: Blob, name: string, replace: boolean) => {
      const info = await api.uploadSpaceAsset(space, file, { name, replace });
      queryClient.setQueryData<SpaceAppearanceResponse>(appearanceKey(space), (prev) =>
        prev ? { ...prev, assets: [...prev.assets.filter((a) => a.name !== info.name), info].sort((a, b) => a.name.localeCompare(b.name)) } : prev,
      );
      return info;
    },
    [space, queryClient],
  );

  const deleteAsset = useCallback(
    async (name: string) => {
      await api.deleteSpaceAsset(space, name);
      queryClient.setQueryData<SpaceAppearanceResponse>(appearanceKey(space), (prev) =>
        prev ? { ...prev, assets: prev.assets.filter((a) => a.name !== name) } : prev,
      );
    },
    [space, queryClient],
  );

  return {
    space,
    query,
    data,
    fileState,
    value,
    setValue,
    dirty,
    tabDirty,
    anyDirty,
    saving,
    save,
    conflict,
    reloadConflict,
    keepMine,
    uploadAsset,
    deleteAsset,
  };
}
