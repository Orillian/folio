/**
 * Space appearance (14.10.2026): the `.folio/` folder at a space's CONTENT ROOT
 * (shared/contracts.ts, "Space appearance"). Postgres keeps WHO sees a site and
 * where (publicSites.ts); the repository keeps WHAT it looks like:
 *
 *   .folio/site.json        title, tagline, description, lang, ogImage, favicon, logo
 *   .folio/site.css         stylesheet of the public site (shared/siteCss.ts sanitizes it)
 *   .folio/export.css       print stylesheet of the PDF export (was `<slug>.export.css`)
 *   .folio/pdf-header.html  PDF header template (was the `export` section of `<slug>.folio`)
 *   .folio/pdf-footer.html  PDF footer template
 *   .folio/assets/*         images and fonts the files above name (public while the space is)
 *
 * Git is an equal editor: every file carries an etag (sha1 of its bytes), a
 * save names the etag it started from and a mismatch is a 409 with the current
 * state; every save is ONE commit of exactly the files it touched
 * (git.commitPaths), never a sweep of other people's unsaved edits.
 *
 * Legacy PDF settings (`export.headerHtml/footerHtml` in `<slug>.folio`, the
 * `<slug>.export.css` lookup chain) are still read — per file, `.folio/` first —
 * and are moved into `.folio/` by the first save of any PDF file (one commit):
 * header/footer become files, their embedded base64 images become
 * `.folio/assets/pdf-image-N.<ext>`, the `export` section leaves `<slug>.folio`
 * (every other key stays) and an active `<slug>.export.css` is deleted.
 *
 * Nothing here follows a symlink: `.folio`, `.folio/assets` and every file are
 * lstat-ed and refused when they are links (a repository writer must not be able
 * to publish /etc/passwd as a site stylesheet).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  APPEARANCE_DIR,
  PDF_CHROME_MAX_BYTES,
  SITE_ASSET_MAX_BYTES,
  SITE_ASSET_NAME_RE,
  SITE_ASSETS_MAX_TOTAL_BYTES,
  SITE_CSS_MAX_BYTES,
  siteSettingsSchema,
  type AppearanceFile,
  type AppearanceFileState,
  type PutAppearanceBody,
  type SiteAssetInfo,
  type SiteSettings,
  type SpaceAppearanceResponse,
} from '../shared/contracts.js';
import { sanitizeSiteCss, siteAssetNameFromRef } from '../shared/siteCss.js';
import { withSpaceLock } from './db/redis.js';
import { ensureSidecarDirs } from './propsSidecar.js';
import { badRequest, conflict, HttpError, notFound } from './errors.js';
import { MAX_EXPORT_CSS_BYTES, sanitizeExportCss } from './export/css.js';
import { sanitizeSvgForEmbedding } from './export/headerFooterImages.js';
import * as git from './git.js';
import type { GitIdentity } from './git.js';
import * as gitSync from './gitSync.js';
import { classifyForServing, contentDisposition, SANDBOX_CSP } from './safeServe.js';
import * as storage from './storage.js';

export const APPEARANCE_FILES: readonly AppearanceFile[] = ['site.json', 'site.css', 'export.css', 'pdf-header.html', 'pdf-footer.html'];
const PDF_FILES: ReadonlySet<AppearanceFile> = new Set(['export.css', 'pdf-header.html', 'pdf-footer.html']);
const ASSETS_DIR = 'assets';

/** 409 of a save whose etag no longer matches; carries the current state for the response body. */
export class AppearanceConflictError extends HttpError {
  constructor(public current: SpaceAppearanceResponse) {
    super(409, 'appearance file changed in the repository');
  }
}

function sha1(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

// ---------------------------------------------------------------------------
// paths (no symlinks, ever)
// ---------------------------------------------------------------------------

/** Absolute path of the space's `.folio/` folder (it may not exist). */
export function appearanceDir(space: string): string {
  return path.join(storage.getSpaceDir(space), APPEARANCE_DIR);
}

/** Repository-relative POSIX path of a file under `.folio/` (`docs/.folio/site.css` for a rootPath space). */
function repoRelPath(space: string, ...parts: string[]): string {
  return path.posix.join(storage.getRootPath(space) || '', APPEARANCE_DIR, ...parts);
}

type Kind = 'file' | 'dir';

/** lstat that answers null for "missing" and for anything that is not a plain file/dir of the expected kind (symlinks included). */
async function plainStat(abs: string, kind: Kind): Promise<import('node:fs').Stats | null> {
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink()) return null;
    if (kind === 'file' ? !st.isFile() : !st.isDirectory()) return null;
    return st;
  } catch {
    return null;
  }
}

/** True when `.folio` (and `.folio/assets` for an asset) are real directories — or absent. A symlinked one is refused. */
async function dirIsSafe(abs: string): Promise<boolean> {
  try {
    const st = await fs.lstat(abs);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return true; // missing: nothing to read, and mkdir creates a real one
  }
}

async function ensureRealDir(abs: string): Promise<void> {
  if (!(await dirIsSafe(abs))) throw conflict(`${path.basename(abs)} is not a directory in the repository`);
  await fs.mkdir(abs, { recursive: true });
}

