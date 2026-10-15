/**
 * Which top-level entries of a space's content root the scan must not index
 * (Obsidian vault compatibility, wave 1a). Before this the rule was two
 * hard-coded conditions inside scanSpace; now it is one function over a
 * per-space list (`spaces.scan_ignore`, migration 041) plus the defaults.
 *
 * What stays outside this module, deliberately:
 *  - every dotfile / dotfolder at any depth is still never a page (scanSpace's
 *    own rule, `.agent` at the content root the one exception) — the defaults
 *    below name the three a vault carries so the rule is visible and shown in
 *    the UI, but the dot rule would skip them anyway;
 *  - the `assets` folder (any depth) never holds pages; since wave 3 its files
 *    (and every other non-page file) are indexed AS FILES (spaceFiles.ts) — the
 *    list below applies to that index too.
 *
 * The list applies to TOP-LEVEL entries only — a folder with the same name
 * deeper in the tree is an ordinary folder. Patterns are one path segment, `*`
 * the only wildcard, a trailing `/` = folders only, case-insensitive (see
 * normalizeScanIgnoreEntry in shared/contracts.ts for the accepted shape).
 */
import { DEFAULT_SCAN_IGNORE, normalizeScanIgnoreEntry } from '../shared/contracts.js';

/** true — skip this top-level entry. `isDir` is whether the entry is a directory (symlinks to directories count as files here, as everywhere in the walk). */
export type ScanIgnoreMatcher = (name: string, isDir: boolean) => boolean;

interface CompiledEntry {
  dirOnly: boolean;
  re: RegExp;
}

function compileEntry(entry: string): CompiledEntry | null {
  const normalized = normalizeScanIgnoreEntry(entry);
  if (normalized === null) return null; // a malformed stored value must never abort a scan
  const dirOnly = normalized.endsWith('/');
  const name = dirOnly ? normalized.slice(0, -1) : normalized;
  const source = name
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return { dirOnly, re: new RegExp(`^${source}$`, 'i') };
}

/** Compiles the defaults plus the space's own list (null/empty = just the defaults). */
export function compileScanIgnore(configured: readonly string[] | null | undefined): ScanIgnoreMatcher {
  const entries = [...DEFAULT_SCAN_IGNORE, ...(configured ?? [])].map(compileEntry).filter((e): e is CompiledEntry => e !== null);
  return (name, isDir) => entries.some((e) => (isDir || !e.dirOnly) && e.re.test(name));
}
