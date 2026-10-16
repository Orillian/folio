/**
 * `/s/:space/graph` — the space's graph on a full canvas (lazy route chunk:
 * d3-force and the canvas code load only here and in the page panel).
 * `?page=<id>` turns it into that page's local graph (depth 1..3, direction),
 * the full-size version of the panel next to a page's outline.
 *
 * Data: one request (GET /graph with tag, file and ghost nodes), filtered and
 * coloured in the browser (graphModel.ts), so a toggle or a search never
 * refetches. Settings are remembered per space (graphSettings.ts).
 */
import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Maximize, Minus, Plus, SlidersHorizontal, Waypoints } from 'lucide-react';
import type { GraphNodeKind } from '@shared/contracts';
import { api } from '../api';
import { useSetHeaderInfo } from '../Shell';
import { requestSearch } from '../../markdown/searchEvent';
import { GraphCanvas, type GraphCanvasHandle } from './GraphCanvas';
import { GraphControls } from './GraphControls';
import { buildGraphView, isPageNode, type ViewNode } from './graphModel';
import { useGraphSettings } from './graphSettings';
import '../i18n/register';

const iconButton =
  'flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 bg-white/90 text-neutral-600 shadow-sm hover:bg-neutral-50 hover:text-neutral-900 dark:border-neutral-800 dark:bg-neutral-900/90 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-50';