interface CachedText {
  mtimeMs: number;
  size: number;
  content: string;
  etag: string;
}
const textCache = new Map<string, CachedText>();
const TEXT_CACHE_MAX = 500;

/** A `.folio/<file>` as text with its etag, or null (missing, a symlink, `.folio` itself a symlink). Cached by mtime+size. */
async function readFolioText(space: string, file: string): Promise<{ content: string; etag: string } | null> {
  const dir = appearanceDir(space);
  if (!(await dirIsSafe(dir))) return null;
  const abs = path.join(dir, file);
  const st = await plainStat(abs, 'file');
  if (!st) return null;
  const hit = textCache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { content: hit.content, etag: hit.etag };
  const buf = await fs.readFile(abs);
  const entry: CachedText = { mtimeMs: st.mtimeMs, size: st.size, content: buf.toString('utf8'), etag: sha1(buf) };
  if (textCache.size >= TEXT_CACHE_MAX) textCache.clear();
  textCache.set(abs, entry);
  return { content: entry.content, etag: entry.etag };
}

// ---------------------------------------------------------------------------
// assets
// ---------------------------------------------------------------------------

export function isValidAssetName(name: string): boolean {
  return SITE_ASSET_NAME_RE.test(name) && !name.includes('..');
}

function assetsDirAbs(space: string): string {
  return path.join(appearanceDir(space), ASSETS_DIR);
}

interface AssetEntry {
  name: string;
  size: number;
  version: string;
}

function assetVersion(st: { size: number; mtimeMs: number }): string {
  return sha1(`${st.size}:${st.mtimeMs}`).slice(0, 10);
}

/** The files of `.folio/assets/` that may be served (valid names, plain files), sorted by name. */
async function listAssetEntries(space: string): Promise<AssetEntry[]> {
  const dir = assetsDirAbs(space);
  if (!(await dirIsSafe(appearanceDir(space))) || !(await plainStat(dir, 'dir'))) return [];
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: AssetEntry[] = [];
  for (const name of names.sort()) {
    if (!isValidAssetName(name)) continue;
    const st = await plainStat(path.join(dir, name), 'file');
    if (st) out.push({ name, size: st.size, version: assetVersion(st) });
  }
  return out;
}

/** URL of an asset on the public site (works on every host of the site: the app answers /api on all of them). */
export function siteAssetUrl(slug: string, name: string, version?: string): string {
  return `/api/public/spaces/${encodeURIComponent(slug)}/site-assets/${encodeURIComponent(name)}${version ? `?v=${version}` : ''}`;
}

/** Size and cache version of one asset, or null when it does not exist / is not servable. */
export async function statSiteAsset(space: string, name: string): Promise<{ size: number; version: string } | null> {
  if (!isValidAssetName(name)) return null;
  if (!(await dirIsSafe(appearanceDir(space))) || !(await dirIsSafe(assetsDirAbs(space)))) return null;
  const st = await plainStat(path.join(assetsDirAbs(space), name), 'file');
  return st ? { size: st.size, version: assetVersion(st) } : null;
}

const FONT_TYPES: Record<string, { magic: string; type: string }> = {
  woff2: { magic: 'wOF2', type: 'font/woff2' },
  woff: { magic: 'wOFF', type: 'font/woff' },
};
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

function extOf(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase();
}

/** The type the bytes really are when they match the name's extension; null for a mislabeled file. */
export function verifiedAssetType(name: string, bytes: Buffer): string | null {
  const ext = extOf(name);
  const font = FONT_TYPES[ext];
  if (font) return bytes.subarray(0, 4).toString('latin1') === font.magic ? font.type : null;
  const expected = IMAGE_TYPES[ext];
  if (!expected) return null;
  const policy = classifyForServing(name, bytes);
  return policy.contentType === expected ? expected : null;
}

export interface ServedAsset {
  bytes: Buffer;
  headers: Record<string, string>;
}

/** An asset with the headers to serve it: images inline (SVG under the sandbox CSP), fonts as font/*, everything nosniff. Null when absent or mislabeled. */
export async function readAsset(space: string, name: string): Promise<ServedAsset | null> {
  if (!(await statSiteAsset(space, name))) return null;
  const bytes = await fs.readFile(path.join(assetsDirAbs(space), name));
  const type = verifiedAssetType(name, bytes);
  if (!type) return null;
  const headers: Record<string, string> = {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': contentDisposition(true, name),
  };
  if (type === 'image/svg+xml') headers['Content-Security-Policy'] = SANDBOX_CSP;
  // Fonts are fetched in CORS mode; a site host loading them from its own origin needs nothing, other origins get nothing.
  return { bytes, headers };
}

/** `data:` URI of an asset for the PDF renderer (which loads nothing over the network), or null. */
async function assetDataUri(space: string, name: string): Promise<string | null> {
  const asset = await readAsset(space, name).catch(() => null);
  if (!asset) return null;
  const type = asset.headers['Content-Type'];
  // Same treatment as an SVG downloaded for a legacy template (headerFooterImages.ts).
  const bytes = type === 'image/svg+xml' ? Buffer.from(sanitizeSvgForEmbedding(asset.bytes.toString('utf8')), 'utf8') : asset.bytes;
  return `data:${type};base64,${bytes.toString('base64')}`;
}

