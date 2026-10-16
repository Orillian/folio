/**
 * Byte-preserving edits of a `.canvas` file — used ONLY when a page a canvas
 * points at is renamed or moved through Folio in a space that is not light
 * footprint (server/collab.ts), the way Obsidian itself keeps a canvas's file
 * cards pointing at a renamed note. Nothing else ever writes a canvas.
 *
 * The file is not re-serialized: a small scanner walks the JSON text, and only
 * the string VALUES of the keys asked for are replaced, each by its new value
 * encoded with JSON.stringify. Whitespace, key order, unknown keys and the
 * encoding of every other string stay exactly as they were, so the diff is
 * just the changed paths. Text that is not JSON is returned unchanged.
 */

export interface CanvasStringEdit {
  /** The key whose string value may change: 'file' (a file card), 'background' (a group), 'text' (a text card). */
  key: string;
  /** The new value for `value`, or null to keep it. */
  map: (value: string) => string | null;
}

interface StringToken {
  start: number;
  end: number;
  value: string;
}

/** The JSON string token starting at `start` (a `"`), or null when it is unterminated or invalid. */
function readString(text: string, start: number): StringToken | null {
  let i = start + 1;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 0x5c /* \ */) {
      i += 2;
      continue;
    }
    if (ch === 0x22 /* " */) {
      try {
        return { start, end: i + 1, value: JSON.parse(text.slice(start, i + 1)) as string };
      } catch {
        return null;
      }
    }
    i++;
  }
  return null;
}

/** `raw` with the string values of `edits`' keys replaced (see the module doc). Returns `raw` itself when nothing changed. */
export function rewriteCanvasStrings(raw: string, edits: readonly CanvasStringEdit[]): string {
  const byKey = new Map(edits.map((e) => [e.key, e.map]));
  if (byKey.size === 0) return raw;
  try {
    JSON.parse(raw);
  } catch {
    return raw;
  }
  const out: string[] = [];
  let cursor = 0;
  let pendingKey: string | null = null;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      const token = readString(raw, i);
      if (!token) return raw;
      // A string followed by ':' is a key; the next string (if it comes right after) is its value.
      let j = token.end;
      while (j < raw.length && /\s/.test(raw[j])) j++;
      if (raw[j] === ':') {
        pendingKey = token.value;
        i = j + 1;
        continue;
      }
      const map = pendingKey !== null ? byKey.get(pendingKey) : undefined;
      pendingKey = null;
      if (map) {
        const next = map(token.value);
        if (next !== null && next !== token.value) {
          out.push(raw.slice(cursor, token.start), JSON.stringify(next));
          cursor = token.end;
        }
      }
      i = token.end;
      continue;
    }
    // Any other value (number, object, array, literal) after a key: that key has no string value.
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') pendingKey = null;
    i++;
  }
  if (cursor === 0) return raw;
  out.push(raw.slice(cursor));
  return out.join('');
}

/**
 * The path a moved page or file is at now: `movedFiles` (old path -> new path)
 * first, then a folder that moved (`movedDirs`, old folder -> new folder) with
 * everything under it. Null when nothing it names moved.
 */
export function movedCanvasPath(p: string, movedFiles: ReadonlyMap<string, string>, movedDirs: ReadonlyMap<string, string> = new Map()): string | null {
  const file = movedFiles.get(p);
  if (file !== undefined) return file;
  for (const [from, to] of movedDirs) {
    if (p === from) return to;
    if (p.startsWith(`${from}/`)) return `${to}${p.slice(from.length)}`;
  }
  return null;
}
