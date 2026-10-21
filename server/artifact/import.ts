/**
 * Artifacts: turning what a client sends (ArtifactPublishBody, an uploaded
 * file, a link) into the files of a bundle (docs/spec-artifacts.md §4).
 * No disk, no database — `prepareArtifactBundle` returns the files and the
 * manifest fields; service.ts writes them.
 *
 *  - html (body.html / .html upload / an html link) -> index.html;
 *  - zip -> its files (artifact.yaml or index.html at the root, or in the
 *    single top-level folder); unsafe paths, symlinks, > 500 files or > 50 MB
 *    unpacked are refused;
 *  - svg / markdown / mermaid text -> index.html built around it (svg inline,
 *    markdown via marked and mermaid via mermaid from cdn.jsdelivr.net), the
 *    raw text kept as source.file;
 *  - claude.ai / claude.site / cursor links -> 422 useMcp (never scraped),
 *    a claudeusercontent.com URL or a pasted `<iframe>` -> type embed;
 *  - any other http(s) link -> downloaded (fetchUrl.ts) and handled as above.
 */
import JSZip from 'jszip';
import {
  ARTIFACT_DEFAULT_ENTRY,
  ARTIFACT_LIMITS,
  type ArtifactCapability,
  type ArtifactManifest,
  type ArtifactOrigin,
  type ArtifactPublishBody,
  type ArtifactType,
} from '../../shared/contracts.js';
import { ArtifactImportError } from './errors.js';
import { downloadArtifactUrl } from './fetchUrl.js';
import { ARTIFACT_MANIFEST_FILE, htmlTitle, normalizeBundlePath, parseArtifactManifest, scriptJson } from './manifest.js';

/** Pinned CDN builds for the pages Folio writes around svg / markdown / mermaid text. */
export const MARKED_SRC = 'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js';
export const MERMAID_SRC = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';

export interface UploadedFile {
  filename: string;
  bytes: Buffer;
  /** The client's media type (a hint only; the extension and the bytes decide). */
  contentType?: string;
}

export interface PreparedBundle {
  /** Bundle path -> bytes (never artifact.yaml). Empty for an embed. */
  files: Map<string, Buffer>;
  /** The reserved manifest fields this import determined (title/icon included when known). */
  manifest: Omit<ArtifactManifest, 'folio' | 'version'>;
  /** Properties that came with the import (a zip's artifact.yaml, or body.properties). */
  properties?: Record<string, unknown>;
  /** A title found in the content (html <title>, file name, URL) — used when none was sent. */
  derivedTitle?: string;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export type LinkClass = { kind: 'embed'; url: string } | { kind: 'useMcp'; origin: ArtifactOrigin } | { kind: 'download'; url: string };

/** What Folio does with a link (spec §4): embed it, refuse it (publish through MCP instead), or download it. */
export function classifyArtifactLink(raw: string): LinkClass {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ArtifactImportError('badUrl', 'That is not a valid link.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ArtifactImportError('badUrl', 'Only http and https links can be imported.');
  const host = url.hostname.toLowerCase();
  if (hostIs(host, 'claudeusercontent.com')) {
    if (url.protocol !== 'https:') throw new ArtifactImportError('badUrl', 'An embed link must be https.');
    return { kind: 'embed', url: url.toString() };
  }
  if (hostIs(host, 'claude.ai') || hostIs(host, 'claude.site') || hostIs(host, 'anthropic.com')) return { kind: 'useMcp', origin: 'claude' };
  if (hostIs(host, 'cursor.com') || hostIs(host, 'cursor.sh') || hostIs(host, 'cursor.so')) return { kind: 'useMcp', origin: 'cursor' };
  return { kind: 'download', url: url.toString() };
}

const USE_MCP_MESSAGE: Record<string, string> = {
  claude:
    'Folio does not download claude.ai links. Ask Claude (with the Folio connector) to "publish this artifact to Folio", or paste the embed code from "Get embed code".',
  cursor: 'Folio does not download Cursor links. Ask Cursor (with the Folio MCP server) to publish the canvas to Folio.',
};

/** The https `src` of the first `<iframe>` in pasted embed code. */
export function embedUrlFromCode(code: string): { url: string; height?: number } {
  const tag = /<iframe\b[^>]*>/i.exec(code);
  if (!tag) throw new ArtifactImportError('badUrl', 'The embed code has no <iframe>.');
  const attr = (name: string): string | undefined => {
    const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag[0]);
    return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  };
  const src = attr('src')?.replace(/&amp;/g, '&');
  if (!src) throw new ArtifactImportError('badUrl', 'The embed code has no src.');
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    throw new ArtifactImportError('badUrl', 'The embed code has an invalid src.');
  }
  if (url.protocol !== 'https:') throw new ArtifactImportError('badUrl', 'An embed must be an https URL.');
  const h = Number(attr('height'));
  return Number.isFinite(h) && h > 0 ? { url: url.toString(), height: Math.min(Math.round(h), 10000) } : { url: url.toString() };
}

