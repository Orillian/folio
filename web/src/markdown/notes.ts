import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { remarkUnderline } from '@shared/underline';
import { phrasingToPlainText } from '@shared/inlineText';
import { visit } from 'unist-util-visit';
import type { Root, Blockquote, ListItem, Paragraph, PhrasingContent, Text } from 'mdast';
import { stripFrontmatter } from './frontmatter';
import { matchCalloutMarker } from '@shared/ofm/callout';
import { calloutDisplayName, calloutKind, type CalloutKind } from './alerts';

/** A checklist item stays `'task'` regardless of type; a callout narrows to its `[!TYPE]`, lowercased. */
export type NoteKind = 'note' | 'tip' | 'important' | 'warning' | 'caution' | 'task';

export interface NoteEntry {
  kind: NoteKind;
  /** Only meaningful for `kind === 'task'` — always `false` for a callout. */
  checked: boolean;
  /** One-line preview: a checklist item's own content, or a callout's first non-empty body line (its type name when the body is empty). */
  text: string;
  /** Offset of the entry's first character (the `>` or the list marker) in the *original* markdown — see scroll-to-heading.ts's headingPositions for the same frontmatter-shift reasoning. */
  pos: number;
}

/**
 * Flattens phrasing content to plain text with the same resolver the outline's
 * headings use (`==x==`, `:status[x]`, links, emphasis → their words), except
 * a hard `break` node becomes a real `\n` rather than a space, since callout
 * body text (below) needs to tell one source line from the next to find its
 * "first non-empty line". A markdown *soft* line break needs no such
 * handling: mdast-util-from-markdown already keeps it as a literal `\n`
 * inside the enclosing Text node's own value, never as a separate node — which
 * is also why whitespace is not collapsed here.
 */
function inlineText(nodes: readonly PhrasingContent[]): string {
  return phrasingToPlainText(nodes, { breakText: '\n', collapse: false });
}

/** A checklist item's display text: its own paragraph, content only — never a nested sub-list/blockquote's. */
function listItemText(node: ListItem): string {
  const first = node.children.find((child): child is Paragraph => child.type === 'paragraph');
  if (!first) return '';
  return inlineText(first.children).replace(/\s+/g, ' ').trim();
}

/**
 * A callout's type and preview text, or null when `node` isn't one — the
 * exact same test remarkOfm itself uses (matchCalloutMarker, shared/ofm/callout.ts,
 * on the first paragraph's first text node), just read rather than applied:
 * this parse is never fed into remarkOfm, and re-deriving the check
 * independently would risk the two silently drifting.
 *
 * Preview text is the first non-empty *line* of the body (the marker line
 * itself excluded) — a callout can hold several paragraphs, and only the one
 * line is shown in the compact notes list. Empty body (bare `> [!NOTE]`)
 * falls back to the type's own translated label, the same string
 * data-alert-label already renders for it.
 */
function calloutPreview(node: Blockquote): { type: string; kind: CalloutKind; text: string } | null {
  const first = node.children[0];
  if (!first || first.type !== 'paragraph') return null;
  const firstInline = first.children[0];
  if (!firstInline || firstInline.type !== 'text') return null;

  const marker = matchCalloutMarker((firstInline as Text).value);
  if (!marker) return null;
  const rest = (firstInline as Text).value.slice(marker.length).replace(/^[ \t\u00a0]+/, '');

  const paragraphs = node.children.filter((child): child is Paragraph => child.type === 'paragraph');
  const lines = paragraphs
    .map((paragraph, index) => {
      const children =
        index === 0
          ? [{ ...(firstInline as Text), value: rest }, ...paragraph.children.slice(1)]
          : paragraph.children;
      return inlineText(children);
    })
    .join('\n')
    .split('\n')
    .map((line) => line.trim());

  const text = lines.find((line) => line.length > 0);
  return { type: marker.type, kind: calloutKind(marker.type), text: text ?? calloutDisplayName(marker.type) };
}

/**
 * Every "Notes" entry (a `[!TYPE]` callout or a checklist item) on a page, in
 * document order — the mdast-side half of the notes panel (app/outline/OutlinePanel.tsx):
 * markdown/noteIds.ts's rehypeAssignNoteIds walks the SAME rendered document
 * and must find the SAME entries in the SAME order, so a click can jump to
 * the right one in reading mode; see that module's own doc comment for the
 * one deliberate exception (a checklist marker inside a table cell).
 *
 * Nesting is exactly as unrestricted as headingPositions leaves lists/blockquotes:
 * a checked item inside a callout, or a callout inside an ordinary list item,
 * both produce their own entry at the point they're reached by this walk —
 * unist-util-visit's plain pre-order traversal already visits a parent before
 * its children, which is the same "outer entry first" order the rendered DOM
 * (and rehypeAssignNoteIds's own pre-order walk) puts them in.
 */
export function extractNotes(markdown: string): NoteEntry[] {
  const body = stripFrontmatter(markdown);
  const shift = markdown.length - body.length;
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkUnderline).parse(body) as Root;
  const out: NoteEntry[] = [];

  visit(tree, (node) => {
    if (node.type === 'listItem') {
      const item = node as ListItem;
      if (typeof item.checked !== 'boolean') return;
      const start = item.position?.start?.offset;
      if (start === undefined) return;
      out.push({ kind: 'task', checked: item.checked, text: listItemText(item), pos: shift + start });
      return;
    }
    if (node.type === 'blockquote') {
      const preview = calloutPreview(node as Blockquote);
      if (!preview) return;
      const start = node.position?.start?.offset;
      if (start === undefined) return;
      out.push({ kind: preview.kind, checked: false, text: preview.text, pos: shift + start });
    }
  });

  return out;
}
