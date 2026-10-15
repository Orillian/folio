/**
 * Live CSS preview: the draft `site.css` is injected into the same-origin iframe that shows the
 * public site. The saved stylesheet of the site (its `<link … /site.css?v=…>`) is switched off
 * while the draft is shown — the draft is the whole file, not a layer on top of it — and the
 * preview `<style>` is kept last in `<head>`, so nothing the site adds after the iframe's `load`
 * (the SPA mounts later) can outrank it.
 */
export const PREVIEW_STYLE_ID = 'folio-site-css-preview';

/** Idempotent: calling it again with the same CSS changes nothing in the document. */
export function syncPreviewStyle(doc: Document, css: string): void {
  const head = doc.head;
  if (!head) return;
  let style = doc.getElementById(PREVIEW_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement('style');
    style.id = PREVIEW_STYLE_ID;
  }
  if (style.textContent !== css) style.textContent = css;
  doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href*="/site.css"]').forEach((link) => {
    if (!link.disabled) link.disabled = true;
  });
  if (head.lastElementChild !== style) head.appendChild(style);
}

/**
 * Applies the CSS now and again whenever the iframe's document adds something to `<head>`.
 * Returns the function that stops watching.
 */
export function watchPreviewDocument(doc: Document, getCss: () => string): () => void {
  syncPreviewStyle(doc, getCss());
  if (!doc.head || typeof MutationObserver === 'undefined') return () => {};
  const view = doc.defaultView as (Window & typeof globalThis) | null;
  const Observer = view?.MutationObserver ?? MutationObserver;
  const observer = new Observer(() => syncPreviewStyle(doc, getCss()));
  observer.observe(doc.head, { childList: true });
  return () => observer.disconnect();
}
