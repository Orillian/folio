import type { ArtifactErrorCode } from '../../shared/contracts.js';
import { HttpError } from '../errors.js';

/** Anything an artifact import refuses: answered as 422 { code, message } (routes) or an MCP error text. */
export class ArtifactImportError extends HttpError {
  declare code: ArtifactErrorCode;
  constructor(code: ArtifactErrorCode, message: string) {
    super(422, message, code);
  }
}
