/**
 * Files of a space (Obsidian brief, wave 3) — the HTTP surface of
 * server/spaceFiles.ts. Registered in the protected scope.
 *
 *   GET /api/spaces/:space/files?prefix=&q=&limit=&offset=  viewer+ -> SpaceFilesResponse
 *
 * `prefix` is a folder (`assets` = `assets/`), `q` a case-insensitive substring
 * of the path, `limit` 1..500 (default 100), `offset` from 0. Ordered by path.
 * Lists indexed files only: never a page, a dotfile, `.git/`, `.folio/` or a
 * `*.folio` file; a file only hidden pages reference is left out, and
 * `referencedBy` counts the source pages the caller may read. Cookie or PAT
 * (read is enough). The bytes are served by /files/<space>/… (fileAccess.ts),
 * unchanged.
 */
import type { FastifyInstance } from 'fastify';
import type { SpaceFilesResponse } from '../shared/contracts.js';
import { userViewer } from './accessSql.js';
import * as session from './auth/session.js';
import { clampOffset } from './indexV2/read.js';
import { clampFilesLimit, listSpaceFiles } from './spaceFiles.js';
import { queryString } from './validate.js';

export function registerSpaceFilesRoutes(app: FastifyInstance): void {
  app.get('/api/spaces/:space/files', async (request) => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'viewer');
    const q = request.query;
    const response: SpaceFilesResponse = await listSpaceFiles(space, userViewer(request.authUser!), {
      prefix: queryString(q, 'prefix'),
      q: queryString(q, 'q'),
      limit: clampFilesLimit(queryString(q, 'limit')),
      offset: clampOffset(queryString(q, 'offset')),
    });
    return response;
  });
}
