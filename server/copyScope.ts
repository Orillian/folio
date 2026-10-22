/**
 * What a copy or a duplicate of a page may take along for the person asking
 * for it — the access half of POST /api/pages/:id/copy and /duplicate. The
 * rule itself, and why, is documented on storage.CopyScope; this module only
 * asks the existing primitives (pageAccess.hiddenPages, the raw-file ownership
 * rule of fileAccess.ts, canAdministerSpace) who the caller is and what is
 * hidden from them in the SOURCE space.
 */
import type { User } from '../shared/contracts.js';
import * as session from './auth/session.js';
import * as collab from './collab.js';
import { filesOfHiddenPagesOnly } from './fileAccess.js';
import * as pageAccess from './pageAccess.js';
import * as storage from './storage.js';
import type { CopyScope, PageIndexEntry } from './storage.js';
import * as tables from './tables/service.js';

/**
 * `withChildren` is whether the copy walks a folder at all; the files only
 * hidden pages use matter only then, and finding them reads page texts.
 */
export async function resolveCopyScope(user: User, source: PageIndexEntry, withChildren: boolean): Promise<CopyScope> {
  const canAdminister = await session.canAdministerSpace(user, source.space);
  const hidden = await pageAccess.hiddenPages(user.id, source.space, canAdminister);
  return {
    actorId: user.id,
    hiddenPageIds: new Set(hidden.map((page) => page.id)),
    privateFiles: withChildren ? await filesOfHiddenPagesOnly(source.space, hidden) : new Set(),
    skipAgentFolder: !canAdminister,
  };
}

/**
 * What a copy of `entry` starts from. A live collaboration room is
 * authoritative: copy exactly what the user can see now instead of waiting for
 * the debounced file write. Boards, forms and file pages are read from disk by
 * storage.copyPage itself.
 */
export async function liveCopyContent(entry: PageIndexEntry): Promise<string | undefined> {
  if (entry.kind === 'doc') {
    return collab.isDocLive(entry.id)
      ? (collab.getLiveText(entry.id) ?? (await storage.readFreshDocBody(entry.id)))
      : storage.readFreshDocBody(entry.id);
  }
  if (entry.kind === 'table') return tables.readTableMarkdown(entry.id);
  return undefined;
}
