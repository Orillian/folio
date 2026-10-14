import type { PublicSiteInfo } from '@shared/contracts';
import { PublicAskPanel } from './PublicAskPanel';

export interface PublicAssistantSlotProps {
  site: PublicSiteInfo;
  /** The page on screen, when there is one. */
  pageId?: string;
}

/**
 * Mount point of the visitor-facing "Ask Folio AI" for a public site. Rendered by the site's header only
 * when the space allows it (`site.allowAssistant`). The panel is position:fixed (a floating button and a
 * sheet), so it adds nothing to the header's layout.
 */
export function PublicAssistantSlot({ site, pageId }: PublicAssistantSlotProps) {
  return <PublicAskPanel site={site} pageId={pageId} />;
}
