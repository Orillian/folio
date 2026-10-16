/**
 * "Local graph" beside a page (in the outline panel): the page and its
 * neighbours, depth 1 by default (1–3 here, remembered per space with the rest
 * of the graph settings, which also filter and colour it). The canvas and
 * d3-force load lazily, only once the section is open; the expand button opens
 * the same neighbourhood full size (`/s/<space>/graph?page=<id>`).
 *
 * 16.10.2026 (owner): the depth buttons carry a visible "Depth" label and a
 * tooltip each (1 — direct links, 2 — through one page, 3 — through two); the
 * header collapses the section like a disclosure, remembered globally (not per
 * page); with "Tree structure" on (the default) the page's parent and children
 * — and its siblings at depth 2 — are neighbours too, so a page without links
 * still shows its place; pages of other spaces it links with appear, labelled
 * with their space. The empty state says how to get links, and only shows when
 * there is no neighbour at all.
 */
import { lazy, Suspense, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { ChevronDown, ChevronRight, ChevronsRight, Maximize2 } from 'lucide-react';
import type { GraphNodeKind } from '@shared/contracts';
import { api } from '../api';
import { useLocalStorage } from '../hooks';
import { requestSearch } from '../../markdown/searchEvent';
import { buildGraphView, isPageNode, type ViewNode } from './graphModel';
import { useGraphSettings } from './graphSettings';
import '../i18n/register';

/** Global (not per page or space): whether the section's body is collapsed. */
export const LOCAL_GRAPH_COLLAPSED_KEY = 'folio:local-graph-collapsed';

const GraphCanvas = lazy(() => import('./GraphCanvas').then((m) => ({ default: m.GraphCanvas })));

export interface LocalGraphSectionProps {
  space: string;
  pageId: string;
  variant: 'docked' | 'mobile';
  onHide?: () => void;
  /** After a node was opened (the mobile drawer closes itself). */
  onNavigate?: () => void;
}

export function LocalGraphSection({ space, pageId, variant, onHide, onNavigate }: LocalGraphSectionProps) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const [settings, update] = useGraphSettings(space);
  const [collapsed, setCollapsed] = useLocalStorage<boolean>(LOCAL_GRAPH_COLLAPSED_KEY, false);
  const { data, error } = useQuery({
    queryKey: ['page-graph', pageId, settings.depth, settings.direction, settings.showTree],
    queryFn: () => api.getPageGraph(pageId, settings.depth, settings.direction, settings.showTree),
    enabled: !collapsed,
    staleTime: 30_000,
    retry: false,
    placeholderData: (prev) => (prev?.center === pageId ? prev : undefined),
  });
  const groupsKey = JSON.stringify(settings.groups);
  const view = useMemo(
    () =>
      data
        ? buildGraphView(data, settings, data.center, {
            kind: (k: GraphNodeKind) => t(`graph.kinds.${k}`),
            rootFolder: t('graph.groups.rootFolder'),
            otherSpace: t('graph.groups.otherSpace'),
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, settings.search, settings.showTags, settings.showFiles, settings.showUnresolved, settings.showOrphans, settings.showTree, settings.colorBy, groupsKey, settings.sizeByDegree, settings.nodeSize, t],
  );

  const open = (node: ViewNode) => {
    if (isPageNode(node)) {
      // A page of another space opens in its own space.
      if (node.id !== pageId) navigate(`/s/${encodeURIComponent(node.space ?? space)}/p/${encodeURIComponent(node.id)}`);
      onNavigate?.();
    } else if (node.kind === 'tag') requestSearch(`tag:${node.id.slice(4)}`);
  };

  const neighbours = view ? view.nodes.filter((n) => isPageNode(n) && n.id !== pageId).length : 0;

  return (
    <section aria-label={t('graph.local.title')} className={variant === 'docked' ? 'mb-3' : 'mt-3'}>
      <div className="mb-1 flex items-center gap-1 px-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          title={collapsed ? t('graph.local.expandSection') : t('graph.local.collapse')}
          className="-ml-1 flex min-w-0 flex-1 items-center gap-0.5 rounded px-1 py-0.5 text-xs font-medium text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          {collapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
          <span className="truncate">{t('graph.local.title')}</span>
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => {
              navigate(`/s/${encodeURIComponent(space)}/graph?page=${encodeURIComponent(pageId)}`);
              onNavigate?.();
            }}
            aria-label={t('graph.local.expand')}
            title={t('graph.local.expand')}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <Maximize2 size={12} />
          </button>
          {onHide && (
            <button
              type="button"
              onClick={onHide}
              aria-label={t('graph.local.hide')}
              title={t('graph.local.hide')}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              <ChevronsRight size={14} />
            </button>
          )}
        </div>
      </div>
      {!collapsed && (
        <div className="mb-1 flex items-center gap-0.5 px-1.5" role="group" aria-label={t('graph.local.depth')}>
          <span className="mr-0.5 text-[11px] text-neutral-400 dark:text-neutral-500" aria-hidden="true">
            {t('graph.local.depth')}
          </span>
          {[1, 2, 3].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => update({ depth: d })}
              aria-pressed={settings.depth === d}
              aria-label={t(`graph.local.depthHint${d}`)}
              title={t(`graph.local.depthHint${d}`)}
              className={`h-5 w-5 rounded text-[11px] tabular-nums ${
                settings.depth === d
                  ? 'bg-neutral-200 font-semibold text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      )}
      {!collapsed && (
        <div className={`relative overflow-hidden rounded-md border border-neutral-200 bg-neutral-50/60 dark:border-neutral-800 dark:bg-neutral-900/40 ${variant === 'docked' ? 'h-48' : 'h-56'}`}>
          {view && view.nodes.length > 0 ? (
            <Suspense fallback={null}>
              <GraphCanvas
                key={pageId}
                nodes={view.nodes}
                links={view.links}
                settings={settings}
                onOpen={open}
                onSelect={(n) => n && open(n)}
                compact
                ariaLabel={t('graph.aria', { nodes: view.nodes.length, links: view.links.length })}
              />
            </Suspense>
          ) : (
            <div className="flex h-full items-center justify-center px-3 text-center text-[11px] text-neutral-400">{error ? t('graph.error') : data ? t('graph.local.none') : t('ui.loading')}</div>
          )}
          {view && neighbours === 0 && view.nodes.length > 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-1 px-3 text-center text-[11px] text-neutral-400">{t('graph.local.none')}</div>
          )}
        </div>
      )}
    </section>
  );
}
