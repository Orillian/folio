import { beforeAll } from 'vitest';
import i18next from 'i18next';
import type { PageLinkRef } from '@shared/contracts';
import { renderMarkdownToHtml, type RenderOptions } from '../pipeline';
import { wikilinkContextFromLinks } from '../wikilinks';
import '../i18n/register';

/** Test helper: the reading pipeline on a fixture, in English. */
export function pinEnglish(): void {
  beforeAll(async () => {
    await i18next.changeLanguage('en');
  });
}

export const baseOptions: RenderOptions = { space: 'eng', pagePath: 'notes/page.md' };

export function render(markdown: string, extra: Partial<RenderOptions> = {}): string {
  return renderMarkdownToHtml(markdown, { ...baseOptions, ...extra });
}

/** A typed link row as GET /api/pages/:id/meta returns it, with the fields a test does not care about filled in. */
export function link(partial: Partial<PageLinkRef> & Pick<PageLinkRef, 'linkPath' | 'syntax' | 'kind'>): PageLinkRef {
  return {
    targetPath: partial.linkPath,
    targetPageId: null,
    fragment: null,
    fragmentKind: null,
    fragmentResolved: null,
    displayText: null,
    line: 1,
    context: '',
    ...partial,
  };
}

export function ready(links: PageLinkRef[]): Pick<RenderOptions, 'wikilinks'> {
  return { wikilinks: wikilinkContextFromLinks(links) };
}

/** The HTML with every code span and block removed - what must contain no raw OFM syntax. */
export function withoutCode(html: string): string {
  return html.replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<code[\s\S]*?<\/code>/g, '');
}