export function GraphPage() {
  const { t } = useTranslation('app');
  const { space = '' } = useParams<{ space: string }>();
  const [params] = useSearchParams();
  const pageId = params.get('page');
  const navigate = useNavigate();
  const [settings, update] = useGraphSettings(space);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [selected, setSelected] = useState<ViewNode | null>(null);
  const canvasRef = useRef<GraphCanvasHandle>(null);

  const { data, error, isLoading } = useQuery({
    queryKey: pageId ? ['page-graph', pageId, settings.depth, settings.direction, settings.showTree] : ['space-graph', space],
    queryFn: () => (pageId ? api.getPageGraph(pageId, settings.depth, settings.direction, settings.showTree) : api.getSpaceGraph(space)),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const centerTitle = pageId ? data?.nodes.find((n) => n.id === pageId)?.title : undefined;
  useSetHeaderInfo({ pagePath: '', title: centerTitle ? t('graph.local.of', { title: centerTitle }) : t('graph.title') });

  const groupsKey = JSON.stringify(settings.groups);
  const view = useMemo(
    () =>
      data
        ? buildGraphView(data, settings, data.center, {
            kind: (k: GraphNodeKind) => t(`graph.kinds.${k}`),
            rootFolder: t('graph.groups.rootFolder'),
            otherSpace: t('graph.groups.otherSpace'),
          })
        : { nodes: [], links: [], legend: [] },
    // Only what changes the view (not the forces or display sliders, which the canvas reads itself).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, settings.search, settings.showTags, settings.showFiles, settings.showUnresolved, settings.showOrphans, settings.showTree, settings.colorBy, groupsKey, settings.sizeByDegree, settings.nodeSize, t],
  );

  const open = (node: ViewNode) => {
    // A page of another space opens in its own space.
    if (isPageNode(node)) navigate(`/s/${encodeURIComponent(node.space ?? space)}/p/${encodeURIComponent(node.id)}`);
    else if (node.kind === 'tag') requestSearch(`tag:${node.id.slice(4)}`);
    else setSelected(node);
  };

  const pageCount = view.nodes.filter(isPageNode).length;
  // Tree edges are structure, not links: the counter names links only.
  const linkCount = view.links.filter((l) => !l.tree).length;

  return (
    <div className="relative h-full min-h-[320px] w-full overflow-hidden bg-neutral-50/60 dark:bg-neutral-950">
      {data && (
        <GraphCanvas
          key={pageId ?? 'space'}
          nodes={view.nodes}
          links={view.links}
          settings={settings}
          onOpen={open}
          onSelect={setSelected}
          selectedId={selected?.id ?? null}
          ariaLabel={t('graph.aria', { nodes: view.nodes.length, links: view.links.length })}
          handleRef={canvasRef}
        />
      )}

      {/* Top-left: what this is, how much of it, and the way back and forth between space and page.
          On a phone it stops short of the zoom / settings buttons (10.5rem) and the counts wrap under the title. */}
      <div className="pointer-events-none absolute left-3 top-3 flex max-w-[calc(100%-10.5rem)] flex-col gap-1 sm:max-w-md">
        <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 bg-white/90 px-2.5 py-1.5 text-xs text-neutral-600 shadow-sm backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/90 dark:text-neutral-300">
          <Waypoints size={14} className="shrink-0 text-indigo-500" aria-hidden="true" />
          <span className="font-medium text-neutral-800 dark:text-neutral-100">{pageId ? t('graph.local.title') : t('graph.title')}</span>
          {data && (
            <span className="tabular-nums text-neutral-400">{t('graph.counts', { pages: pageCount, links: linkCount })}</span>
          )}
          {pageId ? (
            <Link to={`/s/${encodeURIComponent(space)}/graph`} className="text-indigo-600 hover:underline dark:text-indigo-400">
              {t('graph.local.wholeSpace')}
            </Link>
          ) : null}
        </div>
        {data?.truncated && (
          <div role="status" className="pointer-events-auto rounded-lg border border-amber-300 bg-amber-50/95 px-2.5 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/90 dark:text-amber-200">
            {t('graph.truncated', { shown: data.limit, total: data.totalPages })}
          </div>
        )}
        {isLoading && <div className="pointer-events-auto text-xs text-neutral-400">{t('ui.loading')}</div>}
        {error && (
          <div role="alert" className="pointer-events-auto rounded-lg border border-red-300 bg-red-50 px-2.5 py-1.5 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {t('graph.error')}
          </div>
        )}
        {data && view.nodes.length === 0 && <div className="pointer-events-auto text-xs text-neutral-500">{t('graph.empty')}</div>}
      </div>

      {/* Top-right: settings and zoom. */}
      <div className="pointer-events-none absolute right-3 top-3 flex max-h-[calc(100%-1.5rem)] w-72 max-w-[calc(100%-1.5rem)] flex-col items-end gap-2">
        <div className="pointer-events-auto flex gap-1">
          <button type="button" className={iconButton} onClick={() => canvasRef.current?.zoomBy(1.3)} aria-label={t('graph.zoomIn')} title={t('graph.zoomIn')}>
            <Plus size={15} />
          </button>
          <button type="button" className={iconButton} onClick={() => canvasRef.current?.zoomBy(1 / 1.3)} aria-label={t('graph.zoomOut')} title={t('graph.zoomOut')}>
            <Minus size={15} />
          </button>
          <button type="button" className={iconButton} onClick={() => canvasRef.current?.fit()} aria-label={t('graph.fit')} title={t('graph.fit')}>
            <Maximize size={15} />
          </button>
          <button
            type="button"
            className={`${iconButton} ${controlsOpen ? 'ring-2 ring-indigo-400/60' : ''}`}
            onClick={() => setControlsOpen((v) => !v)}
            aria-expanded={controlsOpen}
            aria-label={t('graph.settings')}
            title={t('graph.settings')}
          >
            <SlidersHorizontal size={15} />
          </button>
        </div>
        {controlsOpen && (
          <div className="pointer-events-auto min-h-0 w-full">
            <GraphControls settings={settings} onChange={update} local={!!pageId} onClose={() => setControlsOpen(false)} />
          </div>
        )}
      </div>

      {/* Bottom-left: legend; a click shows only that group. */}
      {view.legend.length > 0 && (
        <div className="absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-1 sm:max-w-xl">
          {view.legend.map((entry) => {
            const active = !!entry.query && settings.search.trim() === entry.query;
            return (
              <button
                key={`${entry.label}-${entry.color}`}
                type="button"
                disabled={!entry.query}
                onClick={() => entry.query && update({ search: active ? '' : entry.query })}
                title={entry.query ? t('graph.legendFilter', { query: entry.query }) : undefined}
                className={`flex items-center gap-1.5 rounded-full border bg-white/90 px-2 py-0.5 text-[11px] text-neutral-700 shadow-sm backdrop-blur enabled:hover:bg-white dark:bg-neutral-900/90 dark:text-neutral-300 dark:enabled:hover:bg-neutral-800 ${
                  active ? 'border-indigo-400' : 'border-neutral-200 dark:border-neutral-800'
                }`}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: entry.color }} aria-hidden="true" />
                <span className="max-w-40 truncate">{entry.label}</span>
                <span className="tabular-nums text-neutral-400">{entry.count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Touch: the tapped node, with the way to open it. */}
      {selected && (
        <div className="absolute inset-x-3 bottom-12 mx-auto flex max-w-sm items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: selected.color }} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-neutral-800 dark:text-neutral-100" title={selected.path}>
            {selected.title}
          </span>
          {(isPageNode(selected) || selected.kind === 'tag') && (
            <button type="button" onClick={() => open(selected)} className="shrink-0 rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500">
              {isPageNode(selected) ? t('graph.open') : t('graph.searchTag')}
            </button>
          )}
          {isPageNode(selected) && (
            <Link
              to={`/s/${encodeURIComponent(selected.space ?? space)}/graph?page=${encodeURIComponent(selected.id)}`}
              onClick={() => setSelected(null)}
              className="shrink-0 rounded px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/50"
            >
              {t('graph.local.short')}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
