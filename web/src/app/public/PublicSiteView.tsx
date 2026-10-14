import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Menu as MenuIcon, X } from 'lucide-react';
import type { PublicSiteInfo } from '@shared/contracts';
import { api, ApiError } from '../api';
import { getTopLevelNodes, treeNodeDisplayTitle } from '../sidebar/treeUtils';
import { PublicAssistantSlot } from './PublicAssistantSlot';
import { PublicDownloadMenu } from './PublicDownloadMenu';
import { PublicPageBody } from './PublicPageBody';
import { PublicSearch } from './PublicSearch';
import { PublicTree } from './PublicTree';
import { pathToNode } from './treePaths';
import { PUBLIC_SITE_QUERY_KEY, appPageUrl, publicHomeUrl, publicPageUrl } from './publicSite';
import '../i18n/register';

export interface PublicSiteViewProps {
  site: PublicSiteInfo;
  /** The page in the URL; absent at the site's home, which opens `site.homePageId` (or lists the pages when the space has no home page). */
  pageId?: string;
}

/**
 * The public site's shell: a left column (the space name as the home link, search, the page tree),
 * a main column (breadcrumbs, the page, download / assistant actions) and a footer with the
 * "Powered by Folio" and "Sign in" links. Rendered OUTSIDE <AuthProvider> (see App.tsx), so
 * nothing in it may touch a session: it reads the anonymous /api/public/** routes only and
 * builds every link with publicSite.ts. On a phone the left column folds behind a menu button.
 */
