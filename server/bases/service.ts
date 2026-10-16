/**
 * Writing a base's `.base` file (Obsidian Bases, 16.10.2026) — the one write path of PUT /api/pages/:id/base
 * (bases/routes.ts) and of the MCP save_base tool: the etag check, the size cap and the validity check run under the
 * space lock, in the same transform, so a file that does not parse is never written.
 */
import { createHash } from 'node:crypto';
import type { BaseConfig, BaseSourceResponse } from '../../shared/bases/types.js';
import { BASE_MAX_BYTES } from '../../shared/bases/types.js';
import { parseBaseConfig } from '../../shared/bases/parse.js';
import { updateBaseSource } from '../../shared/bases/writer.js';
import { badRequest, HttpError } from '../errors.js';
import * as storage from '../storage.js';
import type { PageIndexEntry } from '../storage.js';

export function baseEtag(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** 409 of a write whose etag no longer matches; carries the current source for the response body. */
export class BaseConflictError extends HttpError {
  constructor(public current: BaseSourceResponse) {
    super(409, 'the base file changed since it was read');
  }
}

export function sourceResponse(text: string, canEdit: boolean): BaseSourceResponse {
  const parsed = parseBaseConfig(text);
  return { source: text, etag: baseEtag(text), config: parsed.config, ...(parsed.error ? { error: parsed.error } : {}), canEdit };
}

/** `message (line N)` of a parse error, the way every surface words it. */
export function baseErrorText(error: { message: string; line?: number }): string {
  return `${error.message}${error.line ? ` (line ${error.line})` : ''}`;
}

/**
 * Replaces a base's file with `source` (the whole YAML), or with `config` merged into the current text
 * (writer.ts keeps what the config does not carry). An `etag` that is not the file's current one is a
 * BaseConflictError; without one the write is last-writer-wins (the REST route always sends one).
 */
export async function writeBase(
  id: string,
  body: { etag?: string; config?: BaseConfig; source?: string },
): Promise<{ entry: PageIndexEntry; text: string; written: boolean }> {
  return storage.writeBaseRaw(id, (current) => {
    if (body.etag !== undefined && body.etag !== baseEtag(current)) throw new BaseConflictError(sourceResponse(current, true));
    const next = body.config ? updateBaseSource(current, body.config) : (body.source as string);
    if (next.length > BASE_MAX_BYTES) throw badRequest('the base file would be too large');
    const check = parseBaseConfig(next);
    if (check.error) throw badRequest(`not a valid base: ${baseErrorText(check.error)}`);
    return next;
  });
}