// ---------------------------------------------------------------------------
// legacy PDF settings
// ---------------------------------------------------------------------------

interface LegacyState {
  headerHtml?: string;
  footerHtml?: string;
  /** The `.folio` meta file holds an `export` object (removed by the migration). */
  hasExportSection: boolean;
  metaAbs: string;
  css?: string;
  /** The `<slug>.export.css` the css came from (deleted by the migration); undefined for the generic `export.css` or none. */
  cssAbs?: string;
}

async function readPlainFile(abs: string): Promise<string | undefined> {
  return (await plainStat(abs, 'file')) ? fs.readFile(abs, 'utf8') : undefined;
}

async function readLegacy(space: string): Promise<LegacyState> {
  const metaAbs = await storage.folioMetaPath(space);
  const state: LegacyState = { hasExportSection: false, metaAbs };
  const raw = await readPlainFile(metaAbs).catch(() => undefined);
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as { export?: unknown };
      const section = parsed?.export;
      if (section && typeof section === 'object' && !Array.isArray(section)) {
        state.hasExportSection = true;
        const { headerHtml, footerHtml } = section as { headerHtml?: unknown; footerHtml?: unknown };
        if (typeof headerHtml === 'string' && headerHtml.trim()) state.headerHtml = headerHtml;
        if (typeof footerHtml === 'string' && footerHtml.trim()) state.footerHtml = footerHtml;
      }
    } catch {
      // corrupt/foreign file: no legacy settings, and never touched
    }
  }
  const repoDir = storage.getRepoDir(space);
  const contentDir = storage.getSpaceDir(space);
  const chain: Array<{ abs: string; owned: boolean }> = [
    { abs: path.join(repoDir, `${space}.export.css`), owned: true },
    { abs: path.join(contentDir, `${space}.export.css`), owned: true },
    { abs: path.join(repoDir, 'export.css'), owned: false },
  ];
  for (const candidate of chain) {
    const css = await readPlainFile(candidate.abs).catch(() => undefined);
    if (css === undefined) continue;
    state.css = css;
    if (candidate.owned) state.cssAbs = candidate.abs;
    break;
  }
  return state;
}

function legacyContent(legacy: LegacyState, file: AppearanceFile): string | undefined {
  if (file === 'pdf-header.html') return legacy.headerHtml;
  if (file === 'pdf-footer.html') return legacy.footerHtml;
  if (file === 'export.css') return legacy.css;
  return undefined;
}

// ---------------------------------------------------------------------------
// site.json / site.css as the public site uses them
// ---------------------------------------------------------------------------

/** site.json validated field by field: a broken field is dropped, the rest still applies. {} when absent or not JSON. */
function parseSiteSettingsLenient(content: string): SiteSettings {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return {} as SiteSettings;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {} as SiteSettings;
  let candidate = { ...(value as Record<string, unknown>) };
  for (let attempt = 0; attempt < 10; attempt++) {
    const parsed = siteSettingsSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    const bad = new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '')));
    if (bad.size === 0 || bad.has('')) return {} as SiteSettings;
    for (const key of bad) delete candidate[key];
    candidate = { ...candidate };
  }
  return {} as SiteSettings;
}

/** `.folio/site.json` as the site applies it (invalid fields dropped); {} when there is none. */
export async function readSiteSettings(space: string): Promise<SiteSettings> {
  const file = await readFolioText(space, 'site.json');
  return file ? parseSiteSettingsLenient(file.content) : ({} as SiteSettings);
}

export interface SiteCss {
  /** Sanitized stylesheet, asset names rewritten to versioned site-assets URLs. */
  css: string;
  /** sha1 of `css` (the ETag of the served file and the `?v=` of its URL). */
  etag: string;
  warnings: string[];
}

const siteCssCache = new Map<string, { key: string; value: SiteCss }>();

/** The sanitized site stylesheet, or null when `.folio/site.css` does not exist. */
export async function readSiteCss(space: string): Promise<SiteCss | null> {
  const file = await readFolioText(space, 'site.css');
  if (!file) return null;
  const assets = await listAssetEntries(space);
  const key = `${file.etag}|${assets.map((a) => `${a.name}:${a.version}`).join(',')}`;
  const hit = siteCssCache.get(space);
  if (hit && hit.key === key) return hit.value;
  const versions = new Map(assets.map((a) => [a.name, a.version] as const));
  const { css, warnings } = sanitizeSiteCss(file.content, { assetUrl: (name) => siteAssetUrl(space, name, versions.get(name)) });
  const value: SiteCss = { css, etag: sha1(css), warnings };
  siteCssCache.set(space, { key, value });
  return value;
}

// ---------------------------------------------------------------------------
// PDF: what the renderer reads
// ---------------------------------------------------------------------------

