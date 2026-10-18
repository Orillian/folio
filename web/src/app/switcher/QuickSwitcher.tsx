import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Bookmark, BookmarkPlus, CircleHelp, ClipboardList, Clock, FileSpreadsheet, FileText, FileType2, Folder, LayoutDashboard, RefreshCw, Search, SunMoon, Table2, Waypoints, X, Database } from 'lucide-react';
import type { PageKind, SavedSearch, SearchHit } from '@shared/contracts';
import { isEmptySearchQuery, parseSearchQuery } from '@shared/searchQuery';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { newPageTitleKey } from '../sidebar/slugUtils';
import { useDebouncedValue } from '../hooks';
import { useSpaceRole } from '../auth/AuthProvider';
import { canEditContent, canManageMembers } from '../auth/roles';
import { cycleThemeMode, useSettings } from '../settings';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { OfflineUnsupportedError, createPageOfflineAware } from '../offline/createPage';
import { useRecents } from '../recents';
import type { RecentPage } from '../recents';
import { HelpModal } from '../help/HelpModal';
import { SaveSearchDialog } from './SaveSearchDialog';
// Obsidian Bases: "Save as base" (lazy: the YAML writer stays out of the main chunk).
const SaveAsBaseDialog = lazy(() => import('../../bases/SaveAsBaseDialog'));
// "New base": name + location dialog instead of a blind create.
import { NewBaseDialog, preloadNewBaseDialog } from '../../bases/lazyNewBase';
import { SEARCH_OPERATORS, insertOperator } from './searchOperators';
import type { SearchOperator } from './searchOperators';
import { fuzzyFilter } from './fuzzy';
import { track } from '../../analytics';
import '../i18n/register';

export interface QuickSwitcherProps {
  /** Current space — scopes new-page/new-board/sync actions and the search API call (search, unlike recents, isn't cross-space; see api.search). */
  space: string;
  /** What the input starts with: `tag:<tag>` when a `#tag` chip in a page or the sidebar's Tags section opens the switcher. Empty for Cmd+K. */
  initialQuery?: string;
  onClose: () => void;
}

interface SwitcherAction {
  id: string;
  label: string;
  icon: ReactNode;
  run: () => void;
}

type Entry =
  | { kind: 'saved'; key: string; search: SavedSearch; run: () => void }
  | { kind: 'recent'; key: string; label: string; icon?: string; go: () => void }
  | { kind: 'hit'; key: string; hit: SearchHit; go: () => void }
  | { kind: 'save-search'; key: string; run: () => void }
  | { kind: 'save-base'; key: string; run: () => void }
  | { kind: 'action'; key: string; label: string; icon: ReactNode; run: () => void };

/** The icon of a search hit by page kind; a server that predates `kind` on hits gets the plain page icon. */
function KindIcon({ kind }: { kind: PageKind | undefined }) {
  const props = { size: 14, className: 'mt-0.5 shrink-0 opacity-60', 'aria-hidden': true } as const;
  switch (kind) {
    case 'table':
      return <Table2 {...props} />;
    case 'board':
      return <LayoutDashboard {...props} />;
    case 'form':
      return <ClipboardList {...props} />;
    case 'pdf':
      return <FileType2 {...props} />;
    case 'office':
      return <FileSpreadsheet {...props} />;
    case 'canvas':
      return <Waypoints {...props} />;
    case 'base':
      return <Database {...props} />;
    case 'folder':
      return <Folder {...props} />;
    default:
      return <FileText {...props} />;
  }
}

/**
 * Cmd+K quick switcher: one modal combining recent pages (cross-space,
 * localStorage), a debounced search against the current space, and a short
 * list of role-gated actions — all three fuzzy-filtered by the same query
 * (recents/actions client-side via fuzzy.ts, search results server-side).
 * Replaces the old always-open header search dropdown; SearchBox.tsx is now
 * just this modal's entry point (see DEV-PLAN Round 5).
 *
 * Not portaled to document.body, matching ui/Modal.tsx's own convention —
 * Shell's root only has `overflow-hidden` (no transform/filter/contain), so
 * a `position: fixed` overlay isn't clipped by it regardless of DOM depth.
 */
