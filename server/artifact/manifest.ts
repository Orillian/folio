/**
 * Artifacts (docs/spec-artifacts.md §2): the manifest `artifact.yaml` of a
 * `<slug>.artifact/` bundle, and the small pure helpers every other artifact
 * module shares (names, bundle paths, the visible text of the entry).
 *
 * The manifest is a plain YAML mapping. The reserved keys (ARTIFACT_RESERVED_KEYS)
 * describe the artifact; every other top-level key is a page property, kept
 * verbatim (the properties panel reads and writes them here, like the front
 * matter of a data table). It is read with the front matter reader and edited
 * with the same byte-preserving key editor as a property sidecar
 * (propsSidecar.ts editSidecarText): Folio changing `title:` leaves every
 * other line — comments included — as it was.
 *
 * A bundle without a manifest is valid: type html, entry index.html, title =
 * the directory name without its suffix. Folio writes one only when it writes
 * something (create, replace, a property, the title, the icon).
 */
import {
  ARTIFACT_DEFAULT_ENTRY,
  ARTIFACT_DIR_SUFFIX,
  ARTIFACT_MANIFEST_FILE,
  ARTIFACT_RESERVED_KEYS,
  artifactCapabilitySchema,
  artifactOriginSchema,
  artifactTypeSchema,
  type ArtifactCapability,
  type ArtifactManifest,
} from '../../shared/contracts.js';
import type { FrontmatterKeyEdit } from '../frontmatter.js';
import { editSidecarText, parseSidecar } from '../propsSidecar.js';

export { ARTIFACT_DIR_SUFFIX, ARTIFACT_MANIFEST_FILE, ARTIFACT_DEFAULT_ENTRY };

/** Folder of the host's own files under /art/<token>/ — never a bundle path. */
export const FOLIO_RESERVED_DIR = '__folio';
/** Search text of an artifact is capped at this many characters. */
export const ARTIFACT_TEXT_CAP = 100 * 1024;

const RESERVED: ReadonlySet<string> = new Set(ARTIFACT_RESERVED_KEYS);

/** True for a directory name that makes a bundle (`x.artifact`, case-insensitive) — not `.artifact` alone. */
export function isArtifactDirName(name: string): boolean {
  return name.length > ARTIFACT_DIR_SUFFIX.length && name.toLowerCase().endsWith(ARTIFACT_DIR_SUFFIX) && !name.startsWith('.');
}

/** `reports/q3.artifact` -> `q3`. */
export function artifactStem(relPathOrName: string): string {
  const base = relPathOrName.slice(relPathOrName.lastIndexOf('/') + 1);
  return isArtifactDirName(base) ? base.slice(0, -ARTIFACT_DIR_SUFFIX.length) : base;
}

/**
 * The bundle directory a space path lies in, or undefined: `a/q3.artifact/assets/x.png` -> `a/q3.artifact`.
 * The first segment ending in `.artifact` wins (the scan never looks inside a bundle, so a nested one is just a folder).
 */
export function artifactBundleOf(relPath: string): string | undefined {
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (isArtifactDirName(parts[i])) return parts.slice(0, i + 1).join('/');
  }
  return undefined;
}

/**
 * A path inside a bundle as given by a client / zip / MCP call, normalized to POSIX
 * (`./a//b.js` -> `a/b.js`), or null when it is unsafe or reserved: empty, absolute,
 * a drive letter, `..`, a dot segment, a control character, a backslash, the
 * manifest itself, anything under `__folio/`, or a path segment that would make a
 * nested bundle look like a page to a careless reader (`x.artifact/` inside is fine:
 * the scan never descends, so it is allowed).
 */
export function normalizeBundlePath(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return null;
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  if (parts.length === 0) return null;
  const rel = parts.join('/');
  if (rel.toLowerCase() === ARTIFACT_MANIFEST_FILE) return null;
  if (parts[0] === FOLIO_RESERVED_DIR) return null;
  // Dot files never travel (the scan, git and the trash treat them as metadata).
  if (parts.some((p) => p.startsWith('.'))) return null;
  return rel;
}