export interface PdfChromeSource {
  /** Raw (unsanitized) print stylesheet, header and footer; undefined when absent everywhere. */
  css?: string;
  headerHtml?: string;
  footerHtml?: string;
  /** Where each one came from. */
  cssSource: 'folio' | 'legacy' | 'none';
  headerSource: 'folio' | 'legacy' | 'none';
  footerSource: 'folio' | 'legacy' | 'none';
}

/** Per file: `.folio/` first, then the legacy location. */
export async function readPdfChromeSource(space: string): Promise<PdfChromeSource> {
  const [css, header, footer] = await Promise.all([
    readFolioText(space, 'export.css'),
    readFolioText(space, 'pdf-header.html'),
    readFolioText(space, 'pdf-footer.html'),
  ]);
  const legacy = !css || !header || !footer ? await readLegacy(space) : undefined;
  const pick = (folio: { content: string } | null, legacyValue: string | undefined) =>
    folio ? { value: folio.content, source: 'folio' as const } : legacyValue !== undefined ? { value: legacyValue, source: 'legacy' as const } : { value: undefined, source: 'none' as const };
  const c = pick(css, legacy?.css);
  const h = pick(header, legacy?.headerHtml);
  const f = pick(footer, legacy?.footerHtml);
  return { css: c.value, headerHtml: h.value, footerHtml: f.value, cssSource: c.source, headerSource: h.source, footerSource: f.source };
}

const IMG_SRC_ATTR_RE = /(<img\b[^>]*?\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** `<img src="logo.png">` (a `.folio/assets/` name) → the asset as a `data:` URI; other srcs untouched. */
export async function inlineAssetImages(space: string, html: string): Promise<string> {
  const names = new Set<string>();
  for (const m of html.matchAll(IMG_SRC_ATTR_RE)) {
    const name = siteAssetNameFromRef(m[2] ?? m[3] ?? m[4] ?? '');
    if (name) names.add(name);
  }
  if (names.size === 0) return html;
  const uris = new Map<string, string>();
  for (const name of names) {
    const uri = await assetDataUri(space, name);
    if (uri) uris.set(name, uri);
  }
  return html.replace(IMG_SRC_ATTR_RE, (whole, pre: string, dq?: string, sq?: string, bare?: string) => {
    const name = siteAssetNameFromRef(dq ?? sq ?? bare ?? '');
    const uri = name ? uris.get(name) : undefined;
    return uri ? `${pre}"${uri}"` : whole;
  });
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/** `url(logo.png)` / `url(assets/font.woff2)` in an already sanitized print stylesheet → `data:` URIs from `.folio/assets/`. */
export async function inlineAssetUrlsInCss(space: string, css: string): Promise<string> {
  const names = new Set<string>();
  for (const m of css.matchAll(CSS_URL_RE)) {
    const name = siteAssetNameFromRef(m[2]);
    if (name) names.add(name);
  }
  if (names.size === 0) return css;
  const uris = new Map<string, string>();
  for (const name of names) {
    const uri = await assetDataUri(space, name);
    if (uri) uris.set(name, uri);
  }
  return css.replace(CSS_URL_RE, (whole, _q: string, target: string) => {
    const name = siteAssetNameFromRef(target);
    const uri = name ? uris.get(name) : undefined;
    return uri ? `url("${uri}")` : whole;
  });
}

// ---------------------------------------------------------------------------
// GET /api/spaces/:space/appearance
// ---------------------------------------------------------------------------

function siteJsonWarnings(content: string, assetNames: ReadonlySet<string>): string[] {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (err) {
    return [`site.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`];
  }
  const parsed = siteSettingsSchema.safeParse(value);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.') || 'site.json'}: ${i.message}`);
  const warnings: string[] = [];
  for (const key of ['ogImage', 'favicon', 'logo'] as const) {
    const name = parsed.data[key];
    if (name && !assetNames.has(name)) warnings.push(`${key}: .folio/assets/${name} does not exist`);
  }
  return warnings;
}

function exportCssWarnings(content: string): string[] {
  const { removed } = sanitizeExportCss(content);
  const warnings: string[] = [];
  if (removed.truncatedBytes > 0) warnings.push(`export.css is larger than ${Math.round(MAX_EXPORT_CSS_BYTES / 1024)} KB; the rest is cut`);
  if (removed.imports > 0) warnings.push(`@import is not allowed (${removed.imports} removed)`);
  if (removed.externalUrls > 0) warnings.push(`url() to other hosts is not loaded (${removed.externalUrls} replaced with none); use a file of .folio/assets/`);
  return warnings;
}

function pdfHtmlWarnings(content: string, assetNames: ReadonlySet<string>): string[] {
  const warnings: string[] = [];
  if (byteLength(content) > PDF_CHROME_MAX_BYTES) warnings.push(`larger than ${Math.round(PDF_CHROME_MAX_BYTES / 1024)} KB`);
  if (/<\s*(script|iframe|object|embed|link|meta|base)\b/i.test(content)) warnings.push('script, iframe, object, embed, link, meta and base elements are removed');
  if (/\son[a-z]+\s*=/i.test(content)) warnings.push('on* event attributes are removed');
  const missing = new Set<string>();
  let external = 0;
  for (const m of content.matchAll(IMG_SRC_ATTR_RE)) {
    const src = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (/^data:/i.test(src)) continue;
    const name = siteAssetNameFromRef(src);
    if (name) {
      if (!assetNames.has(name)) missing.add(name);
    } else {
      external++;
    }
  }
  if (external > 0) warnings.push(`${external} image(s) are not loaded: upload the file to .folio/assets/ and use its name, e.g. <img src="logo.png">`);
  for (const name of missing) warnings.push(`.folio/assets/${name} does not exist`);
  return warnings;
}

interface Inspection {
  response: SpaceAppearanceResponse;
  legacy: LegacyState | null;
}

/** GitHub / GitLab "blob" URL base for the space's repository and branch, or null. */
export function repoFileBaseUrl(repoUrl: string | null | undefined, branch: string | null | undefined): string | null {
  if (!repoUrl) return null;
  let host = '';
  let repoPath = '';
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(repoUrl.trim());
  if (scp) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    try {
      const url = new URL(repoUrl.trim());
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return null;
      host = url.hostname;
      repoPath = url.pathname;
    } catch {
      return null;
    }
  }
  host = host.toLowerCase();
  repoPath = repoPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!repoPath.includes('/')) return null;
  const ref = (branch || 'main').split('/').map(encodeURIComponent).join('/');
  if (host === 'github.com') return `https://github.com/${repoPath}/blob/${ref}/`;
  if (host === 'gitlab.com' || host.startsWith('gitlab.') || host.includes('.gitlab.')) return `https://${host}/${repoPath}/-/blob/${ref}/`;
  return null;
}

