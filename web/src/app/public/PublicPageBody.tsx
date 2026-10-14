import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { officeFormat, type PageDoc, type PublicSiteInfo } from '@shared/contracts';
import { Markdown } from '../../markdown';
import type { MarkdownPublicSite } from '../../markdown';
import { api } from '../api';
import { StaticBoardView } from '../routes/StaticBoardView';
import { TablePageView } from '../routes/TablePageView';
import { FormPageView } from '../routes/FormPageView';
import { PdfView } from '../routes/PdfView';
import { OfficeView } from '../routes/OfficeView';
import { publicFileUrl, publicHomeUrl, publicPageUrl } from './publicSite';
import '../i18n/register';

/**
 * What <Markdown> needs to render a page of this site. Memoized on the site's identity: Markdown
 * re-renders its whole document when this object changes, so it must stay the same object for
 * the life of the page.
 */
export function useMarkdownPublicSite(site: PublicSiteInfo): MarkdownPublicSite {
  const { space, mode, instanceUrl } = site;
  return useMemo(() => {
    const ref = { space, mode };
    return {
      space,
      pageUrl: (pageId: string) => publicPageUrl(ref, pageId),
      homeUrl: publicHomeUrl(ref),
      resolvePath: async (path: string) => (await api.resolvePublicPath(space, path)).id,
      instanceUrl,
    };
  }, [space, mode, instanceUrl]);
}

export interface PublicPageBodyProps {
  site: PublicSiteInfo;
  page: PageDoc;
}

/**
 * One page of a public site, by kind, built from the same leaf components the share view uses
 * (never Shell/Sidebar/Header — those need a session). Always read-only:
 *   doc    <Markdown> with the `publicSite` option (relative links, images and Folio URLs resolve
 *          to the site; no backlinks, mentions, page tree or form embeds)
 *   table  the live grid as a viewer — the collab socket admits an anonymous viewer of a public
 *          page on its own, so no extra connection parameter
 *   board  the stored SVG, static
 *   form   the form, with sending disabled (that needs a session or a share link)
 *   pdf / office  the file itself from `/files/<space>/<path>`
 */
export function PublicPageBody({ site, page }: PublicPageBodyProps) {
  const { t } = useTranslation('app');
  const markdownSite = useMarkdownPublicSite(site);

  if (page.kind === 'table') {
    return (
      <div className="h-full w-full">
        <TablePageView pageId={page.id} role="viewer" />
      </div>
    );
  }

  if (page.kind === 'form') {
    return (
      <div className="mx-auto w-full max-w-xl">
        <p className="mx-6 mt-6 rounded-md bg-neutral-100 px-3 py-2 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
          {t('publicSite.formReadOnly')}
        </p>
        <FormPageView pageId={page.id} markdown={page.markdown ?? ''} canEdit={false} submitDisabled />
      </div>
    );
  }

  if (page.kind === 'board') {
    return <StaticBoardView svg={page.svg} title={page.title} />;
  }

  if (page.kind === 'pdf') {
    return (
      <div className="h-full">
        <PdfView pageId={page.id} title={page.title} version={page.updatedAt} src={publicFileUrl(page.space, page.path)} />
      </div>
    );
  }

  if (page.kind === 'office') {
    return (
      <div className="h-full">
        <OfficeView
          pageId={page.id}
          title={page.title}
          format={officeFormat(page.path) ?? 'docx'}
          version={page.updatedAt}
          src={publicFileUrl(page.space, page.path)}
        />
      </div>
    );
  }

  return (
    <>
      {page.cover && <img src={page.cover} alt="" className="h-40 w-full object-cover sm:h-52" />}
      {/* No pageId on purpose: Markdown's own contract is that this hides the backlinks section and stops it persisting state per page. */}
      <Markdown markdown={page.markdown ?? ''} space={page.space} pagePath={page.path} publicSite={markdownSite} />
    </>
  );
}