export interface ParsedArtifactManifest {
  manifest: ArtifactManifest;
  /** Every non-reserved top-level key, as parsed (dates as Date). */
  properties: Record<string, unknown>;
  /** English, shown in a note on the page. */
  warnings: string[];
  /** The file was there. */
  present: boolean;
  /** The file was a YAML mapping (an absent file is parseable). */
  parseable: boolean;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** The manifest of a bundle named `dirName` (`q3.artifact`), from the text of its artifact.yaml (null = no file). Never throws. */
export function parseArtifactManifest(text: string | null, dirName: string): ParsedArtifactManifest {
  const warnings: string[] = [];
  const fallbackTitle = artifactStem(dirName);
  const parsed = parseSidecar(text);
  if (!parsed.parseable) warnings.push(`${ARTIFACT_MANIFEST_FILE} is not a YAML mapping; it is ignored.`);
  const data = parsed.parseable ? parsed.data : {};

  const typeRead = artifactTypeSchema.safeParse(data.type);
  if (data.type !== undefined && !typeRead.success) warnings.push(`Unknown artifact type ${JSON.stringify(data.type)}; shown as html.`);
  const type = typeRead.success ? typeRead.data : 'html';

  const manifest: ArtifactManifest = { folio: 'artifact', version: 1, type };
  manifest.title = str(data.title) ?? fallbackTitle;
  const icon = str(data.icon);
  if (icon) manifest.icon = icon;
  if (type !== 'embed') manifest.entry = (typeof data.entry === 'string' ? normalizeBundlePath(data.entry) : null) ?? ARTIFACT_DEFAULT_ENTRY;
  if (typeof data.entry === 'string' && type !== 'embed' && manifest.entry !== data.entry.replace(/^\.\//, '')) {
    warnings.push(`The entry ${JSON.stringify(data.entry)} is not a safe path inside the bundle; ${manifest.entry} is used.`);
  }

  if (data.source && typeof data.source === 'object' && !Array.isArray(data.source)) {
    const s = data.source as Record<string, unknown>;
    const source: NonNullable<ArtifactManifest['source']> = {};
    const origin = artifactOriginSchema.safeParse(s.origin);
    if (origin.success) source.origin = origin.data;
    if (str(s.url)) source.url = str(s.url);
    if (s.importedAt instanceof Date && !Number.isNaN(s.importedAt.getTime())) source.importedAt = s.importedAt.toISOString();
    else if (str(s.importedAt)) source.importedAt = str(s.importedAt);
    const file = typeof s.file === 'string' ? normalizeBundlePath(s.file) : null;
    if (file) source.file = file;
    if (Object.keys(source).length > 0) manifest.source = source;
  }

  if (data.embed && typeof data.embed === 'object' && !Array.isArray(data.embed)) {
    const e = data.embed as Record<string, unknown>;
    const url = str(e.url);
    if (url && /^https:\/\//i.test(url)) {
      manifest.embed = { url };
      if (typeof e.height === 'number' && Number.isFinite(e.height) && e.height > 0) manifest.embed.height = Math.min(Math.round(e.height), 10000);
    } else if (url) {
      warnings.push('The embed URL must be an https URL; it is ignored.');
    }
  }
  if (type === 'embed' && !manifest.embed) warnings.push('An embed artifact needs embed.url.');

  if (Array.isArray(data.capabilities)) {
    const caps: ArtifactCapability[] = [];
    for (const c of data.capabilities) {
      const ok = artifactCapabilitySchema.safeParse(c);
      if (ok.success && !caps.includes(ok.data)) caps.push(ok.data);
    }
    if (caps.length > 0) manifest.capabilities = caps;
  }

  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) if (!RESERVED.has(key)) properties[key] = value;
  return { manifest, properties, warnings, present: text !== null, parseable: parsed.parseable };
}

/** The non-reserved keys of a parsed mapping — the page's own properties. */
export function artifactOwnProperties(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !RESERVED.has(key)));
}

/** True for a key Folio owns in artifact.yaml (never a property). */
export function isReservedArtifactKey(key: string): boolean {
  return RESERVED.has(key);
}