async function inspect(space: string): Promise<Inspection> {
  const info = await storage.getSpaceInfo(space);
  if (!info) throw notFound('space');
  const isPublic = info.visibility === 'public';
  const assets = await listAssetEntries(space);
  const assetNames = new Set(assets.map((a) => a.name));
  let legacy: LegacyState | null = null;
  const files: AppearanceFileState[] = [];
  for (const file of APPEARANCE_FILES) {
    const stored = await readFolioText(space, file);
    const base = { file, path: repoRelPath(space, file) };
    let content = '';
    let state: Omit<AppearanceFileState, 'warnings' | 'file' | 'path'>;
    if (stored) {
      content = stored.content;
      state = { exists: true, etag: stored.etag, content, source: 'folio' };
    } else {
      if (PDF_FILES.has(file)) legacy ??= await readLegacy(space);
      const fromLegacy = legacy ? legacyContent(legacy, file) : undefined;
      content = fromLegacy ?? '';
      state = { exists: false, etag: null, content, source: fromLegacy !== undefined ? 'legacy' : 'none' };
    }
    let warnings: string[] = [];
    if (content.trim()) {
      if (file === 'site.json') warnings = siteJsonWarnings(content, assetNames);
      else if (file === 'site.css') warnings = sanitizeSiteCss(content, { assetUrl: (name) => siteAssetUrl(space, name) }).warnings;
      else if (file === 'export.css') warnings = exportCssWarnings(content);
      else warnings = pdfHtmlWarnings(content, assetNames);
    }
    files.push({ ...base, ...state, warnings });
  }
  return {
    legacy,
    response: {
      files,
      assets: assets.map((a) => ({ name: a.name, size: a.size, url: isPublic ? siteAssetUrl(space, a.name, a.version) : null })),
      contentRoot: storage.getRootPath(space) || '',
      repoFileBaseUrl: repoFileBaseUrl(info.git?.repoUrl, info.git?.branch),
      legacyPending: files.some((f) => f.source === 'legacy'),
      isPublic,
    },
  };
}

