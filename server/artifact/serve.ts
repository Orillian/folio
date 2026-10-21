/**
 * Artifacts: `GET /art/<token>/<path in the bundle>` (docs/spec-artifacts.md §3).
 *
 * Registered OUTSIDE the session scope: the iframe that loads these files is
 * sandboxed without allow-same-origin, so it has no Folio cookies — the signed
 * token (token.ts) is the whole credential, minted per reader into
 * PageDoc.artifact.src. Every response carries the sandbox CSP below, so even
 * a file opened directly in a tab runs in an opaque origin; ACAO * lets that
 * opaque origin load the bundle's own modules and JSON through CORS.
 *
 * The entry page gets the host bridge (bridge.js) INLINED in a <script> right
 * after its <meta charset> (or first in <head>), with the reader's localStorage
 * state in front for a signed-in reader, so the polyfill is full before the
 * page's own scripts run. `/art/<token>/__folio/bridge.js` serves the same code.
 */
import { createReadStream, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ARTIFACT_CDN_ALLOWLIST } from '../../shared/contracts.js';
import * as storage from '../storage.js';
import { readBundleInfo, resolveBundleFile } from './bundle.js';
import { FOLIO_RESERVED_DIR, scriptJson } from './manifest.js';
import { readArtifactState } from './state.js';
import { artifactsOrigin, verifyArtifactToken } from './token.js';

const CDN = ARTIFACT_CDN_ALLOWLIST.join(' ');

/** The CSP of every /art response — exactly the spec's. */
export const ARTIFACT_CSP = [
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads',
  "default-src 'self' data: blob:",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${CDN}`,
  `style-src 'self' 'unsafe-inline' ${CDN} https://fonts.googleapis.com`,
  `font-src 'self' data: https://fonts.gstatic.com ${CDN}`,
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  `connect-src 'self' ${CDN}`,
  "frame-src 'none'",
  "form-action 'none'",
].join('; ');

export const ARTIFACT_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': ARTIFACT_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'access-control-allow-origin': '*',
  'cache-control': 'private, max-age=300',
};

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  jsx: 'text/plain; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  mmd: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  yaml: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
};

export function artifactContentType(rel: string): string {
  const dot = rel.lastIndexOf('.');
  return (dot >= 0 && TYPES[rel.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

let bridgeSource: string | null = null;
function bridgeScript(): string {
  bridgeSource ??= readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge.js'), 'utf8');
  return bridgeSource;
}

/** The URL the bridge is also served from (absolute on ARTIFACTS_ORIGIN when set). The entry page inlines it instead. */
export function bridgeUrl(token: string): string {
  return `${artifactsOrigin()}/art/${token}/${FOLIO_RESERVED_DIR}/bridge.js`;
}

/** The bridge preceded by the reader's localStorage state (when there is one), ready to serve or inline. */
async function bridgeWithState(entryId: string, userId: string | null | undefined): Promise<string> {
  let prefix = '';
  if (userId) {
    const state = await readArtifactState(entryId, userId).catch(() => null);
    if (state) prefix = `window.__FOLIO_ARTIFACT_PRELOAD__=${scriptJson(state)};\n`;
  }
  return prefix + bridgeScript();
}

/**
 * `html` with the bridge code INLINE in a `<script>`: right after the `<meta charset>` of the <head> when it has
 * one, otherwise as the first child of <head> (a <head> is made when the page has none). Inline, because a
 * sub-request from the sandboxed (opaque-origin) frame can be blocked by a browser or an extension.
 */
export function injectBridge(html: string, code: string): string {
  const tag = `<script>${code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')}</script>`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) {
    const start = head.index + head[0].length;
    const close = /<\/head\s*>|<body[\s>]/i.exec(html.slice(start));
    const inner = html.slice(start, close ? start + close.index : undefined);
    const meta = /<meta\s[^>]*charset[^>]*>/i.exec(inner);
    const at = meta ? start + meta.index + meta[0].length : start;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const htmlTag = /<html(?:\s[^>]*)?>/i.exec(html);
  if (htmlTag) return html.slice(0, htmlTag.index + htmlTag[0].length) + `<head>${tag}</head>` + html.slice(htmlTag.index + htmlTag[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype[0].length) + `<head>${tag}</head>` + html.slice(doctype[0].length);
  return `<head>${tag}</head>${html}`;
}

function fail(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply.status(status).headers(ARTIFACT_HEADERS).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send(message);
}

export function registerArtifactServeRoutes(app: FastifyInstance): void {
  // One wildcard, split here: a token is longer than the router's 100-character limit for a `:param`.
  app.get('/art/*', async (request, reply) => {
    const wildcard = (request.params as { '*': string })['*'] ?? '';
    const slash = wildcard.indexOf('/');
    const token = slash === -1 ? wildcard : wildcard.slice(0, slash);
    const rest = slash === -1 ? '' : wildcard.slice(slash + 1);
    const claims = verifyArtifactToken(token);
    if (!claims) return fail(reply, 403, 'This artifact link has expired. Reload the page in Folio.');
    const entry = await storage.getEntry(claims.pageId);
    if (!entry || entry.kind !== 'artifact') return fail(reply, 404, 'not found');
    const rel = (rest ?? '').replace(/^\/+/, '');

    if (rel === `${FOLIO_RESERVED_DIR}/bridge.js`) {
      const code = await bridgeWithState(entry.id, claims.userId);
      return reply
        .headers(ARTIFACT_HEADERS)
        .header('cache-control', claims.userId ? 'private, no-store' : 'private, max-age=300')
        .type('text/javascript; charset=utf-8')
        .send(code);
    }

    const abs = await resolveBundleFile(entry.absPath, rel);
    if (!abs) return fail(reply, 404, 'not found');
    const info = await readBundleInfo(entry.absPath);
    reply.headers(ARTIFACT_HEADERS).type(artifactContentType(rel));
    if (info.manifest.type !== 'embed' && rel === info.manifest.entry) {
      const html = await fs.readFile(abs, 'utf8');
      // The inlined bridge carries the reader's state: the entry is never cached or shared.
      return reply.header('cache-control', 'private, no-store').send(injectBridge(html, await bridgeWithState(entry.id, claims.userId)));
    }
    const st = await fs.stat(abs);
    reply.header('content-length', String(st.size));
    return reply.send(createReadStream(abs));
  });
}
