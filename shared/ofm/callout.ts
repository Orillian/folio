/**
 * Callouts — `> [!type]`, `> [!type]+` / `-` (fold), `> [!type] Title`, any
 * type, any case, nested — the ONE grammar and type table (Obsidian vault
 * compatibility, wave 2), and the one place GitHub's five alerts
 * (`> [!NOTE]` ...) are folded into the same component.
 *
 * Every callout has a TYPE (what the author wrote, lowercased: `info`, `faq`,
 * `my-custom`) and a KIND (one of the five looks Folio draws: note, tip,
 * important, warning, caution). Anything unknown is a note, as in Obsidian.
 * Where Obsidian aliases collide with GitHub's names (`important` is a `tip`
 * there, `caution` a `warning`), the five GitHub names keep their own look.
 */

export const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

const KIND_OF_TYPE: Record<string, CalloutKind> = {
  note: 'note', info: 'note', todo: 'note', example: 'note', abstract: 'note', summary: 'note', tldr: 'note',
  question: 'note', help: 'note', faq: 'note', quote: 'note', cite: 'note',
  tip: 'tip', hint: 'tip', success: 'tip', check: 'tip', done: 'tip',
  important: 'important',
  warning: 'warning', attention: 'warning',
  caution: 'caution', danger: 'caution', error: 'caution', failure: 'caution', fail: 'caution', missing: 'caution', bug: 'caution',
};

/** How a callout of this type looks. Unknown types are notes. */
export function calloutKind(type: string): CalloutKind {
  return KIND_OF_TYPE[type.toLowerCase()] ?? 'note';
}

/** Types that have a translated name (the `alerts.<type>` keys of the markdown i18n bundle); the rest are shown as typed. */
export const NAMED_CALLOUT_TYPES = [
  'note', 'tip', 'important', 'warning', 'caution',
  'info', 'todo', 'abstract', 'success', 'question', 'failure', 'danger', 'bug', 'example', 'quote',
] as const;

export function hasCalloutName(type: string): boolean {
  return (NAMED_CALLOUT_TYPES as readonly string[]).includes(type.toLowerCase());
}

/** `my-custom` -> `My-custom`: the heading of a callout whose type has no translated name. */
export function capitalizeType(type: string): string {
  return type ? type[0].toUpperCase() + type.slice(1) : type;
}

export type CalloutFold = '+' | '-';

export interface CalloutMarker {
  /** What the author wrote between `[!` and `]`, lowercased. */
  type: string;
  /** `+` = foldable, open; `-` = foldable, closed; null = not foldable. */
  fold: CalloutFold | null;
  /** Length of `[!type]` plus the fold sign. */
  length: number;
}

// The marker must stand at the very start of the quote's text and be followed by a blank, the end of the line or the end of the text.
const MARKER_RE = /^\[!([A-Za-z0-9_-]+)\]([+-])?(?=[ \t\n\u00a0]|$)/;

/** Recognizes a callout marker at the very start of `text` (the first text of a quote), or null. */
export function matchCalloutMarker(text: string): CalloutMarker | null {
  const m = MARKER_RE.exec(text);
  if (!m) return null;
  return { type: m[1].toLowerCase(), fold: (m[2] as CalloutFold | undefined) ?? null, length: m[0].length };
}

export interface CalloutLine extends CalloutMarker {
  /** The title typed after the marker on the same line; '' when none. */
  title: string;
  /** Offset of the title in the line text (after the quote prefix was cut), or -1. */
  titleFrom: number;
}

/** A callout's first line as the editor sees it: `text` is the line after the `>` prefix. */
export function matchCalloutLine(text: string): CalloutLine | null {
  const marker = matchCalloutMarker(text);
  if (!marker) return null;
  const rest = text.slice(marker.length);
  const title = rest.trim();
  const titleFrom = title ? marker.length + (rest.length - rest.trimStart().length) : -1;
  return { ...marker, title, titleFrom };
}
