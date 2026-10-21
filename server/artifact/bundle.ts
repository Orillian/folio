/**
 * Artifacts: the bundle directory on disk (`<slug>.artifact/`). Reading it
 * (manifest + file list), fingerprinting it for the scan, resolving a file
 * inside it safely for /art, writing a whole new bundle atomically enough
 * (temp sibling + rename swap), and zipping it for download.
 *
 * Pure fs — no database, no space lookups — so storage.ts can use it without
 * an import cycle.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { ARTIFACT_LIMITS, type ArtifactManifest } from '../../shared/contracts.js';
import { ARTIFACT_MANIFEST_FILE, htmlVisibleText, parseArtifactManifest, type ParsedArtifactManifest } from './manifest.js';

/**
 * Temp siblings a bundle write leaves only when its process died mid-swap: `.q3.artifact.<pid>.<hex>.tmp` (new) and
 * `.q3.artifact.<pid>.<hex>o.tmp` (old). Shaped like writeFileAtomic's temp names so git's ATOMIC_TEMP_PATHSPEC never
 * stages one either.
 */
const TEMP_BUNDLE_RE = /^\..+\.artifact\.\d+\.[0-9a-f]+o?\.tmp$/i;

export function isTempBundleName(name: string): boolean {
  return TEMP_BUNDLE_RE.test(name);
}

/** Removes a leftover temp bundle directory older than `minAgeMs` (a live write holds the space lock for seconds at most). */
export async function removeOrphanTempBundle(abs: string, minAgeMs = 10 * 60 * 1000): Promise<void> {
  try {
    const st = await fs.lstat(abs);
    if (!st.isDirectory() || Date.now() - st.mtimeMs < minAgeMs) return;
    await fs.rm(abs, { recursive: true, force: true });
  } catch {
    /* gone already */
  }
}

export interface BundleFile {
  /** POSIX path inside the bundle. */
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Every regular file of the bundle (the manifest included), sorted by path. Symlinks and
 * dot entries are skipped (never served, never zipped). Stops after `limit` files.
 */
export async function listBundleFiles(dirAbs: string, limit = ARTIFACT_LIMITS.maxFiles * 2): Promise<{ files: BundleFile[]; dirMtimeMs: number; truncated: boolean }> {
  const files: BundleFile[] = [];
  let dirMtimeMs = 0;
  let truncated = false;
  async function walk(abs: string, rel: string, depth: number): Promise<void> {
    if (depth > 32 || truncated) return;
    let st;
    try {
      st = await fs.lstat(abs);
    } catch {
      return;
    }
    dirMtimeMs = Math.max(dirMtimeMs, st.mtimeMs);
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      const childAbs = path.join(abs, d.name);
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        await walk(childAbs, childRel, depth + 1);
      } else if (d.isFile()) {
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        const fst = await fs.lstat(childAbs).catch(() => null);
        if (fst?.isFile()) files.push({ path: childRel, size: fst.size, mtimeMs: fst.mtimeMs });
      }
    }
  }
  await walk(dirAbs, '', 0);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, dirMtimeMs, truncated };
}

/**
 * What the scan compares to decide whether a bundle changed: the newest mtime of any
 * file or folder in it, and the total size plus the file count (a file removed and
 * another of the same size added still moves the folder's mtime).
 */
export async function bundleFingerprint(dirAbs: string): Promise<{ mtime: Date; size: number }> {
  const { files, dirMtimeMs } = await listBundleFiles(dirAbs);
  let mtimeMs = dirMtimeMs;
  let size = 0;
  for (const f of files) {
    mtimeMs = Math.max(mtimeMs, f.mtimeMs);
    size += f.size;
  }
  // Whole milliseconds: timestamptz keeps microseconds, but the comparison must be exact across a round trip.
  return { mtime: new Date(Math.floor(mtimeMs)), size: size + files.length };
}

export interface BundleInfo extends ParsedArtifactManifest {
  /** Files other than the manifest, sorted by path. */
  files: Array<{ path: string; size: number }>;
  /** The manifest's text (null without one). */
  manifestText: string | null;
}

