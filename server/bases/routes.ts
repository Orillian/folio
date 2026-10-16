/**
 * Obsidian Bases (16.10.2026) — the HTTP surface. Registered in the protected scope.
 *
 *   GET  /api/pages/:id/base?view=&offset=&limit=  viewer+ on the base page        → BaseQueryResponse
 *   GET  /api/pages/:id/base/source                viewer+                         → BaseSourceResponse
 *   PUT  /api/pages/:id/base                       editor+ on the base page, a write-scope token
 *                                                  body { etag, config } | { etag, source } → BaseSourceResponse; 409 + current on an etag mismatch
 *   POST /api/spaces/:space/base/preview           viewer+ in the space (and on `pageId`) body BasePreviewBody → BaseQueryResponse
 *
 * Rows are the pages of the base's space the reader may open (server/bases/query.ts).
 * A write keeps what it does not change (shared/bases/writer.ts) and rides the
 * debounced auto-commit, attributed to the writer (gitSync.recordEditor).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { BaseConfig, BaseQueryResponse, BaseSourceResponse } from '../../shared/bases/types.js';
import { BASE_MAX_BYTES } from '../../shared/bases/types.js';
import { parseBaseConfig } from '../../shared/bases/parse.js';
import { userViewer } from '../accessSql.js';
import { recordAudit } from '../audit.js';
import * as session from '../auth/session.js';
import { badRequest } from '../errors.js';
import * as gitSync from '../gitSync.js';
import * as storage from '../storage.js';
import type { PageIndexEntry } from '../storage.js';
import { parseBody } from '../validate.js';
import { queryBase } from './query.js';
import { BaseConflictError, sourceResponse, writeBase } from './service.js';

const viewSchema = z.object({ type: z.string().min(1).max(100), name: z.string().min(1).max(200) }).passthrough();
const configSchema = z.object({
  filters: z.unknown().optional(),
  formulas: z.record(z.string(), z.string().max(10_000)).default({}),
  properties: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  summaries: z.record(z.string(), z.string().max(10_000)).default({}),
  views: z.array(viewSchema).max(100).default([]),
});
const writeBodySchema = z
  .object({ etag: z.string().min(1), config: configSchema.optional(), source: z.string().max(BASE_MAX_BYTES).optional() })
  .refine((b) => (b.config === undefined) !== (b.source === undefined), 'send either config or source');
const previewBodySchema = z.object({
  source: z.string().max(BASE_MAX_BYTES),
  pageId: z.string().optional(),
  view: z.string().max(200).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional(),
});

function tokenMayWrite(request: FastifyRequest): boolean {
  return request.tokenScopes === undefined || request.tokenScopes.includes('write');
}

async function mayEditPage(request: FastifyRequest, entry: PageIndexEntry): Promise<boolean> {
  return session.roleAtLeast(await session.effectivePageRole(request.authUser!, entry), 'editor') && tokenMayWrite(request);
}

function emptyResponse(error: { message: string; line?: number }): BaseQueryResponse {
  return { views: [], view: null, layout: 'table', columns: [], rows: [], total: 0, offset: 0, limit: 0, truncated: false, warnings: [], error };
}

function numberParam(raw: unknown): number | undefined {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

/** Runs a base for a reader in `space`. `thisPageId`: the page `this` means. */
export async function answerBase(
  request: FastifyRequest,
  space: string,
  text: string,
  thisPageId: string | null,
  window: { view?: string; offset?: number; limit?: number },
): Promise<BaseQueryResponse> {
  const parsed = parseBaseConfig(text);
  if (!parsed.config) return emptyResponse(parsed.error ?? { message: 'The base file could not be read.' });
  const user = request.authUser!;
  const role = await session.effectiveRole(user, space);
  try {
    const response = await queryBase({
      space,
      config: parsed.config,
      viewName: window.view,
      viewer: userViewer(user),
      spaceEditor: session.roleAtLeast(role, 'editor'),
      tokenMayWrite: tokenMayWrite(request),
      thisPageId,
      folderTitles: true,
      offset: window.offset,
      limit: window.limit,
    });
    if (parsed.warnings.length) response.warnings.unshift(...parsed.warnings);
    return response;
  } catch (err) {
    if ((err as Error)?.name === 'BaseBudgetError') return emptyResponse({ message: 'This base is too expensive to evaluate (its formulas and filters do too much work). Simplify it.' });
    throw err;
  }
}

export function registerBaseRoutes(app: FastifyInstance): void {
  app.get('/api/pages/:id/base', async (request) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    if (entry.kind !== 'base') throw badRequest('page is not a base');
    const { text } = await storage.readBaseRaw(id);
    const q = request.query as Record<string, unknown> | undefined;
    return answerBase(request, entry.space, text, entry.id, {
      view: typeof q?.view === 'string' ? q.view : undefined,
      offset: numberParam(q?.offset),
      limit: numberParam(q?.limit),
    });
  });

  app.get('/api/pages/:id/base/source', async (request) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    if (entry.kind !== 'base') throw badRequest('page is not a base');
    const { text } = await storage.readBaseRaw(id);
    return sourceResponse(text, await mayEditPage(request, entry));
  });

  app.put('/api/pages/:id/base', async (request, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = parseBody(writeBodySchema, request.body);
    const entry = await session.requirePageRole(request, id, 'editor');
    session.requireWriteScope(request);
    if (entry.kind !== 'base') throw badRequest('page is not a base');
    const user = request.authUser!;
    try {
      const result = await writeBase(id, body as { etag: string; config?: BaseConfig; source?: string });
      if (result.written) {
        gitSync.recordEditor(entry.space, { name: user.name, email: user.email });
        gitSync.noteActivity(entry.space);
        recordAudit(user.id, 'page.base', id, { mode: body.config ? 'config' : 'source' });
      }
      return sourceResponse(result.text, true);
    } catch (err) {
      if (err instanceof BaseConflictError) return reply.status(409).send({ error: err.message, ...err.current });
      throw err;
    }
  });

  app.post('/api/spaces/:space/base/preview', async (request) => {
    const { space } = request.params as { space: string };
    const body = parseBody(previewBodySchema, request.body);
    await session.requireSpaceRole(request, space, 'viewer');
    let thisPageId: string | null = null;
    if (body.pageId) {
      const page = await session.requirePageRole(request, body.pageId, 'viewer');
      if (page.space !== space) throw badRequest('the page is in another space');
      thisPageId = page.id;
    }
    return answerBase(request, space, body.source, thisPageId, { view: body.view, offset: body.offset, limit: body.limit });
  });
}
