/**
 * The ONE place that turns an indexed page into the `PageDoc` the read routes
 * send: `GET /api/pages/:id` (session), `GET /api/share/:token` (share link)
 * and `GET /api/public/spaces/:slug/pages/:id` (public site) all call this, so
 * the three can never drift apart. Authorization is the caller's job; this
 * only reads content.
 */
import type { PageDoc } from '../shared/contracts.js';
import * as storage from './storage.js';
import type { PageIndexEntry } from './storage.js';
import * as collab from './collab.js';
import * as tables from './tables/service.js';

export async function buildPageDoc(entry: PageIndexEntry): Promise<PageDoc> {
  const meta = storage.toPageMeta(entry);
  if (entry.kind === 'doc') {
    // A live collaboration room is authoritative over the file (the debounced write may be behind).
    const markdown = collab.isDocLive(entry.id) ? (collab.getLiveText(entry.id) ?? entry.body ?? '') : await storage.readFreshDocBody(entry.id);
    return storage.isLightFootprintSpace(entry.space) ? { ...meta, markdown, lightFootprint: true } : { ...meta, markdown };
  }
  // Round 26: a table's content rides these routes as `markdown` (the whole
  // .table.md, schema included) — PageDoc is deliberately NOT extended for tables.
  if (entry.kind === 'table') return { ...meta, markdown: await tables.readTableMarkdown(entry.id) };
  // Round FORMS: same "rides as `markdown`" shape as a table; a form has no
  // collab room, so this is always the fresh file.
  if (entry.kind === 'form') return { ...meta, markdown: await storage.readFreshFormRaw(entry.id) };
  // A pdf/office page's bytes ride GET /api/pages/:id/file instead — plain
  // metadata here (no markdown/svg field).
  if (entry.kind === 'pdf' || entry.kind === 'office') return { ...meta };
  return { ...meta, svg: await storage.readBoardSvg(entry.id) };
}
