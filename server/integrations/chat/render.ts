/**
 * Text pieces shared by the Slack and Teams renderings of a chat card (card.ts), so both say the
 * same thing in the same order. English only: the card is posted into a conversation whose
 * readers' languages Folio does not know.
 */
import type { ChatCard, ChatCardResult } from './card.js';

export const OPEN_IN_FOLIO = 'Open in Folio';
export const CONNECT_FOLIO = 'Connect Folio';
export const NOACCESS_TITLE = 'Folio page';
export const NOACCESS_TEXT = 'No preview: the page is not available to the person who shared the link. Open it in Folio to sign in or request access.';
export const SIGNIN_TEXT = 'Connect your Folio account to see previews of Folio links you share.';
export const RESTRICTED_NOTE = '🔒 Restricted page: content is not shown in chat.';

export function breadcrumbLine(card: ChatCard): string {
  return card.breadcrumb.join(' / ');
}

/** One line about what the page is, when there is something to say beyond its text. */
export function kindLine(card: ChatCard): string | undefined {
  if (card.limited) return RESTRICTED_NOTE;
  switch (card.kind) {
    case 'table': {
      if (!card.table) return 'Table';
      const rows = `${card.table.rows} ${card.table.rows === 1 ? 'row' : 'rows'}`;
      return card.table.columns.length ? `Table · ${rows} · Columns: ${card.table.columns.join(', ')}` : `Table · ${rows}`;
    }
    case 'form':
      return card.form ? `Form · ${card.form.fields} ${card.form.fields === 1 ? 'field' : 'fields'}` : 'Form';
    case 'board':
      return 'Whiteboard: open it in Folio to see the drawing.';
    case 'canvas':
      return 'Obsidian canvas: open it in Folio to see it.';
    case 'pdf':
    case 'office':
      return card.file ? `${card.file} file` : 'File';
    case 'base':
      return 'Base: a view over pages — open it in Folio.';
    case 'space':
      return 'Space';
    default:
      return undefined;
  }
}

export function headingsText(card: ChatCard): string | undefined {
  return card.headings?.length ? card.headings.map((h) => `• ${h}`).join('\n') : undefined;
}

export function tagsText(card: ChatCard): string | undefined {
  return card.tags?.length ? card.tags.map((t) => `#${t}`).join('  ') : undefined;
}

/** "Updated 2026-10-16 by Name" (UTC date: chat clients show it to readers in any time zone). */
export function updatedText(card: ChatCard): string | undefined {
  if (!card.updatedAt) return undefined;
  const date = card.updatedAt.slice(0, 10);
  return card.updatedBy ? `Updated ${date} by ${card.updatedBy}` : `Updated ${date}`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export type { ChatCard, ChatCardResult };