export function PublicSiteView({ site, pageId }: PublicSiteViewProps) {
  const { t } = useTranslation('app');
  const [menuOpen, setMenuOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const effectiveId = pageId ?? site.homePageId ?? undefined;

  const treeQuery = useQuery({
    queryKey: [PUBLIC_SITE_QUERY_KEY, site.space, 'tree'],
    queryFn: () => api.getPublicTree(site.space),
    staleTime: 60_000,
    retry: false,
  });
  const pageQuery = useQuery({
    queryKey: [PUBLIC_SITE_QUERY_KEY, site.space, 'page', effectiveId],
    queryFn: () => api.getPublicPage(site.space, effectiveId!),
    enabled: Boolean(effectiveId),
    retry: false,
  });

  const nodes = useMemo(() => (treeQuery.data ? getTopLevelNodes({ tree: treeQuery.data.tree }) : []), [treeQuery.data]);
  const page = pageQuery.data?.page;
  const spaceName = pageQuery.data?.spaceName ?? site.name;

  // `<page> · <space>`; restored on the way out, like useDocumentTitle does for the app.
  useEffect(() => {
    const original = document.title;
    document.title = page ? `${page.title} · ${spaceName}` : spaceName;
    return () => {
      document.title = original;
    };
  }, [page, spaceName]);

  // The page area is its own scroll container, so moving to another page must not keep the previous page's scroll offset.
  useEffect(() => {
    mainRef.current?.scrollTo?.(0, 0);
  }, [effectiveId]);

  // Closing the drawer on Escape is the one keyboard affordance a modal-ish panel needs.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  // Ancestors of the page on screen, for the breadcrumbs. The home page is the site's root: no trail below the space name.
  const crumbs = useMemo(() => {
    if (!page || page.id === site.homePageId) return [];
    const chain = pathToNode(nodes, page.id);
    if (!chain) return [{ key: page.id, title: page.title, to: undefined as string | undefined, current: true }];
    return chain.map((node, index) => ({
      key: node.id,
      title: treeNodeDisplayTitle(node, index === 0 ? nodes : chain[index - 1].children),
      to: node.kind === 'folder' || node.id === page.id ? undefined : publicPageUrl(site, node.id),
      current: node.id === page.id,
    }));
  }, [page, nodes, site]);

  const pageNotFound = pageQuery.isError && pageQuery.error instanceof ApiError && pageQuery.error.status === 404;

  return (
    <div className="flex h-full min-h-0 bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {menuOpen && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setMenuOpen(false)} aria-hidden="true" />}

      <aside
        className={`${
          menuOpen ? 'fixed inset-y-0 left-0 z-40 flex shadow-xl' : 'hidden'
        } w-72 max-w-[85vw] shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 md:static md:z-auto md:flex md:max-w-none md:shadow-none dark:border-neutral-800 dark:bg-neutral-900`}
      >
        <div className="flex shrink-0 items-center gap-2 px-4 py-3">
          <Link
            to={publicHomeUrl(site)}
            onClick={() => setMenuOpen(false)}
            className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100"
          >
            {site.name}
          </Link>
          <button
            type="button"
            aria-label={t('publicSite.closeMenu')}
            onClick={() => setMenuOpen(false)}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-200/70 md:hidden dark:hover:bg-neutral-800"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-3">
          <PublicSearch site={site} onNavigate={() => setMenuOpen(false)}>
            <div className="px-2">
              {treeQuery.isLoading && <p className="px-1.5 py-2 text-xs text-neutral-400">{t('ui.loading')}</p>}
              {treeQuery.isError && <p className="px-1.5 py-2 text-xs text-red-600 dark:text-red-400">{t('publicSite.treeFailed')}</p>}
              {treeQuery.data && (
                <PublicTree
                  site={site}
                  nodes={nodes}
                  currentId={effectiveId}
                  onNavigate={() => setMenuOpen(false)}
                  ariaLabel={t('publicSite.tree.label')}
                />
              )}
            </div>
          </PublicSearch>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <button
            type="button"
            aria-label={t('publicSite.openMenu')}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
            className="rounded p-1.5 text-neutral-600 hover:bg-neutral-100 md:hidden dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <MenuIcon size={18} aria-hidden="true" />
          </button>
          <nav aria-label={t('publicSite.breadcrumbs')} className="min-w-0 flex-1">
            <ol className="flex min-w-0 items-center gap-1 text-sm text-neutral-500 dark:text-neutral-400">
              <li className="min-w-0 shrink-0 truncate">
                <Link to={publicHomeUrl(site)} className="hover:text-neutral-900 dark:hover:text-neutral-100">
                  {site.name}
                </Link>
              </li>
              {crumbs.map((crumb) => (
                <Fragment key={crumb.key}>
                  <li aria-hidden="true" className="shrink-0">
                    <ChevronRight size={13} />
                  </li>
                  <li className="min-w-0 truncate">
                    {crumb.to ? (
                      <Link to={crumb.to} className="hover:text-neutral-900 dark:hover:text-neutral-100">
                        {crumb.title}
                      </Link>
                    ) : (
                      <span aria-current={crumb.current ? 'page' : undefined} className={crumb.current ? 'font-medium text-neutral-900 dark:text-neutral-100' : undefined}>
                        {crumb.title}
                      </span>
                    )}
                  </li>
                </Fragment>
              ))}
            </ol>
          </nav>
          <div className="flex shrink-0 items-center gap-1">
            {site.allowDownload && page && page.kind !== 'folder' && (
              <PublicDownloadMenu space={site.space} pageId={page.id} pagePath={page.path} title={page.title} />
            )}
            {site.allowAssistant && <PublicAssistantSlot site={site} pageId={effectiveId} />}
          </div>
        </header>

        <main ref={mainRef} className="min-h-0 flex-1 overflow-auto">
          {pageQuery.isLoading && <div className="p-8 text-sm text-neutral-400">{t('ui.loading')}</div>}
          {pageNotFound && (
            <div className="p-8 text-sm text-neutral-500 dark:text-neutral-400">
              <p>{t('publicSite.pageNotFound')}</p>
              <Link to={publicHomeUrl(site)} className="mt-2 inline-block text-blue-600 underline underline-offset-2 dark:text-blue-400">
                {t('publicSite.backHome')}
              </Link>
            </div>
          )}
          {pageQuery.isError && !pageNotFound && (
            <div className="p-8 text-sm text-red-600 dark:text-red-400">{t('publicSite.loadFailed')}</div>
          )}
          {page && <PublicPageBody site={site} page={page} />}
          {!effectiveId && (
            <div className="mx-auto max-w-2xl px-6 py-10">
              <h1 className="mb-4 text-2xl font-semibold tracking-tight">{site.name}</h1>
              {treeQuery.isLoading && <p className="text-sm text-neutral-400">{t('ui.loading')}</p>}
              {treeQuery.data && nodes.length === 0 && <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('publicSite.empty')}</p>}
              {treeQuery.data && nodes.length > 0 && (
                <PublicTree site={site} nodes={nodes} defaultOpen="all" ariaLabel={t('publicSite.index.label')} />
              )}
            </div>
          )}
        </main>

        <footer className="flex shrink-0 items-center gap-3 border-t border-neutral-200 px-4 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          <a href={site.instanceUrl} target="_blank" rel="noopener" className="hover:text-neutral-800 dark:hover:text-neutral-200">
            {t('publicSite.poweredBy')}
          </a>
          <a href={appPageUrl(site, effectiveId)} className="ml-auto hover:text-neutral-800 dark:hover:text-neutral-200">
            {t('publicSite.signIn')}
          </a>
        </footer>
      </div>
    </div>
  );
}