/** The reserved part of a manifest as the mapping artifact.yaml holds (no undefined values; `source.importedAt` as text). */
function reservedValues(manifest: ArtifactManifest): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [
    ['folio', 'artifact'],
    ['version', 1],
  ];
  if (manifest.title !== undefined) out.push(['title', manifest.title]);
  if (manifest.icon !== undefined) out.push(['icon', manifest.icon]);
  out.push(['type', manifest.type]);
  if (manifest.type !== 'embed' && manifest.entry !== undefined) out.push(['entry', manifest.entry]);
  if (manifest.source && Object.keys(manifest.source).length > 0) {
    const s: Record<string, unknown> = {};
    if (manifest.source.origin) s.origin = manifest.source.origin;
    if (manifest.source.url) s.url = manifest.source.url;
    if (manifest.source.importedAt) s.importedAt = manifest.source.importedAt;
    if (manifest.source.file) s.file = manifest.source.file;
    out.push(['source', s]);
  }
  if (manifest.embed) out.push(['embed', manifest.embed.height !== undefined ? { url: manifest.embed.url, height: manifest.embed.height } : { url: manifest.embed.url }]);
  if (manifest.capabilities && manifest.capabilities.length > 0) out.push(['capabilities', [...manifest.capabilities]]);
  return out;
}

/**
 * artifact.yaml for `manifest` + `properties`, written over `previous` (the current
 * text, or null): reserved keys set or removed to match the manifest, properties
 * replaced by `properties` when given (undefined keeps the file's own), every
 * untouched line kept byte for byte. A previous file that is not a YAML mapping is
 * replaced as a whole.
 */
export function writeArtifactManifest(previous: string | null, manifest: ArtifactManifest, properties?: Record<string, unknown>): string {
  const prevParsed = parseSidecar(previous);
  const base = prevParsed.parseable ? (previous ?? '') : '';
  const current = prevParsed.parseable ? prevParsed.data : {};
  const edits = new Map<string, FrontmatterKeyEdit>();
  const wanted = reservedValues(manifest);
  const wantedKeys = new Set(wanted.map(([k]) => k));
  for (const [key, value] of wanted) {
    if (Object.prototype.hasOwnProperty.call(current, key) && sameValue(current[key], value)) continue;
    edits.set(key, { set: value });
  }
  for (const key of ARTIFACT_RESERVED_KEYS) {
    if (!wantedKeys.has(key) && Object.prototype.hasOwnProperty.call(current, key)) edits.set(key, { remove: true });
  }
  if (properties) {
    for (const key of Object.keys(current)) {
      if (!RESERVED.has(key) && !Object.prototype.hasOwnProperty.call(properties, key)) edits.set(key, { remove: true });
    }
    for (const [key, value] of Object.entries(properties)) {
      if (RESERVED.has(key) || value === undefined) continue;
      if (Object.prototype.hasOwnProperty.call(current, key) && sameValue(current[key], value)) continue;
      edits.set(key, { set: value });
    }
  }
  if (edits.size === 0 && base !== '') return base;
  const out = editSidecarText(base, edits);
  return out.endsWith('\n') ? out : `${out}\n`;
}

function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v);
  return JSON.stringify(a, (_k, v: unknown) => norm(v)) === JSON.stringify(b, (_k, v: unknown) => norm(v));
}

// ---------------------------------------------------------------------------
// visible text of an HTML entry (search)
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The words a reader sees in `html`: scripts, styles, templates, comments and tags removed, entities decoded, whitespace collapsed, capped. */
export function htmlVisibleText(html: string, cap = ARTIFACT_TEXT_CAP): string {
  // Work on a bounded prefix: a multi-megabyte bundled script must not cost the scan.
  const src = html.length > cap * 20 ? html.slice(0, cap * 20) : html;
  const text = src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(script|style)\b[\s\S]*$/gi, ' ')
    .replace(/<\/?(?:p|div|br|li|h[1-6]|tr|td|th|section|article|header|footer)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > cap ? text.slice(0, cap) : text;
}

/** The `<title>` of an HTML page, if it has a non-empty one. */
export function htmlTitle(html: string): string | undefined {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html.slice(0, 64 * 1024));
  if (!m) return undefined;
  const t = htmlVisibleText(m[1], 200);
  return t || undefined;
}

/** JSON safe inside a <script> element: no `</script>`, no `<!--`, no raw U+2028/U+2029. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
