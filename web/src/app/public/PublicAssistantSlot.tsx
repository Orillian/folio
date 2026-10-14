import type { PublicSiteInfo } from '@shared/contracts';
import { PublicAskPanel } from './PublicAskPanel';

export interface PublicAssistantSlotProps {
  site: PublicSiteInfo;
  /** The page on screen, when there is one. */
  pageId?: string;
}

/**
 * Mount point of the visitor-facing "Ask Folio AI" for a public site. Rendered by the site's header only
 * when the space allows it (`site.allowAssistant`). It contributes the header's "Ask AI" button; the chat
 * sheet it toggles is position:fixed, so it adds nothing more to the header's layout (which therefore must not
 * have a backdrop-filter / transform of its own — that would make the sheet position against the header).
 */
export function PublicAssistantSlot({ site, pageId }: PublicAssistantSlotProps) {
  return <PublicAskPanel site={site} pageId={pageId} />;
}