// ---------------------------------------------------------------------------
// wrappers: svg / markdown / mermaid -> index.html
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title: string, head: string, body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${head}
</head>
<body>
${body}
</body>
</html>
`;
}

const BASE_STYLE = `<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 24px; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 860px; margin: 0 auto; }
  pre { overflow: auto; }
  img, svg { max-width: 100%; height: auto; }
</style>`;

export function wrapSvg(svg: string, title: string): string {
  const inline = svg.replace(/^﻿/, '').replace(/<\?xml[\s\S]*?\?>/i, '').replace(/<!DOCTYPE[\s\S]*?>/i, '').trim();
  return page(title, `<style>html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center}svg{max-width:100%;max-height:100vh;height:auto}</style>`, inline);
}

export function wrapMarkdown(markdown: string, title: string): string {
  return page(
    title,
    `${BASE_STYLE}\n<style>.mermaid{text-align:center}</style>\n<script src="${MARKED_SRC}"></script>`,
    `<main id="content"><pre>${escapeHtml(markdown)}</pre></main>
<script type="application/json" id="folio-markdown">${scriptJson(markdown)}</script>
<script type="module">
  const src = JSON.parse(document.getElementById('folio-markdown').textContent);
  const content = document.getElementById('content');
  if (window.marked) {
    content.innerHTML = window.marked.parse(src);
    const blocks = content.querySelectorAll('code.language-mermaid');
    if (blocks.length > 0) {
      blocks.forEach((code) => {
        const pre = document.createElement('pre');
        pre.className = 'mermaid';
        pre.textContent = code.textContent;
        (code.parentElement && code.parentElement.tagName === 'PRE' ? code.parentElement : code).replaceWith(pre);
      });
      try {
        const { default: mermaid } = await import('${MERMAID_SRC}');
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' });
        await mermaid.run({ querySelector: 'pre.mermaid' });
      } catch (e) {
        /* the CDN is unreachable: the diagrams stay as text */
      }
    }
  }
</script>`,
  );
}

export function wrapMermaid(diagram: string, title: string): string {
  return page(
    title,
    `${BASE_STYLE}\n<style>.mermaid{text-align:center}</style>`,
    `<main><pre class="mermaid">${escapeHtml(diagram)}</pre></main>
