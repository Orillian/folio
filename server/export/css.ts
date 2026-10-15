/**
 * Round 23 (EXPORT) — the space's own print stylesheet and running
 * headers/footers, read from its git repo.
 *
 * Since 14.10.2026 they live in the space's `.folio/` folder (export.css,
 * pdf-header.html, pdf-footer.html, images in .folio/assets/ — see
 * server/spaceAppearance.ts); the legacy places (`<slug>.export.css`, the
 * `export` section of `<slug>.folio`) are read per file when `.folio/` has no
 * such file, until the first save of the PDF settings moves them.
 *
 * DEV-PLAN, verbatim and non-negotiable: "Export CSS — `<slug>.export.css`
 * in the root of the space's repository, applied ONLY to the PDF/print
 * render. Security: strip @import and url() to external hosts (SSRF from a
 * headless browser), limit the file size."
 *
 * WHY THIS IS A SECURITY BOUNDARY, not styling hygiene: the file is authored
 * by whoever can write to the space's repo, and it is then handed to a
 * headless browser running INSIDE our network. `@import url(http://169.254.169.254/…)`
 * or `background: url(http://10.0.0.5/admin)` is a server-side request
 * forgery primitive with a side channel (whether the style applied), and
 * `url(file:///etc/passwd)` is a read primitive. So:
 *
 *   1. comments are stripped FIRST (they are the classic place to hide a
 *      second payload from a naive regex);
 *   2. every `@import` at-rule is removed outright — there is no such thing
 *      as a safe one here, since even a same-origin import would be a fetch;
 *   3. every `url()` whose target carries a SCHEME (`http:`, `https:`,
 *      `file:`, `ftp:`, anything) or is protocol-relative (`//host/…`) is
 *      replaced with `none`. `data:` URIs survive — they are inline bytes,
 *      not a request — and so do scheme-less relative paths, which cannot
 *      name a foreign host and which the renderer blocks at the network
 *      layer anyway (see print.ts's request interception);
 *   4. `</…` sequences are removed so the file cannot terminate the `<style>`
 *      element it is injected into and become HTML;
 *   5. the file is capped at MAX_EXPORT_CSS_BYTES.
 *
 * Defence in depth, deliberate: even with all of the above, the print page
 * itself blocks every non-`data:` request at the CDP level. Either layer
 * alone would do; both together mean a regex miss is not a breach.
 */
import { PDF_CHROME_MAX_BYTES, SITE_ASSETS_MAX_TOTAL_BYTES } from '../../shared/contracts.js';
import { inlineAssetImages, inlineAssetUrlsInCss, readPdfChromeSource } from '../spaceAppearance.js';

/** 256 KB. A print stylesheet an order of magnitude bigger than this is not a stylesheet. */
export const MAX_EXPORT_CSS_BYTES = 256 * 1024;

