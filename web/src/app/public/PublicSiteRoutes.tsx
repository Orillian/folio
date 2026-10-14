import { useMemo } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PUBLIC_SITE_PATH_PREFIX, type PublicSiteInfo } from '@shared/contracts';
import { api, ApiError } from '../api';
import { PublicNotPublic } from './PublicNotPublic';
import { PublicSiteView } from './PublicSiteView';
import { publicSiteInfoKey } from './publicSite';
import '../i18n/register';

/**
 * The public site's route tables. Both are mounted by App.tsx's AppRoutes OUTSIDE <AuthProvider> (a
 * visitor has no session, and AuthProvider would put a login screen in front of everything):
 *
 *   path mode   (the instance's own host, any path under `/public/`)
 *     /public/:space              the site's home
 *     /public/:space/p/:id        a page
 *
 *   host mode   (a subdomain / custom domain; index.html carries the slug in a meta tag)
 *     /                           the home
 *     /p/:id                      a page
 *     /public/<slug>/…  and  /s/<slug>[/p/:id]   redirected to the two above, so a link copied
 *                                 from the main host or from inside the app keeps working here
 *
 * Both render the SAME <PublicSiteView>; only the URLs it builds differ (publicSite.ts).
 */
export function PublicPathRoutes() {
  return (
    <Routes>
      <Route path={`${PUBLIC_SITE_PATH_PREFIX}/:space`} element={<PathSite />} />
      <Route path={`${PUBLIC_SITE_PATH_PREFIX}/:space/p/:id`} element={<PathSite />} />
      {/* `/public` alone, or anything else under it: there is no site to show. */}
      <Route path="*" element={<PublicNotPublic reason="not-public" signInHref="/" />} />
    </Routes>
  );
}

function PathSite() {
  const { space, id } = useParams<{ space: string; id?: string }>();
  return <PublicSiteLoader mode="path" slug={space!} pageId={id} />;
}

export function PublicHostRoutes({ slug }: { slug: string }) {
  return (
    <Routes>
      {/* Same element type for both, as in path mode: home ↔ page then only swaps the page body, and the site view (the Ask panel's unsent draft, the search box) stays mounted. */}
      <Route path="/" element={<HostPage slug={slug} />} />
      <Route path="/p/:id" element={<HostPage slug={slug} />} />
      <Route path={`${PUBLIC_SITE_PATH_PREFIX}/:space/*`} element={<HostPathRedirect slug={slug} />} />
      <Route path="/s/:space" element={<HostAppRedirect slug={slug} />} />
      <Route path="/s/:space/p/:id" element={<HostAppRedirect slug={slug} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function HostPage({ slug }: { slug: string }) {
  const { id } = useParams<{ id?: string }>();
  return <PublicSiteLoader mode="host" slug={slug} pageId={id} />;
}

/** `/public/<slug>/p/<id>` → `/p/<id>`, `/public/<slug>` → `/` (query and hash kept). Another space's path has no place on this host. */
function HostPathRedirect({ slug }: { slug: string }) {
  const { space, '*': rest } = useParams();
  const location = useLocation();
  if (space !== slug) return <Navigate to="/" replace />;
  return <Navigate to={`/${rest ?? ''}${location.search}${location.hash}`} replace />;
}

/** `/s/<slug>/p/<id>` → `/p/<id>`, `/s/<slug>` → `/`. */
function HostAppRedirect({ slug }: { slug: string }) {
  const { space, id } = useParams<{ space: string; id?: string }>();
  const location = useLocation();
  if (space !== slug) return <Navigate to="/" replace />;
  return <Navigate to={`${id ? `/p/${encodeURIComponent(id)}` : '/'}${location.search}${location.hash}`} replace />;
}

export interface PublicSiteLoaderProps {
  mode: PublicSiteInfo['mode'];
  slug: string;
  pageId?: string;
}

/**
 * Asks the server whether this is a public site, then shows it. A 404 (private space, unpublished,
 * unknown host) is the "not public" page; anything else is a failed load with a retry.
 */
export function PublicSiteLoader({ mode, slug, pageId }: PublicSiteLoaderProps) {
  const { t } = useTranslation('app');
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: publicSiteInfoKey(mode, slug),
    queryFn: () => (mode === 'host' ? api.getPublicSiteByHost() : api.getPublicSite(slug)),
    retry: false,
    staleTime: 60_000,
  });

  // The route knows how it was reached; trust it over the payload so links can never disagree with the URL bar.
  const site = useMemo(() => (data ? { ...data, mode } : undefined), [data, mode]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-white p-4 text-center text-sm text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        {t('ui.loading')}
      </div>
    );
  }
  if (isError || !site) {
    if (error instanceof ApiError && error.status === 404) {
      // On the instance's own host the same space inside the app is one click away; a site's own host has no app to sign in to (the footer link comes from the site info, which we do not have).
      return <PublicNotPublic reason="not-public" signInHref={mode === 'path' ? `/s/${encodeURIComponent(slug)}?signin=1` : undefined} />;
    }
    return <PublicNotPublic reason="load-failed" onRetry={() => void refetch()} />;
  }
  return <PublicSiteView site={site} pageId={pageId} />;
}
