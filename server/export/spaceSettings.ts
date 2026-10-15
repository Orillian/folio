/**
 * GET/PUT /api/spaces/:space/export-settings — the PDF header/footer of a
 * space, kept for one release as a THIN WRAPPER over the space appearance
 * store (server/spaceAppearance.ts, 14.10.2026): the templates now live in
 * `.folio/pdf-header.html` / `.folio/pdf-footer.html` at the content root and
 * are edited on the space settings page (/s/<space>/settings, PDF tab).
 *
 *  - read: the effective templates — `.folio/` first, the legacy `export`
 *    section of `<slug>.folio` second (what the PDF renderer uses too);
 *  - write: the old body shape `{ headerHtml?, footerHtml? }` (an absent or
 *    blank template removes it), external `<img src="http(s)://…">` still
 *    downloaded and embedded at save time (headerFooterImages.ts), then
 *    handed to writeAppearance — which moves embedded images into
 *    `.folio/assets/`, migrates whatever legacy PDF settings are left
 *    (header, footer, `<slug>.export.css`) and commits once
 *    (`settings: update .folio/pdf-header.html, .folio/pdf-footer.html`).
 *
 * No etag on this old route: it saves over whatever is there, as it always did.
 */
import { spaceExportSettingsSchema } from '../../shared/contracts.js';
import { badRequest } from '../errors.js';
import type { GitIdentity } from '../git.js';
import * as gitSync from '../gitSync.js';
import { readAppearance, writeAppearance } from '../spaceAppearance.js';
import { parseBody } from '../validate.js';
import { MAX_HEADER_FOOTER_STORED_BYTES } from './css.js';
import { inlineExternalImages } from './headerFooterImages.js';

/** Per-template cap on the RAW markup an author may submit (images are embedded after this check). */
export const MAX_HEADER_FOOTER_BYTES = 8192;

export interface SpaceExportSettingsPayload {
  headerHtml?: string;
  footerHtml?: string;
}

/** The effective templates (what the PDF renderer uses): `.folio/` first, the legacy `<slug>.folio` section second. */
export async function readSpaceExportSettings(space: string): Promise<SpaceExportSettingsPayload> {
  const state = await readAppearance(space);
  const out: SpaceExportSettingsPayload = {};
  const header = state.files.find((f) => f.file === 'pdf-header.html');
  const footer = state.files.find((f) => f.file === 'pdf-footer.html');
  if (header?.content.trim()) out.headerHtml = header.content;
  if (footer?.content.trim()) out.footerHtml = footer.content;
  return out;
}

/** Schema first (shape/garbage → 400 via parseBody), byte cap second (the schema itself carries no max). */
export function validateExportSettingsBody(body: unknown): SpaceExportSettingsPayload {
  const parsed = parseBody(spaceExportSettingsSchema, body) ?? {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > MAX_HEADER_FOOTER_BYTES) {
      throw badRequest(`${key} exceeds ${MAX_HEADER_FOOTER_BYTES} bytes`);
    }
  }
  return parsed;
}

/**
 * Downloads and inlines every external `<img src="http(s)://…">` as a `data:`
 * URI (headerFooterImages.ts is the SSRF gateway this goes through); a failed
 * fetch throws 400 naming the URL. writeAppearance then turns the `data:`
 * images into `.folio/assets/pdf-image-N.<ext>`.
 */
export async function inlineTemplateImages(settings: SpaceExportSettingsPayload): Promise<SpaceExportSettingsPayload> {
  const out: SpaceExportSettingsPayload = { ...settings };
  if (out.headerHtml) out.headerHtml = await inlineExternalImages(out.headerHtml);
  if (out.footerHtml) out.footerHtml = await inlineExternalImages(out.footerHtml);
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > MAX_HEADER_FOOTER_STORED_BYTES) {
      throw badRequest(`${key} exceeds ${MAX_HEADER_FOOTER_STORED_BYTES} bytes after inlining its embedded image(s)`);
    }
  }
  return out;
}

/** Saves both templates into `.folio/` (blank/absent = removed), with the legacy migration and one commit. */
export async function writeSpaceExportSettings(space: string, settings: SpaceExportSettingsPayload, actor?: GitIdentity): Promise<void> {
  const current = await readAppearance(space);
  const etagOf = (file: 'pdf-header.html' | 'pdf-footer.html') => current.files.find((f) => f.file === file)?.etag ?? null;
  await writeAppearance(space, actor ?? gitSync.authorFor(space), [
    { file: 'pdf-header.html', content: settings.headerHtml?.trim() ? settings.headerHtml : '', etag: etagOf('pdf-header.html') },
    { file: 'pdf-footer.html', content: settings.footerHtml?.trim() ? settings.footerHtml : '', etag: etagOf('pdf-footer.html') },
  ]);
}