export async function readAppearance(space: string): Promise<SpaceAppearanceResponse> {
  return (await inspect(space)).response;
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

/** A planned change, by path relative to the content root: text/bytes to write, null to delete. */
type Plan = Map<string, string | Buffer | null>;

const DATA_IMG_RE = /(<img\b[^>]*?\ssrc\s*=\s*)(["'])data:(image\/(?:png|jpeg|jpg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)\2/gi;
const DATA_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

interface AssetPool {
  /** name -> bytes of every asset (existing on disk + planned), for dedupe and naming. */
  byName: Map<string, Buffer | null>;
  bySha: Map<string, string>;
}

async function loadAssetPool(space: string): Promise<AssetPool> {
  const pool: AssetPool = { byName: new Map(), bySha: new Map() };
  for (const entry of await listAssetEntries(space)) {
    const bytes = await fs.readFile(path.join(assetsDirAbs(space), entry.name)).catch(() => null);
    pool.byName.set(entry.name, bytes);
    if (bytes) pool.bySha.set(sha1(bytes), entry.name);
  }
  return pool;
}

/**
 * Moves every base64 `<img src="data:image/…">` of a PDF template into
 * `.folio/assets/pdf-image-N.<ext>` (reusing an identical existing asset) and
 * points the tag at the name. Bytes that are not what their type says stay inline.
 */
function extractDataImages(html: string, pool: AssetPool, plan: Plan): string {
  return html.replace(DATA_IMG_RE, (whole, pre: string, _q: string, mime: string, b64: string) => {
    const bytes = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
    const ext = DATA_EXT[mime.toLowerCase()];
    if (!ext || bytes.length === 0) return whole;
    const digest = sha1(bytes);
    let name = pool.bySha.get(digest);
    if (!name) {
      let n = 1;
      while (pool.byName.has(`pdf-image-${n}.${ext}`)) n++;
      const candidate = `pdf-image-${n}.${ext}`;
      if (!verifiedAssetType(candidate, bytes)) return whole;
      name = candidate;
      pool.byName.set(name, bytes);
      pool.bySha.set(digest, name);
      plan.set(path.posix.join(APPEARANCE_DIR, ASSETS_DIR, name), bytes);
    }
    return `${pre}"${name}"`;
  });
}

function assertAssetTotals(pool: AssetPool): void {
  let total = 0;
  for (const bytes of pool.byName.values()) {
    if (!bytes) continue;
    if (bytes.length > SITE_ASSET_MAX_BYTES) throw new HttpError(413, `an asset is larger than ${SITE_ASSET_MAX_BYTES / 1024 / 1024} MB`);
    total += bytes.length;
  }
  if (total > SITE_ASSETS_MAX_TOTAL_BYTES) throw new HttpError(413, `.folio/assets/ would exceed ${SITE_ASSETS_MAX_TOTAL_BYTES / 1024 / 1024} MB`);
}

function validateChange(file: AppearanceFile, content: string): void {
  if (file === 'site.json') {
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (err) {
      throw badRequest(`site.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = siteSettingsSchema.safeParse(value);
    if (!parsed.success) {
      throw badRequest(`site.json: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
    }
    return;
  }
  if (file === 'site.css' && byteLength(content) > SITE_CSS_MAX_BYTES) throw new HttpError(413, `site.css is larger than ${SITE_CSS_MAX_BYTES / 1024} KB`);
  if (file === 'export.css' && byteLength(content) > MAX_EXPORT_CSS_BYTES) throw new HttpError(413, `export.css is larger than ${MAX_EXPORT_CSS_BYTES / 1024} KB`);
  if ((file === 'pdf-header.html' || file === 'pdf-footer.html') && byteLength(content) > PDF_CHROME_MAX_BYTES) {
    throw new HttpError(413, `${file} is larger than ${PDF_CHROME_MAX_BYTES / 1024} KB`);
  }
}

/** `<slug>.folio` without its `export` section, every other key kept; undefined when it cannot be rewritten safely. */
async function folioMetaWithoutExport(metaAbs: string): Promise<string | undefined> {
  const raw = await readPlainFile(metaAbs).catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const rest = { ...(value as Record<string, unknown>) };
    if (!('export' in rest)) return undefined;
    delete rest.export;
    return `${JSON.stringify(rest, null, 2)}\n`;
  } catch {
    return undefined;
  }
}

/** Applies a plan under the content root: writes (atomic) and deletes. Returns repo-relative paths. */
async function applyPlan(space: string, plan: Plan, extraAbs: Map<string, string | null>): Promise<string[]> {
  const contentDir = storage.getSpaceDir(space);
  const repoDir = storage.getRepoDir(space);
  const touched: string[] = [];
  const toRepoRel = (abs: string) => path.relative(repoDir, abs).split(path.sep).join('/');
  if ([...plan.values()].some((v) => v !== null)) {
    await ensureRealDir(appearanceDir(space));
    if ([...plan.keys()].some((k) => k.startsWith(`${APPEARANCE_DIR}/${ASSETS_DIR}/`))) await ensureRealDir(assetsDirAbs(space));
  }
  for (const [rel, value] of plan) {
    const abs = path.join(contentDir, ...rel.split('/'));
    if (value === null) {
      if (await plainStat(abs, 'file')) await fs.rm(abs, { force: true });
    } else {
      // Never write through a symlink planted at the file's own path.
      const st = await fs.lstat(abs).catch(() => null);
      if (st?.isSymbolicLink()) await fs.rm(abs, { force: true });
      await storage.writeFileAtomic(abs, value);
    }
    textCache.delete(abs);
    touched.push(toRepoRel(abs));
  }
  for (const [abs, value] of extraAbs) {
    if (value === null) await fs.rm(abs, { force: true });
    else await storage.writeFileAtomic(abs, value);
    touched.push(toRepoRel(abs));
  }
  siteCssCache.delete(space);
  return touched;
}

async function commitTouched(space: string, paths: string[], message: string, actor: GitIdentity): Promise<void> {
  const repoDir = storage.getRepoDir(space);
  if (!(await git.isGitRepo(repoDir))) return;
  const committed = await git.commitPaths(repoDir, paths, message, actor);
  // The commit is local; the next sync (debounced, like every edit) pushes it.
  if (committed) gitSync.noteActivity(space);
}

export interface AppearanceChange {
  file: AppearanceFile;
  content: string;
  etag: string | null;
}

/**
 * PUT /api/spaces/:space/appearance. Etag per file (409 with the current
 * state), validation (400/413), the legacy migration on the first PDF save,
 * then the writes and ONE commit of exactly those paths — all under the
 * space's lock, so the debounced auto-commit cannot slip in between.
 */
export async function writeAppearance(space: string, actor: GitIdentity, changes: PutAppearanceBody['changes']): Promise<SpaceAppearanceResponse> {
  if (!(await storage.spaceExists(space))) throw notFound('space');
  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.file)) throw badRequest(`${change.file} is listed twice`);
    seen.add(change.file);
  }

  return withSpaceLock(space, async () => {
    const { response: current, legacy } = await inspect(space);
    for (const change of changes) {
      const state = current.files.find((f) => f.file === change.file)!;
      if (state.etag !== change.etag) throw new AppearanceConflictError(current);
    }

    const plan: Plan = new Map();
    const extra = new Map<string, string | null>();
    const pool = await loadAssetPool(space);
    const touchesPdf = changes.some((c) => PDF_FILES.has(c.file));

    const contentFor = (file: AppearanceFile, content: string): string => {
      // Embedded images of a PDF template become assets (also what makes a legacy header with a big inline logo fit the cap).
      return file === 'pdf-header.html' || file === 'pdf-footer.html' ? extractDataImages(content, pool, plan) : content;
    };

    for (const change of changes) {
      const rel = path.posix.join(APPEARANCE_DIR, change.file);
      if (!change.content.trim()) {
        plan.set(rel, null);
        continue;
      }
      const content = contentFor(change.file, change.content);
      validateChange(change.file, content);
      plan.set(rel, content);
    }

    let migrated = false;
    if (touchesPdf && legacy && current.legacyPending) {
      migrated = true;
      for (const file of PDF_FILES) {
        const state = current.files.find((f) => f.file === file)!;
        if (state.source !== 'legacy' || plan.has(path.posix.join(APPEARANCE_DIR, file))) continue;
        plan.set(path.posix.join(APPEARANCE_DIR, file), contentFor(file, state.content));
      }
      if (legacy.hasExportSection) {
        const rewritten = await folioMetaWithoutExport(legacy.metaAbs);
        if (rewritten !== undefined) extra.set(legacy.metaAbs, rewritten);
      }
      if (legacy.cssAbs && current.files.find((f) => f.file === 'export.css')?.source === 'legacy') extra.set(legacy.cssAbs, null);
    }
    assertAssetTotals(pool);

    const touched = await applyPlan(space, plan, extra);
    const names = changes.map((c) => `${APPEARANCE_DIR}/${c.file}`).join(', ');
    const message = `settings: update ${names}${migrated ? ' (PDF settings moved into .folio/)' : ''}`;
    await commitTouched(space, touched, message, actor);
    return (await inspect(space)).response;
  });
}