<script type="module">
  import mermaid from '${MERMAID_SRC}';
  mermaid.initialize({ startOnLoad: true, securityLevel: 'strict', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' });
</script>`,
  );
}

const TEXT_SOURCE_FILE: Partial<Record<ArtifactType, string>> = { svg: 'source.svg', markdown: 'source.md', mermaid: 'source.mmd' };

function wrapText(type: ArtifactType, text: string, title: string): { entry: string; source: string } {
  if (type === 'svg') return { entry: wrapSvg(text, title), source: TEXT_SOURCE_FILE.svg! };
  if (type === 'markdown') return { entry: wrapMarkdown(text, title), source: TEXT_SOURCE_FILE.markdown! };
  if (type === 'mermaid') return { entry: wrapMermaid(text, title), source: TEXT_SOURCE_FILE.mermaid! };
  throw new ArtifactImportError('unsupportedType', `Text can be imported as svg, markdown or mermaid, not ${type}.`);
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** Reads one entry, refusing to inflate past `budget` bytes (a zip bomb stops at the limit, not at the end of memory). */
function inflateEntry(entry: JSZip.JSZipObject, budget: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    // internalStream is JSZip's streaming reader; typed loosely in its d.ts.
    const stream = (entry as unknown as { internalStream(type: 'uint8array'): { on(ev: string, fn: (arg?: unknown) => void): unknown; pause(): void; resume(): void } }).internalStream('uint8array');
    stream.on('data', (chunk) => {
      if (done) return;
      const buf = Buffer.from(chunk as Uint8Array);
      size += buf.length;
      if (size > budget) {
        done = true;
        stream.pause();
        reject(new ArtifactImportError('tooLarge', `The archive unpacks to more than ${ARTIFACT_LIMITS.maxBundleBytes / 1024 / 1024} MB.`));
        return;
      }
      chunks.push(buf);
    });
    stream.on('error', (err) => {
      if (done) return;
      done = true;
      reject(new ArtifactImportError('badZip', `The archive cannot be read: ${(err as Error)?.message ?? 'error'}`));
    });
    stream.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    stream.resume();
  });
}

/** The files of a zip, with the single top-level folder stripped when the root has neither artifact.yaml nor index.html. */
export async function unpackZip(bytes: Buffer): Promise<Map<string, Buffer>> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch (err) {
    throw new ArtifactImportError('badZip', `The archive cannot be read: ${err instanceof Error ? err.message : 'not a zip'}`);
  }
  const entries: Array<{ rel: string; entry: JSZip.JSZipObject }> = [];
  for (const entry of Object.values(zip.files)) {
    // JSZip quietly rewrites `../x` to `x` on load and keeps what the archive said here: judge that.
    const name = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    // macOS resource forks and dot files never belong to the page.
    if (name.startsWith('__MACOSX/') || name.split('/').some((p) => p.startsWith('.') && p !== '.' && p !== '..')) continue;
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.includes('\\') || name.split('/').includes('..')) {
      throw new ArtifactImportError('badZip', `The archive holds an unsafe path: ${name.slice(0, 200)}`);
    }
    const mode = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : 0;
    if ((mode & S_IFMT) === S_IFLNK) throw new ArtifactImportError('badZip', `The archive holds a symbolic link: ${name.slice(0, 200)}`);
    if (entry.dir) continue;
    const rel = name === ARTIFACT_MANIFEST_FILE ? name : normalizeBundlePath(name);
    if (rel === null) {
      // artifact.yaml deeper than the root (the single-folder case) is handled after the strip below.
      if (name.toLowerCase().endsWith(`/${ARTIFACT_MANIFEST_FILE}`) || name.toLowerCase() === ARTIFACT_MANIFEST_FILE) {
        entries.push({ rel: name.replace(/^\.\//, ''), entry });
        continue;
      }
      throw new ArtifactImportError('badZip', `The archive holds an unsafe path: ${name.slice(0, 200)}`);
    }
    entries.push({ rel, entry });
    if (entries.length > ARTIFACT_LIMITS.maxFiles + 1) throw new ArtifactImportError('tooManyFiles', `The archive holds more than ${ARTIFACT_LIMITS.maxFiles} files.`);
  }
  // One folder at the top and nothing to render at the root: that folder is the bundle.
  const atRoot = (p: string) => entries.some((e) => e.rel.toLowerCase() === p);
  if (!atRoot(ARTIFACT_MANIFEST_FILE) && !atRoot(ARTIFACT_DEFAULT_ENTRY)) {
    const tops = new Set(entries.map((e) => (e.rel.includes('/') ? e.rel.slice(0, e.rel.indexOf('/')) : '')));
    if (tops.size === 1 && !tops.has('')) {
      const prefix = `${[...tops][0]}/`;
      for (const e of entries) e.rel = e.rel.slice(prefix.length);
    }
  }
  const files = new Map<string, Buffer>();
  let budget = ARTIFACT_LIMITS.maxBundleBytes;
  for (const { rel, entry } of entries) {
    const target = rel === ARTIFACT_MANIFEST_FILE ? rel : normalizeBundlePath(rel);
    if (target === null) {
      // A nested artifact.yaml (not the bundle's own) is just a file nobody reads; dropped.
      if (rel.toLowerCase().endsWith(ARTIFACT_MANIFEST_FILE)) continue;
      throw new ArtifactImportError('badZip', `The archive holds an unsafe path: ${rel.slice(0, 200)}`);
    }
    const bytesOut = await inflateEntry(entry, budget);
    budget -= bytesOut.length;
    files.set(target, bytesOut);
  }
  if (files.size - (files.has(ARTIFACT_MANIFEST_FILE) ? 1 : 0) > ARTIFACT_LIMITS.maxFiles) {
    throw new ArtifactImportError('tooManyFiles', `The archive holds more than ${ARTIFACT_LIMITS.maxFiles} files.`);
  }
  return files;
}

// ---------------------------------------------------------------------------
// one file (upload or download) by its kind
// ---------------------------------------------------------------------------

type FileKind = 'html' | 'zip' | 'svg' | 'markdown' | 'mermaid';

function isZipBytes(b: Buffer): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06);
}

/** What a file is, from its name, its bytes and (last) the media type. */
export function fileKindOf(filename: string, bytes: Buffer, contentType = ''): FileKind {
  const lower = filename.toLowerCase();
  if (isZipBytes(bytes)) return 'zip';
  if (lower.endsWith('.zip')) throw new ArtifactImportError('badZip', 'The file is not a zip archive.');
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.svg')) return 'svg';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.mmd') || lower.endsWith('.mermaid')) return 'mermaid';
  const ct = contentType.toLowerCase();
  if (ct === 'text/html' || ct === 'application/xhtml+xml') return 'html';
  if (ct === 'image/svg+xml') return 'svg';
  if (ct === 'text/markdown' || ct === 'text/x-markdown') return 'markdown';
  if (ct === 'application/zip' || ct === 'application/x-zip-compressed') return 'zip';
  const head = bytes.subarray(0, 1024).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  throw new ArtifactImportError('unsupportedType', 'Import an .html, .htm, .zip, .svg or .md file.');
}

/** `report-final.html` -> `report-final`; a URL's last path segment likewise. */
function nameStem(filename: string): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim();
  try {
    return decodeURIComponent(stem);
  } catch {
    return stem;
  }
}

// ---------------------------------------------------------------------------
// the whole import
// ---------------------------------------------------------------------------

function decodeFileContent(path: string, content: string, encoding: 'utf8' | 'base64'): Buffer {
  if (encoding === 'base64') {
    if (!/^[A-Za-z0-9+/=\s_-]*$/.test(content)) throw new ArtifactImportError('badPath', `${path}: content is not valid base64.`);
    return Buffer.from(content, 'base64');
  }
  return Buffer.from(content, 'utf8');
}

function defaultSourceName(type: ArtifactType | undefined): string {
  if (type === 'canvas-tsx') return 'source.canvas.tsx';
  if (type === 'svg') return 'source.svg';
  if (type === 'markdown') return 'source.md';
  if (type === 'mermaid') return 'source.mmd';
  if (type === 'html') return 'source.html';
  return 'source.jsx';
}

/**
 * Everything the body (and an uploaded file) says, as bundle files + manifest fields.
 * Throws ArtifactImportError for anything refused. `forReplace`: the page exists
 * (parentPath ignored; nothing else differs here).
 */
export async function prepareArtifactBundle(body: ArtifactPublishBody, upload?: UploadedFile): Promise<PreparedBundle> {
  const warnings: string[] = [];
  const files = new Map<string, Buffer>();
  let type: ArtifactType | undefined = body.type;
  let entry = body.entry !== undefined ? normalizeBundlePath(body.entry) : undefined;
  if (body.entry !== undefined && entry === null) throw new ArtifactImportError('badPath', `The entry ${JSON.stringify(body.entry)} is not a safe path inside the bundle.`);
  let origin: ArtifactOrigin | undefined = body.origin;
  let sourceUrl = body.sourceUrl;
  let sourceFile: string | undefined;
  let embed: ArtifactManifest['embed'];
  let derivedTitle: string | undefined;
  /** The title is only the zip's file name: the entry's own <title> is better when it has one. */
  let zipStemTitle = false;
  let zipManifest: ReturnType<typeof parseArtifactManifest> | undefined;
  let capabilities: ArtifactCapability[] | undefined = body.capabilities;

  /** A single file (upload or download) into the bundle. */
  const takeFile = async (file: UploadedFile): Promise<void> => {
    const kind = fileKindOf(file.filename, file.bytes, file.contentType);
    const stem = nameStem(file.filename);
    if (kind === 'zip') {
      const unpacked = await unpackZip(file.bytes);
      const manifestBytes = unpacked.get(ARTIFACT_MANIFEST_FILE);
      unpacked.delete(ARTIFACT_MANIFEST_FILE);
      if (manifestBytes) zipManifest = parseArtifactManifest(manifestBytes.toString('utf8'), `${stem || 'artifact'}.artifact`);
      for (const [p, b] of unpacked) files.set(p, b);
      if (!derivedTitle && stem) {
        derivedTitle = stem;
        zipStemTitle = true;
      }
      return;
    }
    const text = file.bytes.toString('utf8');
    if (kind === 'html') {
      files.set(entry ?? ARTIFACT_DEFAULT_ENTRY, file.bytes);
      derivedTitle = htmlTitle(text) ?? (stem || undefined);
      type ??= 'html';
      return;
    }
    // The file's own kind, unless the caller named another text kind for it (a .txt of mermaid, say).
    type = body.type === 'svg' || body.type === 'markdown' || body.type === 'mermaid' ? body.type : kind;
    derivedTitle = stem || undefined;
    const wrapped = wrapText(type, text, body.title ?? derivedTitle ?? 'Artifact');
    files.set(ARTIFACT_DEFAULT_ENTRY, Buffer.from(wrapped.entry, 'utf8'));
    files.set(wrapped.source, file.bytes);
    sourceFile = wrapped.source;
    entry = ARTIFACT_DEFAULT_ENTRY;
  };

  // 1. A link or embed code.
  if (body.embedCode !== undefined && body.embedCode.trim() !== '') {
    const e = embedUrlFromCode(body.embedCode);
    embed = e;
    type = 'embed';
    origin ??= /claudeusercontent\.com|claude\.(ai|site)/i.test(e.url) ? 'claude' : 'other';
  } else if (body.url !== undefined && body.url.trim() !== '') {
    const link = classifyArtifactLink(body.url);
    if (link.kind === 'useMcp') throw new ArtifactImportError('useMcp', USE_MCP_MESSAGE[link.origin]);
    if (link.kind === 'embed') {
      embed = { url: link.url };
      type = 'embed';
      origin ??= 'claude';
    } else {
      const got = await downloadArtifactUrl(link.url);
      sourceUrl ??= link.url;
      origin ??= 'url';
      let name = '';
      try {
        name = new URL(got.finalUrl).pathname;
      } catch {
        /* no name */
      }
      if (!name || name.endsWith('/')) name = `${name}index`;
      await takeFile({ filename: name, bytes: got.bytes, contentType: got.contentType });
    }
  }

  // 2. An uploaded file.
  if (upload) {
    origin ??= 'upload';
    await takeFile(upload);
  }

  // 3. Inline content.
  if (body.html !== undefined) {
    if (type === 'embed') throw new ArtifactImportError('unsupportedType', 'An embed has no HTML of its own.');
    files.set(entry ?? ARTIFACT_DEFAULT_ENTRY, Buffer.from(body.html, 'utf8'));
    derivedTitle ??= htmlTitle(body.html);
  }
  if (body.text !== undefined) {
    if (!type || (type !== 'svg' && type !== 'markdown' && type !== 'mermaid')) {
      throw new ArtifactImportError('unsupportedType', '`text` needs type svg, markdown or mermaid.');
    }
    const wrapped = wrapText(type, body.text, body.title ?? 'Artifact');
    files.set(ARTIFACT_DEFAULT_ENTRY, Buffer.from(wrapped.entry, 'utf8'));
    files.set(wrapped.source, Buffer.from(body.text, 'utf8'));
    sourceFile = wrapped.source;
    entry = ARTIFACT_DEFAULT_ENTRY;
  }
  for (const f of body.files ?? []) {
    const rel = normalizeBundlePath(f.path);
    if (rel === null) throw new ArtifactImportError('badPath', `${JSON.stringify(f.path)} is not a safe path inside the bundle (no "..", no leading "/", not artifact.yaml, not under __folio/, no dot files).`);
    files.set(rel, decodeFileContent(rel, f.content, f.encoding));
  }
  if (body.sourceCode !== undefined) {
    const name = body.sourceFileName !== undefined ? normalizeBundlePath(body.sourceFileName) : defaultSourceName(type);
    if (name === null) throw new ArtifactImportError('badPath', `${JSON.stringify(body.sourceFileName)} is not a safe file name inside the bundle.`);
    files.set(name, Buffer.from(body.sourceCode, 'utf8'));
    sourceFile = name;
    if (!type || type === 'html') type = name.toLowerCase().endsWith('.canvas.tsx') ? 'canvas-tsx' : /\.(jsx|tsx)$/i.test(name) ? 'react' : (type ?? 'html');
  }

  // 4. A zip's own manifest fills what the body did not say.
  const zm = zipManifest?.manifest;
  if (zm) {
    if (!body.type && zm.type) type = zm.type;
    if (body.entry === undefined && zm.entry) entry = zm.entry;
    if (zm.embed && !embed) embed = zm.embed;
    if (!sourceFile && zm.source?.file) sourceFile = zm.source.file;
    if (!origin && zm.source?.origin) origin = zm.source.origin;
    if (!sourceUrl && zm.source?.url) sourceUrl = zm.source.url;
    if (!capabilities && zm.capabilities) capabilities = zm.capabilities;
    if (zm.title && zipManifest?.present) {
      derivedTitle = zm.title;
      zipStemTitle = false;
    }
    warnings.push(...(zipManifest?.warnings ?? []));
  }

  type ??= 'html';
  // Limits.
  let total = 0;
  for (const b of files.values()) total += b.length;
  if (files.size > ARTIFACT_LIMITS.maxFiles) throw new ArtifactImportError('tooManyFiles', `An artifact holds at most ${ARTIFACT_LIMITS.maxFiles} files.`);
  if (total > ARTIFACT_LIMITS.maxBundleBytes) throw new ArtifactImportError('tooLarge', `An artifact holds at most ${ARTIFACT_LIMITS.maxBundleBytes / 1024 / 1024} MB.`);

  if (type === 'embed') {
    if (!embed) throw new ArtifactImportError('noEntry', 'An embed artifact needs an embed link or embed code.');
    if (files.size > 0) warnings.push('An embed artifact shows the embedded page; the files sent were not stored.');
    files.clear();
    entry = undefined;
  } else {
    entry ??= ARTIFACT_DEFAULT_ENTRY;
    if (!files.has(entry)) {
      // A bundle with exactly one html file and no index.html: that file is the entry.
      const htmls = [...files.keys()].filter((p) => /\.html?$/i.test(p));
      if (body.entry === undefined && htmls.length === 1) entry = htmls[0];
      else throw new ArtifactImportError('noEntry', `Nothing to render: the bundle has no ${entry}.`);
    }
    if (!/\.html?$/i.test(entry)) throw new ArtifactImportError('noEntry', `The entry ${entry} must be an .html file.`);
    if (zipStemTitle) derivedTitle = htmlTitle(files.get(entry)!.toString('utf8')) ?? derivedTitle;
  }

  const extra = (capabilities ?? []).filter((c) => c !== 'storage');
  if (extra.length > 0) warnings.push(`Folio provides only storage to artifacts; ${extra.join(', ')} will not work.`);

  const manifest: PreparedBundle['manifest'] = { type };
  if (entry) manifest.entry = entry;
  if (embed) manifest.embed = embed;
  if (capabilities && capabilities.length > 0) manifest.capabilities = [...new Set(capabilities)];
  const source: NonNullable<ArtifactManifest['source']> = { importedAt: new Date().toISOString() };
  if (origin) source.origin = origin;
  if (sourceUrl) source.url = sourceUrl;
  if (sourceFile && (type === 'embed' || files.has(sourceFile))) source.file = sourceFile;
  manifest.source = source;
  if (body.title) manifest.title = body.title;
  if (body.icon) manifest.icon = body.icon;

  let properties: Record<string, unknown> | undefined;
  if (zipManifest && Object.keys(zipManifest.properties).length > 0) properties = { ...zipManifest.properties };
  if (body.properties) properties = { ...(properties ?? {}), ...body.properties };
  if (!derivedTitle && embed) derivedTitle = 'Embedded artifact';
  return { files, manifest, properties, derivedTitle, warnings };
}
