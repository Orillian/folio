/**
 * What Folio never sends to Sentry, shared by the server (server/sentry.ts) and the web app (web/src/sentry).
 * Pure functions on plain objects, so they are easy to test and need no Sentry import.
 *
 * Stripped everywhere: query strings (they carry `?share=`, `?token=`, `guestToken`, search words), tokens inside
 * paths (`/share/<token>`, `/invite/<token>`), cookies, authorization and other request headers, request bodies,
 * form data, and everything about the user except the id. Page content, titles and search text never reach an
 * event in the first place; this is the second line of defence.
 */

const TOKEN_PATH_RES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(\/share\/)[^/?#]+/g, '$1[token]'],
  [/(\/invite\/)[^/?#]+/g, '$1[token]'],
  [/(\/api\/invite\/)[^/?#]+/g, '$1[token]'],
  [/(\/api\/share\/)[^/?#]+/g, '$1[token]'],
  [/(\/oauth\/(?:authorize|token)\/)[^/?#]+/g, '$1[token]'],
];

/** The path of a URL, or of a bare path, without query string, fragment or tokens; the origin is kept when there is one. */
export function scrubUrl(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  let out = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/i, '$1'); // user:token@host
  const cut = out.search(/[?#]/);
  if (cut !== -1) out = out.slice(0, cut);
  for (const [re, to] of TOKEN_PATH_RES) out = out.replace(re, to);
  return out;
}

/** Replaces every URL-looking token in free text (breadcrumb messages, exception messages) by its scrubbed form. */
export function scrubText(text: string): string {
  return text.replace(/(?:https?:\/\/[^\s"'<>)]+|\/[A-Za-z0-9_\-./:%~+=@]*\?[^\s"'<>)]*)/g, (m) => scrubUrl(m) ?? m);
}

const URL_KEYS = new Set(['url', 'to', 'from', 'http.url', 'url.full', 'http.target', 'url.path', 'request_url', 'page_url']);
const QUERY_KEYS = new Set(['http.query', 'url.query', 'query', 'http.fragment', 'url.fragment', 'query_string', 'body', 'data_body', 'request_body', 'cookies', 'cookie']);

/** Scrubs a free-form record (breadcrumb data, span data) in place of a copy: URLs lose query/tokens, query/body-like keys go. */
export function scrubRecord(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object') return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (QUERY_KEYS.has(key)) continue;
    if (URL_KEYS.has(key) && typeof value === 'string') out[key] = scrubUrl(value);
    else out[key] = value;
  }
  return out;
}

interface Breadcrumbish {
  type?: string;
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * A click breadcrumb's message is the CSS path of the element (`div#root > button.save[aria-label="Delete \u201cQ3 plan\u201d"]`):
 * ids, classes and tags are interface structure and stay; attribute VALUES (aria-label, title, alt, name) can carry a
 * page title or a person's text, so only the attribute names are kept. Length is capped.
 */
export function scrubClickSelector(message: string): string {
  return message.replace(/\[([\w:-]+)=(?:"[^"]*"|'[^']*')\]/g, '[$1]').slice(0, 300);
}

const CLICK_KEYS = new Set(['type', 'category', 'level', 'timestamp']);

/**
 * Breadcrumb filter: UI input and console breadcrumbs are dropped (they may hold typed text); a click keeps its
 * selector (without attribute values) and nothing else, so the report shows the sequence of actions without any
 * text the person saw; the rest lose query strings.
 */
export function scrubBreadcrumb<B extends Breadcrumbish>(crumb: B): B | null {
  if (crumb.category === 'console' || crumb.category === 'ui.input') return null;
  if (crumb.category === 'ui.click') {
    const click: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(crumb)) if (CLICK_KEYS.has(key)) click[key] = value;
    if (typeof crumb.message === 'string') click.message = scrubClickSelector(crumb.message);
    return click as unknown as B;
  }
  const next = { ...crumb };
  if (next.data) next.data = scrubRecord(next.data);
  if (typeof next.message === 'string') next.message = scrubText(next.message);
  return next;
}

interface Eventish {
  request?: {
    url?: string;
    headers?: Record<string, string>;
    cookies?: unknown;
    data?: unknown;
    query_string?: unknown;
    env?: unknown;
    [key: string]: unknown;
  };
  user?: Record<string, unknown> & { id?: unknown };
  breadcrumbs?: Breadcrumbish[];
  transaction?: string;
  spans?: Array<{ description?: string; data?: Record<string, unknown> }>;
  contexts?: Record<string, Record<string, unknown> | undefined>;
  extra?: Record<string, unknown>;
  server_name?: string;
  type?: string;
  message?: string;
  exception?: { values?: Array<{ value?: string }> };
  [key: string]: unknown;
}

/** Request headers worth keeping for debugging; everything else (authorization, cookie, x-api-key, ...) goes. */
const KEEP_HEADERS = new Set(['user-agent', 'accept-language', 'content-type', 'content-length', 'referer-origin']);

/**
 * Scrubs one event (error, transaction or feedback) and returns it. Never throws: whatever cannot be read is left out.
 * The user keeps only `id`; the request keeps method, a scrubbed URL and a few harmless headers.
 */
export function scrubEvent<E extends object>(event: E): E {
  const e = event as unknown as Eventish;
  if (e.request) {
    const req = e.request;
    const url = scrubUrl(req.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) if (KEEP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    const next: NonNullable<Eventish['request']> = { ...req, headers };
    delete next.cookies;
    delete next.data;
    delete next.query_string;
    delete next.env;
    if (url !== undefined) next.url = url;
    else delete next.url;
    e.request = next;
  }
  if (e.user) {
    const id = e.user.id;
    if (id === undefined || id === null || id === '') delete e.user;
    else e.user = { id: String(id) };
  }
  if (Array.isArray(e.breadcrumbs)) {
    e.breadcrumbs = e.breadcrumbs.map((b) => scrubBreadcrumb(b)).filter((b): b is Breadcrumbish => b !== null);
  }
  if (typeof e.transaction === 'string') e.transaction = scrubUrl(e.transaction) ?? e.transaction;
  if (Array.isArray(e.spans)) {
    for (const span of e.spans) {
      if (typeof span.description === 'string') span.description = scrubText(span.description);
      if (span.data) span.data = scrubRecord(span.data);
    }
  }
  const trace = e.contexts?.trace;
  if (trace?.data && typeof trace.data === 'object') trace.data = scrubRecord(trace.data as Record<string, unknown>);
  if (typeof e.message === 'string' && e.type !== 'feedback') e.message = scrubText(e.message);
  for (const ex of e.exception?.values ?? []) if (typeof ex.value === 'string') ex.value = scrubText(ex.value);
  if (e.contexts) delete e.contexts.cloud_resource;
  delete e.server_name;
  return event;
}
