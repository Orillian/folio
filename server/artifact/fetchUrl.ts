/**
 * Artifacts: downloading an artifact from a link (docs/spec-artifacts.md §4).
 * The URL is user-supplied, so the fetch is hardened against SSRF the same way
 * the OAuth client-metadata fetch is (oauth/cimd.ts, whose address check this
 * reuses): http/https only, no credentials in the URL, every resolved address
 * must be public and is checked AT CONNECT TIME (the `lookup` hook — DNS
 * rebinding cannot swap it afterwards), a literal IP is checked before
 * connecting, at most 3 redirects with the same checks on each hop, 15 s for
 * the whole download, at most 20 MB.
 */
import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { ARTIFACT_LIMITS } from '../../shared/contracts.js';
import { isPublicAddress } from '../oauth/cimd.js';
import { ArtifactImportError } from './errors.js';

export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 3;

export interface DownloadedFile {
  bytes: Buffer;
  /** Lowercase media type without parameters ('' when absent). */
  contentType: string;
  /** The URL the bytes came from (after redirects). */
  finalUrl: string;
}

const guardedLookup: typeof dns.lookup = ((hostname: string, options: dns.LookupOptions | number | undefined, callback: (...args: unknown[]) => void) => {
  const opts = typeof options === 'object' && options !== null ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      return callback(new ArtifactImportError('badUrl', 'The link points at a private or local address.'));
    }
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}) as typeof dns.lookup;

/** The URL as a fetch target, or an ArtifactImportError('badUrl'). */
export function checkFetchUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ArtifactImportError('badUrl', 'That is not a valid link.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ArtifactImportError('badUrl', 'Only http and https links can be imported.');
  if (url.username || url.password) throw new ArtifactImportError('badUrl', 'Links with a user name or password are not imported.');
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare) && !isPublicAddress(bare)) throw new ArtifactImportError('badUrl', 'The link points at a private or local address.');
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.internal') || bare.endsWith('.local')) {
    throw new ArtifactImportError('badUrl', 'The link points at a private or local address.');
  }
  return url;
}

function getOnce(url: URL, deadline: number, maxBytes: number): Promise<{ status: number; location?: string; contentType: string; bytes?: Buffer }> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new ArtifactImportError('badUrl', 'The download timed out.'));
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      { method: 'GET', headers: { accept: '*/*', 'user-agent': 'Folio-Artifact-Import/1' }, lookup: guardedLookup, timeout: remaining },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ status, location: String(res.headers.location), contentType });
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new ArtifactImportError('badUrl', `The link answered HTTP ${status || '?'}.`));
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.resume();
          req.destroy();
          reject(new ArtifactImportError('tooLarge', `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new ArtifactImportError('tooLarge', `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status, contentType, bytes: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new ArtifactImportError('badUrl', 'The download timed out.')), remaining);
    req.on('close', () => clearTimeout(timer));
    req.on('timeout', () => req.destroy(new ArtifactImportError('badUrl', 'The download timed out.')));
    req.on('error', (err) => reject(err instanceof ArtifactImportError ? err : new ArtifactImportError('badUrl', `The link could not be downloaded: ${err.message}`)));
    req.end();
  });
}

async function defaultDownload(raw: string): Promise<DownloadedFile> {
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  let url = checkFetchUrl(raw);
  for (let hop = 0; ; hop++) {
    const res = await getOnce(url, deadline, ARTIFACT_LIMITS.maxUrlDownloadBytes);
    if (res.location !== undefined) {
      if (hop >= MAX_REDIRECTS) throw new ArtifactImportError('badUrl', 'The link redirects too many times.');
      let next: string;
      try {
        next = new URL(res.location, url).toString();
      } catch {
        throw new ArtifactImportError('badUrl', 'The link redirects to an invalid address.');
      }
      url = checkFetchUrl(next);
      continue;
    }
    return { bytes: res.bytes ?? Buffer.alloc(0), contentType: res.contentType, finalUrl: url.toString() };
  }
}

let downloader: (url: string) => Promise<DownloadedFile> = defaultDownload;

export function downloadArtifactUrl(url: string): Promise<DownloadedFile> {
  return downloader(url);
}

/** Test hook: replaces the network download. */
export function __setArtifactDownloaderForTests(fn: ((url: string) => Promise<DownloadedFile>) | null): void {
  downloader = fn ?? defaultDownload;
}
