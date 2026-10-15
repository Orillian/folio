// @vitest-environment jsdom
/**
 * The CSS preview: the draft goes into the public site's own document as a <style> that is always
 * the last thing in <head>, and the saved site.css link is switched off while the draft is shown.
 */
import { describe, expect, it } from 'vitest';
import { PREVIEW_STYLE_ID, syncPreviewStyle, watchPreviewDocument } from './previewCss';

function siteDocument(): Document {
  const doc = document.implementation.createHTMLDocument('site');
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/api/public/spaces/docs/site.css?v=abc';
  doc.head.appendChild(link);
  return doc;
}

describe('syncPreviewStyle', () => {
  it('injects the draft once, last in <head>, and turns the saved stylesheet off', () => {
    const doc = siteDocument();
    syncPreviewStyle(doc, 'body { color: red }');
    syncPreviewStyle(doc, 'body { color: red }');
    expect(doc.querySelectorAll(`#${PREVIEW_STYLE_ID}`)).toHaveLength(1);
    expect(doc.head.lastElementChild?.id).toBe(PREVIEW_STYLE_ID);
    expect(doc.head.lastElementChild?.textContent).toBe('body { color: red }');
    expect(doc.querySelector<HTMLLinkElement>('link[rel=stylesheet]')?.disabled).toBe(true);

    syncPreviewStyle(doc, 'body { color: blue }');
    expect(doc.getElementById(PREVIEW_STYLE_ID)?.textContent).toBe('body { color: blue }');
  });

  it('wins over a stylesheet the site adds after the preview was injected', async () => {
    const doc = document.implementation.createHTMLDocument('site');
    const stop = watchPreviewDocument(doc, () => 'h1 { margin: 0 }');
    const late = doc.createElement('link');
    late.rel = 'stylesheet';
    late.href = '/api/public/spaces/docs/site.css?v=late';
    doc.head.appendChild(late);
    await new Promise((resolve) => setTimeout(resolve, 0)); // MutationObserver callbacks run as microtasks

    expect(doc.head.lastElementChild?.id).toBe(PREVIEW_STYLE_ID);
    expect(late.disabled).toBe(true);
    stop();
  });
});
