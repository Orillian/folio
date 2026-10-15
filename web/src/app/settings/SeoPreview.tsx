import { Image as ImageIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { truncate } from './appearanceLogic';
import '../i18n/register';

export interface SeoPreviewProps {
  /** Canonical address of the site (for the host line). */
  address: string;
  title: string;
  description: string;
  faviconUrl: string | null;
  ogImageUrl: string | null;
}

function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

/** What the home page looks like in a search result and in a link card, from the values being edited. */
export function SeoPreview({ address, title, description, faviconUrl, ogImageUrl }: SeoPreviewProps) {
  const { t } = useTranslation('app');
  const host = hostOf(address);
  return (
    <div className="grid gap-4 md:grid-cols-2" data-testid="seo-preview">
      <figure>
        <figcaption className="mb-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300">{t('spaceSettings.seo.previewSearch')}</figcaption>
        <div className="rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex items-center gap-2">
            {faviconUrl ? (
              <img src={faviconUrl} alt="" className="h-5 w-5 rounded-full bg-neutral-100 object-contain" />
            ) : (
              <span className="h-5 w-5 rounded-full bg-neutral-200 dark:bg-neutral-700" aria-hidden="true" />
            )}
            <div className="min-w-0 leading-tight">
              <p className="truncate text-xs text-neutral-800 dark:text-neutral-200">{host}</p>
              <p className="truncate text-[11px] text-neutral-500">{address}</p>
            </div>
          </div>
          <p className="mt-1.5 truncate text-lg leading-snug text-[#1a0dab] dark:text-[#8ab4f8]">{truncate(title, 60)}</p>
          <p className="mt-0.5 text-sm leading-snug text-neutral-600 dark:text-neutral-400">{description ? truncate(description, 160) : t('spaceSettings.seo.previewNoDescription')}</p>
        </div>
      </figure>
      <figure>
        <figcaption className="mb-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300">{t('spaceSettings.seo.previewSocial')}</figcaption>
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex aspect-[1.91/1] items-center justify-center bg-neutral-100 text-neutral-400 dark:bg-neutral-800">
            {ogImageUrl ? <img src={ogImageUrl} alt="" className="h-full w-full object-cover" /> : <ImageIcon size={28} aria-label={t('spaceSettings.seo.previewNoImage')} />}
          </div>
          <div className="p-3">
            <p className="text-[11px] uppercase tracking-wide text-neutral-500">{host}</p>
            <p className="mt-0.5 truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">{title}</p>
            {description && <p className="mt-0.5 line-clamp-2 text-xs text-neutral-600 dark:text-neutral-400">{description}</p>}
          </div>
        </div>
      </figure>
    </div>
  );
}