/** POST /api/spaces/:space/appearance/assets — caps, allowed names, the bytes must be what the extension says. */
export async function uploadAsset(space: string, actor: GitIdentity, name: string, bytes: Buffer, replace: boolean): Promise<SiteAssetInfo> {
  if (!(await storage.spaceExists(space))) throw notFound('space');
  if (!isValidAssetName(name)) throw badRequest('invalid asset name: letters, digits, dot, dash and underscore, ending in .png .jpg .jpeg .webp .gif .svg .ico .woff or .woff2');
  if (bytes.length === 0) throw badRequest('the file is empty');
  if (bytes.length > SITE_ASSET_MAX_BYTES) throw new HttpError(413, `an asset may be at most ${SITE_ASSET_MAX_BYTES / 1024 / 1024} MB`);
  if (!verifiedAssetType(name, bytes)) throw badRequest(`the file is not a valid .${extOf(name)}`);

  return withSpaceLock(space, async () => {
    const existing = await listAssetEntries(space);
    const same = existing.find((a) => a.name === name);
    if (same && !replace) throw conflict('an asset with this name already exists');
    const total = existing.reduce((sum, a) => sum + (a.name === name ? 0 : a.size), 0) + bytes.length;
    if (total > SITE_ASSETS_MAX_TOTAL_BYTES) throw new HttpError(413, `.folio/assets/ may hold at most ${SITE_ASSETS_MAX_TOTAL_BYTES / 1024 / 1024} MB`);

    const rel = path.posix.join(APPEARANCE_DIR, ASSETS_DIR, name);
    const touched = await applyPlan(space, new Map([[rel, bytes]]), new Map());
    await commitTouched(space, touched, `settings: ${same ? 'update' : 'add'} ${rel}`, actor);
    const st = await statSiteAsset(space, name);
    const info = await storage.getSpaceInfo(space);
    return { name, size: bytes.length, url: info?.visibility === 'public' ? siteAssetUrl(space, name, st?.version) : null };
  });
}