/** Text of the bundle's artifact.yaml, null without one (or when it is not a regular file / too large). */
export async function readManifestText(dirAbs: string): Promise<string | null> {
  const abs = path.join(dirAbs, ARTIFACT_MANIFEST_FILE);
  try {
    const st = await fs.lstat(abs);
    if (!st.isFile() || st.size > 256 * 1024) return null;
    return await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Manifest, file list and the problems a reader should see (no entry, unsafe manifest…). */
export async function readBundleInfo(dirAbs: string): Promise<BundleInfo> {
  const manifestText = await readManifestText(dirAbs);
  const parsed = parseArtifactManifest(manifestText, path.basename(dirAbs));
  const { files, truncated } = await listBundleFiles(dirAbs);
  const listed = files.filter((f) => f.path !== ARTIFACT_MANIFEST_FILE).map((f) => ({ path: f.path, size: f.size }));
  const warnings = [...parsed.warnings];
  if (truncated) warnings.push(`The bundle has more than ${ARTIFACT_LIMITS.maxFiles * 2} files; only the first are listed.`);
  const m = parsed.manifest;
  if (m.type !== 'embed' && m.entry && !listed.some((f) => f.path === m.entry)) warnings.push(`The entry file ${m.entry} is missing from the bundle.`);
  if (m.source?.file && !listed.some((f) => f.path === m.source!.file)) warnings.push(`The source file ${m.source.file} is missing from the bundle.`);
  return { ...parsed, warnings, files: listed, manifestText };
}

/**
 * The absolute path of `rel` inside the bundle when it is a regular file reached without
 * crossing a symlink (the bundle directory itself may not be one either); null otherwise.
 */
export async function resolveBundleFile(dirAbs: string, rel: string): Promise<string | null> {
  if (!rel || rel.split('/').some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.'))) return null;
  if (/[\u0000\\]/.test(rel)) return null;
  try {
    const realDir = await fs.realpath(dirAbs);
    const wanted = path.join(realDir, ...rel.split('/'));
    const real = await fs.realpath(wanted);
    if (real !== wanted) return null;
    const st = await fs.lstat(real);
    return st.isFile() ? real : null;
  } catch {
    return null;
  }
}

/** The text a scan indexes for an artifact: its title, then what a reader sees in the entry page. */
export async function bundleSearchText(dirAbs: string, info: Pick<BundleInfo, 'manifest'>): Promise<string> {
  const m: ArtifactManifest = info.manifest;
  const parts: string[] = [];
  if (m.title) parts.push(m.title);
  if (m.type !== 'embed' && m.entry) {
    const abs = await resolveBundleFile(dirAbs, m.entry);
    if (abs) {
      const st = await fs.stat(abs).catch(() => null);
      if (st && st.size <= 8 * 1024 * 1024) {
        parts.push(htmlVisibleText(await fs.readFile(abs, 'utf8').catch(() => '')));
      }
    }
  }
  return parts.join('\n').slice(0, 100 * 1024);
}

/**
 * Writes a whole bundle at `targetAbs`: every file of `files` plus artifact.yaml
 * (`manifestText`, or none when null), replacing whatever was there. The new bundle is
 * built in a dot-named temp sibling, then swapped in with two renames (the old one is
 * removed afterwards) — a reader sees the old bundle or the new one, never a half.
 */
export async function writeBundleDir(targetAbs: string, files: ReadonlyMap<string, Buffer>, manifestText: string | null): Promise<void> {
  const parent = path.dirname(targetAbs);
  const name = path.basename(targetAbs);
  const tag = randomBytes(6).toString('hex');
  const tmp = path.join(parent, `.${name}.${process.pid}.${tag}.tmp`);
  const old = path.join(parent, `.${name}.${process.pid}.${tag}o.tmp`);
  await fs.mkdir(parent, { recursive: true });
  await fs.mkdir(tmp);
  try {
    for (const [rel, bytes] of files) {
      const abs = path.join(tmp, ...rel.split('/'));
      if (!abs.startsWith(tmp + path.sep)) throw new Error(`unsafe bundle path ${rel}`);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, bytes);
    }
    if (manifestText !== null) await fs.writeFile(path.join(tmp, ARTIFACT_MANIFEST_FILE), manifestText, 'utf8');
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  let hadOld = false;
  try {
    await fs.rename(targetAbs, old);
    hadOld = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }
  try {
    await fs.rename(tmp, targetAbs);
  } catch (err) {
    if (hadOld) await fs.rename(old, targetAbs).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  if (hadOld) await fs.rm(old, { recursive: true, force: true }).catch(() => {});
}

/** Replaces only artifact.yaml of an existing bundle (atomic file write). */
export async function writeManifestFile(dirAbs: string, text: string): Promise<void> {
  const abs = path.join(dirAbs, ARTIFACT_MANIFEST_FILE);
  const tmp = path.join(dirAbs, `.${ARTIFACT_MANIFEST_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** The bundle as a zip (the manifest included), rooted at `<stem>.artifact/`. */
export async function zipBundle(dirAbs: string): Promise<Buffer> {
  const zip = new JSZip();
  const root = zip.folder(path.basename(dirAbs))!;
  const { files } = await listBundleFiles(dirAbs);
  for (const f of files) {
    const abs = await resolveBundleFile(dirAbs, f.path);
    if (!abs) continue;
    root.file(f.path, await fs.readFile(abs), { date: new Date(f.mtimeMs) });
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
