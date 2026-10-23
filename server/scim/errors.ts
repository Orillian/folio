/**
 * SCIM error responses (RFC 7644 §3.12): `{schemas: [Error], status: "400", scimType?, detail}`, sent with
 * `application/scim+json`. Everything under /scim/v2 answers in this shape, including a Folio HttpError thrown
 * by shared code (a 409 from the last-admin guard, a 404) and Fastify's own body errors.
 */
import { HttpError } from '../errors.js';

export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_CONTENT_TYPE = 'application/scim+json; charset=utf-8';

/** RFC 7644 Table 9 (the ones Folio sends). */
export type ScimType = 'invalidFilter' | 'tooMany' | 'uniqueness' | 'mutability' | 'invalidSyntax' | 'invalidPath' | 'noTarget' | 'invalidValue' | 'sensitive';

export class ScimError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly scimType?: ScimType,
    /** Seconds, for a 429. */
    readonly retryAfter?: number,
  ) {
    super(detail);
    this.name = 'ScimError';
  }
}

export const scimBadRequest = (detail: string, scimType: ScimType = 'invalidValue') => new ScimError(400, detail, scimType);
export const scimNotFound = (what: string) => new ScimError(404, `${what} not found`);
export const scimConflict = (detail: string, scimType: ScimType = 'uniqueness') => new ScimError(409, detail, scimType);
export const scimUnauthorized = (detail = 'a valid SCIM bearer token is required') => new ScimError(401, detail);

export function scimErrorBody(status: number, detail: string, scimType?: ScimType): Record<string, unknown> {
  return { schemas: [SCIM_ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail };
}

/** Any error thrown under /scim/v2 -> status + SCIM body. Unknown errors are a 500 with no internals in the detail. */
export function toScimError(err: unknown): ScimError {
  if (err instanceof ScimError) return err;
  if (err instanceof HttpError) {
    const scimType: ScimType | undefined = err.status === 409 ? (/admin/i.test(err.message) ? 'mutability' : 'uniqueness') : err.status === 400 ? 'invalidValue' : undefined;
    return new ScimError(err.status, err.message, scimType);
  }
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status >= 400 && status < 500) {
    const message = err instanceof Error ? err.message : 'invalid request';
    // Fastify: malformed JSON (FST_ERR_CTP_INVALID_JSON_BODY), empty body, unsupported media type, too large.
    return new ScimError(status, message, status === 400 || status === 415 ? 'invalidSyntax' : undefined);
  }
  return new ScimError(500, 'internal server error');
}
