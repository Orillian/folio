/**
 * Live-mode widget for a ```base fence (Obsidian Bases): the view in place of
 * the YAML, read-only; a click outside a link reveals the source to edit it.
 * The view itself is bases/BaseEmbed (the same one reading mode renders),
 * loaded on demand.
 */
import { lazy, Suspense } from 'react';
import { EditorView, WidgetType } from '@codemirror/view';
import { revealSource } from './editor-services';
import { t } from './i18n';
import { mountReact, unmountReact } from './react-host';

const BaseEmbed = lazy(() => import('../bases/BaseEmbed'));

export class BaseFenceWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly space: string,
    readonly pageId: string,
    readonly lang: string,
  ) {
    super();
  }

  eq(other: BaseFenceWidget): boolean {
    return other.code === this.code && other.space === this.space && other.pageId === this.pageId && other.lang === this.lang;
  }

  get estimatedHeight(): number {
    return 200;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-block cm-md-pagetree cm-md-base';
    wrap.contentEditable = 'false';
    wrap.title = t('base.editHint');
    const host = document.createElement('div');
    host.className = 'cm-md-pagetree__host';
    wrap.appendChild(host);
    mountReact(
      host,
      <Suspense fallback={null}>
        <BaseEmbed source={this.code} space={this.space} pageId={this.pageId || undefined} plainLinks />
      </Suspense>,
    );
    const badge = document.createElement('span');
    badge.className = 'cm-md-pagetree__badge';
    badge.textContent = t('base.badge');
    wrap.appendChild(badge);
    wrap.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest('a, button, input, select')) return; // links, view tabs, "load more"
      event.preventDefault();
      revealSource(view, wrap);
    });
    return wrap;
  }

  destroy(dom: HTMLElement): void {
    const host = dom.querySelector<HTMLElement>('.cm-md-pagetree__host');
    if (host) unmountReact(host);
  }
}
