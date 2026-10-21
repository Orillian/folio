/**
 * Artifacts: the session-scoped HTTP surface (shared/contracts.ts "Artifacts").
 *
 *   POST /api/spaces/:space/artifacts      editor+  JSON ArtifactPublishBody, or multipart `file` + the body's fields
 *   PUT  /api/pages/:id/artifact           editor+  same bodies (parentPath ignored): replaces the content
 *   GET  /api/pages/:id/artifact/download  viewer+  the bundle as a zip
 *   GET  /api/pages/:id/artifact/state     viewer+  the reader's personal + the shared state
 *   PUT  /api/pages/:id/artifact/state     viewer+  one key set / deleted (ArtifactStatePut)
 *
 * Refusals of an import answer 422 { error, code, message } (ArtifactErrorCode).
 * `/art/<token>/*` is public (token-only) and lives in serve.ts.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { artifactPublishBodySchema, artifactStatePutSchema, type ArtifactPublishBody, type ArtifactPublishResult } from '../../shared/contracts.js';
import * as session from '../auth/session.js';
import { badRequest } from '../errors.js';
import { recordPageChange, snapshotPageChange } from '../pageChanges.js';
import * as storage from '../storage.js';
import { parseBody } from '../validate.js';
import { zipBundle } from './bundle.js';
import { ArtifactImportError } from './errors.js';
import type { UploadedFile } from './import.js';
import { artifactStem } from './manifest.js';
import { createArtifact, replaceArtifact } from './service.js';
import { readArtifactState, writeArtifactState } from './state.js';

/** JSON bodies carry whole pages (html, base64 files): up to the bundle limit plus encoding overhead. */
const BODY_LIMIT = 72 * 1024 * 1024;

const SCALAR_FIELDS = ['parentPath', 'title', 'icon', 'type', 'html', 'text', 'entry', 'sourceCode', 'sourceFileName', 'url', 'embedCode', 'origin', 'sourceUrl'] as const;

/** The body and the uploaded file of a publish request, JSON or multipart. */
async function readPublishRequest(request: FastifyRequest): Promise<{ body: ArtifactPublishBody; upload?: UploadedFile }> {
  if (!request.isMultipart()) return { body: parseBody(artifactPublishBodySchema, request.body ?? {}) };
  const fields: Record<string, unknown> = {};
  let upload: UploadedFile | undefined;
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const bytes = await part.toBuffer();
      if (part.fieldname === 'file' && !upload) upload = { filename: part.filename, bytes, contentType: part.mimetype };
      continue;
    }
    const value = typeof part.value === 'string' ? part.value : String(part.value);
    if ((SCALAR_FIELDS as readonly string[]).includes(part.fieldname)) {
      if (value !== '' || part.fieldname === 'parentPath') fields[part.fieldname] = value;
    } else if (part.fieldname === 'capabilities' || part.fieldname === 'properties') {
      // Structured fields ride as JSON text (capabilities may also be a comma list).
      try {
        fields[part.fieldname] = JSON.parse(value);
      } catch {
        if (part.fieldname === 'capabilities') fields.capabilities = value.split(',').map((s) => s.trim()).filter(Boolean);
        else throw badRequest('properties must be a JSON object');
      }
    }
  }
  return { body: parseBody(artifactPublishBodySchema, fields), upload };
}

async function answer(reply: FastifyReply, run: () => Promise<ArtifactPublishResult>, status: number): Promise<ArtifactPublishResult | FastifyReply> {
  try {
    const result = await run();
    reply.status(status);
    return result;
  } catch (err) {
    if (err instanceof ArtifactImportError) return reply.status(422).send({ error: err.message, code: err.code, message: err.message });
    throw err;
  }
}

export function registerArtifactRoutes(app: FastifyInstance): void {
  app.post('/api/spaces/:space/artifacts', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'editor');
    session.requireWriteScope(request);
    const user = request.authUser!;
    const { body, upload } = await readPublishRequest(request);
    const parentPath = storage.normalizePageParentDir(body.parentPath ?? '');
    if (storage.isUnderTemplates(parentPath)) throw badRequest('a page cannot be created inside the templates folder');
    await session.requireAgentWriteAllowed(user, space, parentPath);
    return answer(
      reply,
      async () => {
        const result = await createArtifact(space, { ...body, parentPath }, user, upload, { source: 'web' });
        const after = snapshotPageChange(await storage.requireEntry(result.page.id));
        await recordPageChange(user.id, 'page.create', result.page.id, space, undefined, after);
        return result;
      },
      201,
    );
  });

  app.put('/api/pages/:id/artifact', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'editor');
    session.requireWriteScope(request);
    if (entry.kind !== 'artifact') throw badRequest('page is not an artifact');
    const { body, upload } = await readPublishRequest(request);
    return answer(reply, () => replaceArtifact(id, body, request.authUser!, upload, { source: 'web' }), 200);
  });

  app.get('/api/pages/:id/artifact/download', async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    if (entry.kind !== 'artifact') throw badRequest('page is not an artifact');
    const zip = await zipBundle(entry.absPath);
    const name = `${artifactStem(entry.relPath)}.artifact.zip`;
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('cache-control', 'private, no-store')
      .send(zip);
  });

  app.get('/api/pages/:id/artifact/state', async (request) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    if (entry.kind !== 'artifact') throw badRequest('page is not an artifact');
    return readArtifactState(id, request.authUser!.id);
  });

  app.put('/api/pages/:id/artifact/state', async (request) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    if (entry.kind !== 'artifact') throw badRequest('page is not an artifact');
    // State is not content: a read-only token may not write it either.
    session.requireWriteScope(request);
    const body = parseBody(artifactStatePutSchema, request.body);
    return writeArtifactState(id, request.authUser!.id, body);
  });
}