export function QuickSwitcher({ space, initialQuery = '', onClose }: QuickSwitcherProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const navigate = useNavigate();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const role = useSpaceRole(space);
  const { theme, setTheme } = useSettings();

  const [query, setQuery] = useState(initialQuery);
  // Where the search runs: this space, or — after running a saved search — the space it was pinned to ('' = every space).
  const [searchSpace, setSearchSpace] = useState(space);
  const [saving, setSaving] = useState(false);
  const [savingBase, setSavingBase] = useState(false);
  const [creatingBase, setCreatingBase] = useState(false);
  // The switcher is mounted only while open: warm up the "New base" dialog's chunk for its action.
  useEffect(() => {
    void preloadNewBaseDialog().catch(() => undefined);
  }, []);
  const [deleting, setDeleting] = useState<SavedSearch | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // Round 6 addendum: stacks on top of the switcher itself (same z-50 as
  // this dialog's own backdrop, later in DOM order so it paints over it)
  // rather than closing the switcher first — closing help leaves you back
  // in an still-open switcher, ready to keep searching.
  const [helpOpen, setHelpOpen] = useState(false);
  const debounced = useDebouncedValue(query, 200);
  const trimmed = debounced.trim();
  // The results belong to what is in the box NOW: once it is emptied, the debounce (200 ms) must not keep the last hits on screen.
  const hasQuery = trimmed !== '' && query.trim() !== '';
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [recents, setRecents] = useRecents();
  const recentValidation = useQuery({
    queryKey: ['recents', 'valid', recents.map((r) => `${r.space}:${r.id}`).join('|')],
    queryFn: () => api.validateRecentPages({ pages: recents.map((r) => ({ space: r.space, id: r.id })) }),
    enabled: recents.length > 0,
    retry: false,
  });
  const validRecentKeys = useMemo(() => new Set(recentValidation.data?.valid ?? []), [recentValidation.data]);

  useEffect(() => {
    if (!recentValidation.data) return;
    setRecents((previous) => {
      const next = previous.filter((r) => validRecentKeys.has(`${r.space}:${r.id}`));
      return next.length === previous.length ? previous : next;
    });
  }, [recentValidation.data, setRecents, validRecentKeys]);

  const { data: searchData, isFetching: searching } = useQuery({
    queryKey: ['search', searchSpace, trimmed],
    queryFn: () => api.search(trimmed, searchSpace),
    enabled: trimmed.length > 0,
  });

  // Saved searches (Obsidian wave 3): a short per-user list, fetched once. A server without the route just shows none.
  const { data: savedData } = useQuery({
    queryKey: ['saved-searches'],
    queryFn: api.listSavedSearches,
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Opened with a query already in it (a tag from the sidebar): the caret goes after it, ready to refine.
    input.setSelectionRange(input.value.length, input.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Optional analytics: one `search` event per use of the switcher, when it closes, with only whether the last
  // finished search found anything. Never the words typed.
  const lastSearch = useRef<boolean | null>(null);
  useEffect(() => {
    if (trimmed && searchData) lastSearch.current = searchData.hits.length > 0;
  }, [trimmed, searchData]);
  useEffect(
    () => () => {
      if (lastSearch.current !== null) track('search', { has_results: lastSearch.current });
    },
    [],
  );

  function go(to: string) {
    onClose();
    navigate(to);
  }

  // Round 26 (DATA TABLES): `PageKind` rather than the old hardcoded
  // `'doc' | 'board'` — a third creatable kind now exists, and the union was
  // the only thing keeping it out of Cmd+K.
  const createPage = useMutation({
    // React Query pauses a mutation while the browser says it is offline
    // (networkMode 'online', the default) — which is exactly when this one
    // has to run: it is what creates the page on this device.
    networkMode: 'always',
    mutationFn: (kind: PageKind) =>
      createPageOfflineAware(queryClient, {
        space,
        parentPath: '',
        title: t(newPageTitleKey(kind)),
        kind,
      }),
    onSuccess: ({ page, local }) => {
      if (local) showToast(t('offline.createdLocally'), 'info');
      else queryClient.invalidateQueries({ queryKey: ['tree', space] });
      go(`/s/${space}/p/${page.id}`);
    },
    onError: (err) =>
      showToast(err instanceof OfflineUnsupportedError ? t('offline.unsupportedKind') : errorText(err, 'sidebar.createPageFailed')),
  });

  const sync = useMutation({
    mutationFn: () => api.syncSpace(space),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['spaces'] }),
    onSuccess: (result) => {
      onClose();
      if (result.git.status === 'error' || result.git.status === 'conflict') {
        showToast(result.git.lastError ?? t('sidebar.syncFailed'));
      } else {
        showToast(t('admin.spaces.syncComplete'), 'info');
      }
    },
    onError: (err) => showToast(errorText(err, 'sidebar.syncFailed')),
  });

  const deleteSaved = useMutation({
    mutationFn: (id: string) => api.deleteSavedSearch(id),
    onSuccess: () => {
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: ['saved-searches'] });
    },
    onError: (err) => {
      setDeleting(null);
      showToast(errorText(err, 'search.saved.deleteFailed'));
    },
  });

  /** A saved search runs where it was saved: its space, or every space. */
  function runSaved(search: SavedSearch) {
    setSearchSpace(search.space ?? '');
    setQuery(search.query);
    inputRef.current?.focus();
  }

  /** Clicking an operator in the help line types it into the input, keeping the caret where the value goes. */
  function addOperator(operator: SearchOperator) {
    const { query: next, caret } = insertOperator(query, operator);
    setQuery(next);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caret, caret);
    }, 0);
  }

  // Actions always include theme cycling (a personal preference, no
  // permission concept applies); new page/board need editor+, sync mirrors
  // Sidebar.tsx's own gating (admin — canManageMembers, not just editor).
  const actions = useMemo<SwitcherAction[]>(() => {
    const list: SwitcherAction[] = [];
    if (canEditContent(role)) {
      list.push({
        id: 'new-page',
        label: t('switcher.createPage'),
        icon: <FileText size={15} aria-hidden="true" />,
        run: () => createPage.mutate('doc'),
      });
      list.push({
        id: 'new-board',
        label: t('switcher.createBoard'),
        icon: <LayoutDashboard size={15} aria-hidden="true" />,
        run: () => createPage.mutate('board'),
      });
      list.push({
        id: 'new-table',
        label: t('switcher.createTable'),
        icon: <Table2 size={15} aria-hidden="true" />,
        run: () => createPage.mutate('table'),
      });
      list.push({
        id: 'new-form',
        label: t('switcher.createForm'),
        icon: <ClipboardList size={15} aria-hidden="true" />,
        run: () => createPage.mutate('form'),
      });
      list.push({
        id: 'new-base',
        label: t('switcher.createBase'),
        icon: <Database size={15} aria-hidden="true" />,
        run: () => setCreatingBase(true),
      });
    }
    list.push({
      id: 'cycle-theme',
      label: t('switcher.cycleTheme', { theme: t(`settings.theme.${theme}`) }),
      icon: <SunMoon size={15} aria-hidden="true" />,
      run: () => {
        setTheme(cycleThemeMode(theme));
        onClose();
      },
    });
    if (canEditContent(role)) {
      list.push({
        id: 'sync',
        label: t('switcher.syncSpace'),
        icon: <RefreshCw size={15} aria-hidden="true" className={sync.isPending ? 'animate-spin' : undefined} />,
        run: () => sync.mutate(),
      });
    }
    list.push({
      id: 'help',
      label: t('auth.userMenu.help'),
      icon: <CircleHelp size={15} aria-hidden="true" />,
      run: () => setHelpOpen(true),
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, theme, sync.isPending, t]);

  const recentEntries = useMemo<Entry[]>(() => {
    const liveRecents = recentValidation.data ? recents.filter((r) => validRecentKeys.has(`${r.space}:${r.id}`)) : [];
    const filtered = fuzzyFilter(query, liveRecents, (r) => r.title);
    return filtered.map((page: RecentPage) => ({
      kind: 'recent' as const,
      key: `recent:${page.space}:${page.id}`,
      label: page.title,
      icon: page.icon,
      go: () => go(`/s/${page.space}/p/${page.id}`),
    }));
  }, [query, recents, recentValidation.data, validRecentKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  const hitEntries = useMemo<Entry[]>(() => {
    if (!hasQuery) return [];
    return (searchData?.hits ?? []).map((hit: SearchHit) => ({
      kind: 'hit' as const,
      key: `hit:${hit.id}`,
      hit,
      go: () => go(`/s/${hit.space}/p/${hit.id}`),
    }));
  }, [hasQuery, searchData]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Save this search…" closes the results group: reachable with the arrow keys like any row.
  const saveEntries = useMemo<Entry[]>(
    // (Not for a query that parses to nothing — only symbols, or operators without a value.)
    () =>
      hasQuery && !isEmptySearchQuery(parseSearchQuery(trimmed))
        ? [
            { kind: 'save-search' as const, key: 'save-search', run: () => setSaving(true) },
            // A base lives in a space: offered in a space, to its editors.
            ...(space && canEditContent(role) ? [{ kind: 'save-base' as const, key: 'save-base', run: () => setSavingBase(true) }] : []),
          ]
        : [],
    [hasQuery, trimmed, space, role],
  );

  // Saved searches lead the list while nothing is typed.
  const savedEntries = useMemo<Entry[]>(() => {
    if (query.trim()) return [];
    return (savedData?.searches ?? []).map((search) => ({ kind: 'saved' as const, key: `saved:${search.id}`, search, run: () => runSaved(search) }));
  }, [query, savedData]); // eslint-disable-line react-hooks/exhaustive-deps

  const actionEntries = useMemo<Entry[]>(() => {
    const filtered = fuzzyFilter(query, actions, (a) => a.label);
    return filtered.map((action) => ({
      kind: 'action' as const,
      key: `action:${action.id}`,
      label: action.label,
      icon: action.icon,
      run: action.run,
    }));
  }, [query, actions]);

  const entries = useMemo(
    () => [...savedEntries, ...recentEntries, ...hitEntries, ...saveEntries, ...actionEntries],
    [savedEntries, recentEntries, hitEntries, saveEntries, actionEntries],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [query, entries.length]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  function activate(entry: Entry | undefined) {
    if (!entry) return;
    if (entry.kind === 'action' || entry.kind === 'saved' || entry.kind === 'save-search' || entry.kind === 'save-base') entry.run();
    else entry.go();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, entries.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activate(entries[activeIndex]);
    } else if (event.key === 'Escape') {
      onClose();
    }
  }

  let renderIndex = -1;

  return (
    <div
      // Round 14: less top offset on <md — 12vh is a big enough chunk of a
      // phone's height to meaningfully shrink the results list below it.
      // Width is already effectively calc(100vw-2rem) via this p-4 + the
      // dialog's own w-full below, with nothing extra needed for that part.
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[6vh] md:pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('switcher.label')}
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
      >
        <div className="flex items-center gap-2 border-b border-neutral-200 px-3.5 py-2.5 dark:border-neutral-700">
          <Search size={16} className="shrink-0 text-neutral-400" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('switcher.placeholder')}
            className="w-full min-w-0 bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
            role="combobox"
            aria-expanded="true"
            aria-controls="folio-switcher-list"
            aria-autocomplete="list"
          />
          {searchSpace !== space && (
            <button
              type="button"
              title={t('search.saved.resetScope')}
              aria-label={t('search.saved.resetScope')}
              onClick={() => setSearchSpace(space)}
              className="flex shrink-0 items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              {searchSpace === '' ? t('search.saved.allSpaces') : searchSpace}
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Search v2: the operators the query understands. Shown while nothing is typed and while the query already has one. */}
        {(!query.trim() || query.includes(':')) && (
          <div
            aria-label={t('search.operators.label')}
            className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-neutral-200 px-3.5 py-1.5 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400"
          >
            <span>{t('search.operators.title')}</span>
            {SEARCH_OPERATORS.map((operator) => (
              <button
                key={operator.id}
                type="button"
                tabIndex={-1}
                title={t(`search.operators.${operator.id}`)}
                // Keep the caret in the input: a click on the help must not steal focus from the field it is editing.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addOperator(operator)}
                className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
              >
                {operator.label}
              </button>
            ))}
          </div>
        )}

        <div ref={listRef} id="folio-switcher-list" role="listbox" className="ph-mask min-h-0 flex-1 overflow-y-auto p-1.5">
          {savedEntries.length > 0 && (
            <Section label={t('search.saved.title')}>
              {savedEntries.map((entry) => {
                renderIndex++;
                if (entry.kind !== 'saved') return null;
                const { search } = entry;
                return (
                  <SavedRow
                    key={entry.key}
                    index={renderIndex}
                    active={renderIndex === activeIndex}
                    name={search.name}
                    query={search.query}
                    scope={search.space === null ? t('search.saved.allSpaces') : search.space !== space ? search.space : undefined}
                    deleteLabel={t('search.saved.delete', { name: search.name })}
                    onActivate={() => activate(entry)}
                    onDelete={() => setDeleting(search)}
                  />
                );
              })}
            </Section>
          )}

          {recentEntries.length > 0 && (
            <Section label={t('switcher.recent')}>
              {recentEntries.map((entry) => {
                renderIndex++;
                return (
                  <Row key={entry.key} index={renderIndex} active={renderIndex === activeIndex} onActivate={() => activate(entry)}>
                    {entry.kind === 'recent' && entry.icon ? (
                      <span aria-hidden="true">{entry.icon}</span>
                    ) : (
                      <Clock size={14} className="opacity-60" aria-hidden="true" />
                    )}
                    <span className="truncate">{entry.kind === 'recent' ? entry.label : ''}</span>
                  </Row>
                );
              })}
            </Section>
          )}

          {hasQuery && (
            <Section label={searching ? t('switcher.searching') : t('switcher.searchResults')}>
              {hitEntries.length === 0 && !searching && (
                <div className="px-2.5 py-2 text-sm text-neutral-400">{t('switcher.noResults', { query: trimmed })}</div>
              )}
              {hitEntries.map((entry) => {
                renderIndex++;
                if (entry.kind !== 'hit') return null;
                const { hit } = entry;
                const tags = hit.tags ?? [];
                return (
                  <Row key={entry.key} index={renderIndex} active={renderIndex === activeIndex} onActivate={() => activate(entry)}>
                    <KindIcon kind={hit.kind} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 truncate">{hit.title}</span>
                        {hit.space !== space && <span className="shrink-0 text-xs text-neutral-400">{hit.space}</span>}
                        {tags.length > 0 && (
                          <span className="ml-auto hidden shrink-0 items-center gap-1 sm:flex">
                            {tags.slice(0, 3).map((tag) => (
                              <span key={tag} className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                                #{tag}
                              </span>
                            ))}
                            {tags.length > 3 && <span className="text-[11px] text-neutral-400">+{tags.length - 3}</span>}
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">{hit.snippet}</span>
                    </span>
                  </Row>
                );
              })}
              {saveEntries.map((entry) => {
                renderIndex++;
                return (
                  <Row key={entry.key} index={renderIndex} active={renderIndex === activeIndex} onActivate={() => activate(entry)}>
                    {entry.kind === 'save-base' ? <Database size={14} className="shrink-0 opacity-60" aria-hidden="true" /> : <BookmarkPlus size={14} className="shrink-0 opacity-60" aria-hidden="true" />}
                    <span className="truncate">{entry.kind === 'save-base' ? t('switcher.saveAsBase') : t('search.saved.save')}</span>
                  </Row>
                );
              })}
            </Section>
          )}

          {actionEntries.length > 0 && (
            <Section label={t('switcher.actions')}>
              {actionEntries.map((entry) => {
                renderIndex++;
                return (
                  <Row key={entry.key} index={renderIndex} active={renderIndex === activeIndex} onActivate={() => activate(entry)}>
                    {entry.kind === 'action' && entry.icon}
                    <span className="truncate">{entry.kind === 'action' ? entry.label : ''}</span>
                  </Row>
                );
              })}
            </Section>
          )}

          {entries.length === 0 && !hasQuery && (
            <div className="px-2.5 py-2 text-sm text-neutral-400">{t('switcher.emptyHint')}</div>
          )}
        </div>
      </div>

      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {saving && (
        <SaveSearchDialog
          query={query.trim()}
          space={searchSpace}
          onClose={() => setSaving(false)}
          onSaved={() => {
            setSaving(false);
            inputRef.current?.focus();
          }}
        />
      )}
      {creatingBase && <NewBaseDialog space={space} initialParentPath="" onClose={() => setCreatingBase(false)} onCreated={onClose} />}
      {savingBase && (
        <Suspense fallback={null}>
          <SaveAsBaseDialog query={query.trim()} space={space} onClose={() => setSavingBase(false)} onCreated={onClose} />
        </Suspense>
      )}
      {deleting && (
        <ConfirmDialog
          title={t('search.saved.deleteTitle')}
          destructive
          busy={deleteSaved.isPending}
          confirmLabel={t('ui.delete')}
          onConfirm={() => deleteSaved.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        >
          <p>{t('search.saved.deleteBody', { name: deleting.name })}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function SavedRow({
  index,
  active,
  name,
  query,
  scope,
  deleteLabel,
  onActivate,
  onDelete,
}: {
  index: number;
  active: boolean;
  name: string;
  query: string;
  /** Where it searches when that is not this space: "All spaces" or another space's slug. */
  scope: string | undefined;
  deleteLabel: string;
  onActivate: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`group flex items-center rounded-md ${active ? 'bg-neutral-100 dark:bg-neutral-800' : ''}`}>
      <button
        type="button"
        role="option"
        aria-selected={active}
        data-index={index}
        onClick={onActivate}
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-sm text-neutral-800 dark:text-neutral-200"
      >
        <Bookmark size={14} className="mt-0.5 shrink-0 opacity-60" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 truncate">{name}</span>
            {scope && <span className="shrink-0 text-xs text-neutral-400">{scope}</span>}
          </span>
          <span className="block truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">{query}</span>
        </span>
      </button>
      <button
        type="button"
        aria-label={deleteLabel}
        title={deleteLabel}
        onClick={onDelete}
        className="mr-1.5 shrink-0 rounded p-1 text-neutral-400 opacity-0 hover:bg-neutral-200 hover:text-neutral-700 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-200 max-md:opacity-100"
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-1 last:mb-0">
      <div className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-neutral-400 dark:text-neutral-500">{label}</div>
      {children}
    </div>
  );
}

function Row({
  index,
  active,
  onActivate,
  children,
}: {
  index: number;
  active: boolean;
  onActivate: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-index={index}
      onClick={onActivate}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-neutral-800 dark:text-neutral-200 ${
        active ? 'bg-neutral-100 dark:bg-neutral-800' : ''
      }`}
    >
      {children}
    </button>
  );
}
