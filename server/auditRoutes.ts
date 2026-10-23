/**
 * Instance admin only: the audit log screen's API (cookie session; a PAT never reaches it).
 *   GET /api/admin/audit             — one page of events, newest first, filtered
 *   GET /api/admin/audit/export.csv  — the same filter as a streamed CSV (capped)
 */
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { auditLogQuerySchema } from '../shared/contracts.js';
import type { AuditLogPage } from '../shared/contracts.js';
import * as session from './auth/session.js';
import { recordAudit } from './audit.js';
import { auditCsvChunks, listAuditEvents, type AuditExportResult } from './auditLog.js';
import { parseBody } from './validate.js';

function guard(request: Parameters<typeof session.requireCookieAuth>[0]): void {
  session.requireCookieAuth(request);
  session.requireInstanceAdmin(request);
}

export function registerAuditRoutes(app: FastifyInstance): void {
  app.get('/api/admin/audit', async (request): Promise<AuditLogPage> => {
    guard(request);
    return listAuditEvents(parseBody(auditLogQuerySchema, request.query));
  });

  app.get('/api/admin/audit/export.csv', async (request, reply) => {
    guard(request);
    const filters = parseBody(auditLogQuerySchema, request.query);
    const actorId = request.authUser!.id;
    const result: AuditExportResult = { rows: 0, truncated: false };
    const stream = Readable.from(auditCsvChunks(filters, result));
    stream.on('end', () => {
      recordAudit(actorId, 'audit.export', undefined, { rows: result.rows, truncated: result.truncated, filters: { ...filters, cursor: undefined, limit: undefined } });
    });
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="folio-audit-${stamp}.csv"`)
      .header('Cache-Control', 'no-store')
      .send(stream);
  });
}
