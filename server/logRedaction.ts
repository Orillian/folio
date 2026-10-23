/**
 * Fastify logs every incoming request's URL. For an OAuth redirect callback
 * that URL carries a one-time authorization code and the state value
 * (`?code=…&state=…`), which must not end up in the server log. This request
 * serializer is Fastify's default one with the query string of those
 * callback paths replaced by "?[redacted]", and the value of a `guestToken`
 * query parameter (the public-site assistant's per-conversation secret)
 * replaced by "[redacted]"; every other URL is logged as is.
 */
import type { FastifyRequest } from 'fastify';

const REDACTED_QUERY_PATHS = new Set(['/api/auth/google/callback', '/api/auth/github-connect/callback']);

/** Query parameters that are a bearer secret on any path: the public-site assistant's guest token (GET .../assistant/runs/:id/events, .../conversations/:id). */
const SECRET_QUERY_PARAM_RE = /([?&]guestToken=)[^&#]*/gi;

export function redactRequestUrl(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  if (REDACTED_QUERY_PATHS.has(url.slice(0, q)) || /^\/api\/auth\/oidc\/[^/?]+\/callback$/.test(url.slice(0, q))) return `${url.slice(0, q)}?[redacted]`;
  return url.replace(SECRET_QUERY_PARAM_RE, '$1[redacted]');
}


/** Pass as `logger: { serializers: requestLogSerializers }` (or spread into it). */
export const requestLogSerializers = {
  req(req: FastifyRequest) {
    const version = req.headers?.['accept-version'];
    return {
      method: req.method,
      url: redactRequestUrl(req.url),
      version: Array.isArray(version) ? version[0] : version,
      host: req.host,
      remoteAddress: req.ip,
      remotePort: req.socket?.remotePort,
    };
  },
};