const IMPORT_RE = /@import\b[^;{]*(;|(?=\{))/gi;
const COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/** True for a `url()` target that could reach off-box: any scheme except `data:`, or protocol-relative. */
function isExternalUrlTarget(raw: string): boolean {
  const target = raw.trim();
  if (target.startsWith('//')) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target);
  if (!scheme) return false;
  return scheme[1].toLowerCase() !== 'data';
}

export interface SanitizedCss {
  css: string;
  /** What was taken out, for the report/log — never silently dropped. */
  removed: { imports: number; externalUrls: number; truncatedBytes: number };
}

export function sanitizeExportCss(raw: string): SanitizedCss {
  let truncatedBytes = 0;
  let css = raw;
  if (Buffer.byteLength(css, 'utf8') > MAX_EXPORT_CSS_BYTES) {
    const buf = Buffer.from(css, 'utf8');
    truncatedBytes = buf.length - MAX_EXPORT_CSS_BYTES;
    // Cut on a whole-character boundary, then drop the (now possibly
    // unterminated) trailing rule by cutting back to the last `}`.
    const cut = buf.subarray(0, MAX_EXPORT_CSS_BYTES).toString('utf8');
    const lastBrace = cut.lastIndexOf('}');
    css = lastBrace === -1 ? '' : cut.slice(0, lastBrace + 1);
  }

  css = css.replace(COMMENT_RE, ' ');

  let imports = 0;
  css = css.replace(IMPORT_RE, () => {
    imports++;
    return '';
  });

  let externalUrls = 0;
  css = css.replace(URL_RE, (whole, _q: string, target: string) => {
    if (!isExternalUrlTarget(target)) return whole;
    externalUrls++;
    return 'none';
  });

  // Cannot be allowed to close the <style> element it is injected into.
  css = css.replace(/<\s*\//g, '');

  return { css, removed: { imports, externalUrls, truncatedBytes } };
}

// ---------------------------------------------------------------------------
// header/footer templates
// ---------------------------------------------------------------------------

/**
 * Final stored size of ONE header/footer template, AFTER save-time image
 * inlining (`server/export/headerFooterImages.ts`) has turned every external
 * `<img src="http(s)://…">` into a `data:` URI. Sized around that module's
 * own `MAX_HEADER_FOOTER_IMAGE_BYTES` (300 KB): base64 inflates a downloaded
 * image by ~4/3 (≈400 KB), so 1 MiB comfortably fits a couple of embedded
 * images (say, two logos) plus markup, while still refusing anything that
 * would make the two Chrome header/footer template strings unreasonably
 * large. This is BOTH the render-time cap below (a hand-edited `.folio` file
 * in the repo is not bound by the PUT's own validation) and the write-time
 * cap `spaceSettings.ts` enforces right after inlining — one constant, two
 * enforcement points, so they cannot silently drift apart.
 */
export const MAX_HEADER_FOOTER_STORED_BYTES = 1024 * 1024;

/**
 * Chromium's own header/footer document is a separate mini-page; anything
 * scripted or externally sourced in it is both useless (it renders before
 * anything could run) and a liability. Allowlist by removal: no elements
 * that fetch or execute, no inline event handlers, no non-`data:` `src`.
 */
export function sanitizeHeaderFooterHtml(raw: string, maxBytes: number = MAX_HEADER_FOOTER_STORED_BYTES): string {
  return raw
    .replace(/<\s*(script|iframe|object|embed|link|meta|base)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed|link|meta|base)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (whole, attr: string, dq?: string, sq?: string, bare?: string) => {
      const value = (dq ?? sq ?? bare ?? '').trim();
      return /^data:/i.test(value) ? whole : '';
    })
    .slice(0, maxBytes);
}

export interface HeaderFooterContext {
  title: string;
  space: string;
  date: string;
}

/**
 * `{{page}}/{{pages}}/{{title}}/{{space}}/{{date}}`. The first two become
 * chromium's own `pageNumber`/`totalPages` spans — the whole reason this
 * round chose CDP printing over CSS Paged Media, which Chrome does not
 * implement running headers for.
 */
export function renderHeaderFooterTemplate(template: string, ctx: HeaderFooterContext, maxBytes: number = MAX_HEADER_FOOTER_STORED_BYTES): string {
  return sanitizeHeaderFooterHtml(template, maxBytes)
    .replace(/\{\{\s*page\s*\}\}/g, '<span class="pageNumber"></span>')
    .replace(/\{\{\s*pages\s*\}\}/g, '<span class="totalPages"></span>')
    .replace(/\{\{\s*title\s*\}\}/g, escapeHtml(ctx.title))
    .replace(/\{\{\s*space\s*\}\}/g, escapeHtml(ctx.space))
    .replace(/\{\{\s*date\s*\}\}/g, escapeHtml(ctx.date));
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// reading them off disk
// ---------------------------------------------------------------------------

/**
 * Cap for a `.folio/` template AFTER its `<img src="logo.png">` were inlined
 * from .folio/assets/: the raw template (PDF_CHROME_MAX_BYTES) plus every
 * asset base64-encoded. The legacy cap stays for legacy templates.
 */
export const MAX_FOLIO_TEMPLATE_RENDER_BYTES = PDF_CHROME_MAX_BYTES + Math.ceil((SITE_ASSETS_MAX_TOTAL_BYTES * 4) / 3) + 4096;

export interface SpaceExportAssets {
  css: string;
  headerHtml?: string;
  footerHtml?: string;
  removed: SanitizedCss['removed'];
  /** The byte cap renderHeaderFooterTemplate applies to these templates. */
  templateMaxBytes: number;
}

/**
 * The print stylesheet and header/footer templates of `space`: per file,
 * `.folio/` first (export.css, pdf-header.html, pdf-footer.html), then the
 * legacy places — `<slug>.export.css` at the REPO ROOT (where `<slug>.folio`
 * lives), the content root as a fallback, a generic `export.css` last; the
 * templates from the `export` section of `<slug>.folio`.
 *
 * Images: a `.folio/` template's `<img src="logo.png">` and a `.folio/export.css`
 * `url(logo.png)` name files of `.folio/assets/` and are inlined here as
 * `data:` URIs read from disk — the renderer itself loads nothing. Legacy
 * templates already carry `data:` URIs (embedded at save time,
 * headerFooterImages.ts).
 */
export async function readSpaceExportAssets(space: string): Promise<SpaceExportAssets> {
  const source = await readPdfChromeSource(space);
  const { css: sanitized, removed } = sanitizeExportCss(source.css ?? '');
  const css = source.cssSource === 'folio' ? await inlineAssetUrlsInCss(space, sanitized) : sanitized;

  const fromFolio = async (html: string | undefined, origin: PdfSource): Promise<string | undefined> => {
    if (html === undefined || !html.trim()) return undefined;
    if (origin !== 'folio') return html;
    return inlineAssetImages(space, html.slice(0, PDF_CHROME_MAX_BYTES));
  };
  const headerHtml = await fromFolio(source.headerHtml, source.headerSource);
  const footerHtml = await fromFolio(source.footerHtml, source.footerSource);
  const anyFolio = source.headerSource === 'folio' || source.footerSource === 'folio';
  return { css, headerHtml, footerHtml, removed, templateMaxBytes: anyFolio ? MAX_FOLIO_TEMPLATE_RENDER_BYTES : MAX_HEADER_FOOTER_STORED_BYTES };
}

type PdfSource = 'folio' | 'legacy' | 'none';
