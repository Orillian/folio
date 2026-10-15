/**
 * The HTTP wrapper of server/tags.ts (Obsidian brief, wave 3):
 *
 *   GET  /api/spaces/:space/tags/:tag/pages?limit=&offset=   viewer+; the tag is the normalized tag, URL-encoded (`project%2Falpha`
 *                                                            or plain `project/alpha`); it lists the tag and its children
 *   POST /api/spaces/:space/tags/rename                      editor+, write scope for a PAT; { from, to } -> RenameTagResult
 *
 * (GET /api/spaces/:space/tags — the list of tags — lives in routes.ts with the other index reads.)
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { renameTagBodySchema } from '../shared/contracts.js';
import { recordAudit } from './audit.js';
import { userViewer } from './accessSql.js';
import * as session from './auth/session.js';
import { notFound } from './errors.js';
import { clampTagPagesLimit, clampTagPagesOffset, listTagPages, normalizeRenameTags, renameTag } from './tags.js';
import { parseBody, queryString } from './validate.js';

/** The tag out of the wildcard of `/tags/<tag>/pages`, decoded; undefined when the path is not that shape. */
function tagOfWildcard(wildcard: string): string | undefined {
  if (!wildcard.endsWith('/pages')) return undefined;
  const encoded = wildcard.slice(0, -'/pages'.length);
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

export function registerTagRoutes(app: FastifyInstance): void {
  app.get('/api/spaces/:space/tags/*', async (request: FastifyRequest) => {
    const { space, '*': wildcard } = request.params as { space: string; '*': string };
    await session.requireSpaceRole(request, space, 'viewer');
    const tag = tagOfWildcard(wildcard);
    if (tag === undefined) throw notFound('route');
    const limit = clampTagPagesLimit(queryString(request.query, 'limit'));
    const offset = clampTagPagesOffset(queryString(request.query, 'offset'));
    return listTagPages(space, tag, userViewer(request.authUser!), { limit, offset });
  });

  app.post('/api/spaces/:space/tags/rename', async (request) => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'editor');
    session.requireWriteScope(request);
    const body = parseBody(renameTagBodySchema, request.body);
    const user = request.authUser!;
    const { from, to } = normalizeRenameTags(body.from, body.to);
    const result = await renameTag({ space, from, to, user, actor: { name: user.name, email: user.email } });
    recordAudit(user.id, 'space.tag_rename', space, { from, to, pagesChanged: result.pagesChanged });
    return result;
  });
}
