/**
 * A base page answered for an agent (MCP query_base, read_page, fetch): read-only,
 * the agent's own ACL, compact values.
 */
import { parseBaseConfig } from '../../shared/bases/parse.js';
import type { PageViewer } from '../accessSql.js';
import * as storage from '../storage.js';
import type { PageIndexEntry } from '../storage.js';
import { compactBase, type CompactBase } from './compact.js';
import { queryBase } from './query.js';

export const AGENT_BASE_DEFAULT_ROWS = 100;
export const AGENT_BASE_MAX_ROWS = 500;

export async function queryBaseForAgent(entry: PageIndexEntry, viewer: PageViewer, opts: { view?: string; offset?: number; limit?: number } = {}): Promise<CompactBase> {
  const { text } = await storage.readBaseRaw(entry.id);
  const parsed = parseBaseConfig(text);
  if (!parsed.config) {
    return { view: null, views: [], columns: [], rows: [], total: 0, truncated: false, warnings: [], error: parsed.error ? `${parsed.error.message}${parsed.error.line ? ` (line ${parsed.error.line})` : ''}` : 'not a base' };
  }
  const limit = Math.min(AGENT_BASE_MAX_ROWS, Math.max(1, Math.floor(opts.limit ?? AGENT_BASE_DEFAULT_ROWS)));
  try {
    const r = await queryBase({
      space: entry.space,
      config: parsed.config,
      viewName: opts.view,
      viewer,
      spaceEditor: false,
      tokenMayWrite: false,
      thisPageId: entry.id,
      offset: Math.max(0, Math.floor(opts.offset ?? 0)),
      limit,
    });
    r.warnings.unshift(...parsed.warnings);
    return compactBase(r);
  } catch (err) {
    if ((err as Error)?.name === 'BaseBudgetError') {
      return { view: null, views: [], columns: [], rows: [], total: 0, truncated: false, warnings: [], error: 'this base is too expensive to evaluate' };
    }
    throw err;
  }
}