/** DELETE /api/spaces/:space/appearance/assets/:name. */
export async function deleteAsset(space: string, actor: GitIdentity, name: string): Promise<void> {
  if (!(await storage.spaceExists(space))) throw notFound('space');
  if (!isValidAssetName(name)) throw notFound('asset');
  await withSpaceLock(space, async () => {
    if (!(await statSiteAsset(space, name))) throw notFound('asset');
    const rel = path.posix.join(APPEARANCE_DIR, ASSETS_DIR, name);
    const touched = await applyPlan(space, new Map([[rel, null]]), new Map());
    await commitTouched(space, touched, `settings: remove ${rel}`, actor);
  });
}

// ---------------------------------------------------------------------------
// other settings files of `.folio/` (wave 3: properties.json)
// ---------------------------------------------------------------------------

/** A plain file name directly under `.folio/` that is not one of the appearance files above (those have their own API). */
function isSettingsFileName(file: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file) && !file.includes('..') && !(APPEARANCE_FILES as readonly string[]).includes(file);
}

/** `.folio/<file>` as text with its etag (sha1 of its bytes), or null — same no-symlink rules and cache as the appearance files. */
export async function readFolioSettingsFile(space: string, file: string): Promise<{ content: string; etag: string } | null> {
  if (!isSettingsFileName(file)) return null;
  return readFolioText(space, file);
}

/**
 * Writes one `.folio/<file>` for another settings module (`properties.json`,
 * propertyTypes.ts) exactly the way an appearance save does: under the space's
 * lock, no symlink followed, an atomic write, ONE commit of exactly that path
 * (`settings: update .folio/<file>`). `build` gets the file as it is now (or
 * null) and returns the new content — or null, or the same content, to leave it:
 * then nothing is written or committed. Returns whether a write happened.
 */
export async function writeFolioSettingsFile(
  space: string,
  actor: GitIdentity,
  file: string,
  build: (current: { content: string; etag: string } | null) => string | null,
): Promise<boolean> {
  if (!isSettingsFileName(file)) throw badRequest(`not a settings file: ${file}`);
  return writeFolioFile(space, actor, file, build);
}

/**
 * The one writer of `.folio/` files other than the appearance set: settings
 * files (`properties.json`) and the page property sidecars (propsSidecar.ts,
 * `<path>.props.yaml` at any depth). Under the space's lock, no symlink
 * followed (`.folio/` and every folder under it must be real directories), an
 * atomic write, ONE commit of exactly that path. `build` gets the file as it
 * is now (or null) and returns the new content; null, or the same content,
 * leaves it; '' deletes the file (`settings: remove .folio/<rel>`) and the
 * folders it leaves empty. `build` may throw (a 409 of the caller): nothing is
 * written then. Returns whether the file changed.
 */
export async function writeFolioFile(
  space: string,
  actor: GitIdentity,
  relUnderFolio: string,
  build: (current: { content: string; etag: string } | null) => string | null | Promise<string | null>,
): Promise<boolean> {
  const parts = relUnderFolio.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..') || relUnderFolio.startsWith(`${ASSETS_DIR}/`)) {
    throw badRequest(`not a .folio file: ${relUnderFolio}`);
  }
  if (!(await storage.spaceExists(space))) throw notFound('space');
  return withSpaceLock(space, async () => {
    const nested = parts.length > 1;
    const current = nested ? await readNestedFolioText(space, relUnderFolio) : await readFolioText(space, relUnderFolio);
    const next = await build(current);
    if (next === null || next === current?.content) return false;
    if (next === '' && !current) return false;
    const rel = path.posix.join(APPEARANCE_DIR, relUnderFolio);
    if (next !== '' && nested) await ensureSidecarDirs(storage.getSpaceDir(space), path.posix.dirname(rel));
    const touched = await applyPlan(space, new Map([[rel, next === '' ? null : next]]), new Map());
    if (next === '' && nested) await pruneEmptyFolioDirs(space, path.posix.dirname(rel));
    await commitTouched(space, touched, `settings: ${next === '' ? 'remove' : 'update'} ${rel}`, actor);
    return true;
  });
}

/** A file at any depth under `.folio/`, every folder on the way a real directory; null otherwise. Not cached. */
async function readNestedFolioText(space: string, relUnderFolio: string): Promise<{ content: string; etag: string } | null> {
  let abs = appearanceDir(space);
  for (const part of relUnderFolio.split('/').slice(0, -1)) {
    if (!(await dirIsSafe(abs))) return null;
    abs = path.join(abs, part);
  }
  if (!(await dirIsSafe(abs))) return null;
  const file = path.join(abs, path.posix.basename(relUnderFolio));
  if (!(await plainStat(file, 'file'))) return null;
  const buf = await fs.readFile(file);
  return { content: buf.toString('utf8'), etag: sha1(buf) };
}

/** rmdir of the empty folders from `relDir` (content-root relative) up to, not including, `.folio`. */
async function pruneEmptyFolioDirs(space: string, relDir: string): Promise<void> {
  let dir = relDir;
  while (dir.startsWith(`${APPEARANCE_DIR}/`)) {
    try {
      await fs.rmdir(path.join(storage.getSpaceDir(space), ...dir.split('/')));
    } catch {
      return;
    }
    dir = path.posix.dirname(dir);
  }
}
