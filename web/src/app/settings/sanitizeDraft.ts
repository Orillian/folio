/**
 * The draft `site.css` run through the same sanitizer the server applies when it serves the file
 * (shared/siteCss.ts), so the preview shows what visitors will get and the warnings are the ones
 * the server will report after saving. Asset references are rewritten to the site-assets route
 * of this space, exactly as on the public site.
 */
import { sanitizeSiteCss, type SanitizedSiteCss } from '@shared/siteCss';

export function sanitizeDraftCss(css: string, space: string): SanitizedSiteCss {
  return sanitizeSiteCss(css, { assetUrl: (name) => `/api/public/spaces/${encodeURIComponent(space)}/site-assets/${encodeURIComponent(name)}` });
}
