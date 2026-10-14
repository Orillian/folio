/**
 * Round 11: server-side calls to a git provider's own REST API (never the
 * browser — the saved PAT never leaves the server) to list repos the caller
 * has access to, for the create-space-from-repo dropdown.
 *
 * Each provider is a small adapter (list URL, auth headers, response mapping);
 * the paging and error handling around it are shared. Provider failures are
 * thrown as typed GitProviderError values carrying a stable code, so the
 * route can answer with a localized message instead of an empty list.
 */
import type { GitProviderRepo, GitProviderRepos } from '../shared/contracts.js';
import { HttpError } from './errors.js';
import { serverText, type ServerTextKey } from './serverText.js';
import type { Provider } from './userGitCredentials.js';

/** Stop following `Link: rel="next"` after this many pages, or this many repos, whichever comes first. */
export const MAX_PAGES = 10;
export const MAX_REPOS = 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export type GitProviderErrorCode =
  | 'git_provider_token_invalid'
  | 'git_provider_rate_limited'
  | 'git_provider_sso_required'
  | 'git_provider_forbidden'
  | 'git_provider_unreachable'
  | 'git_provider_error';

const TEXT_KEY: Record<GitProviderErrorCode, ServerTextKey> = {
  git_provider_token_invalid: 'gitRepos.tokenInvalid',
  git_provider_rate_limited: 'gitRepos.rateLimited',
  git_provider_sso_required: 'gitRepos.ssoRequired',
  git_provider_forbidden: 'gitRepos.forbidden',
  git_provider_unreachable: 'gitRepos.unreachable',
  git_provider_error: 'gitRepos.failed',
};

/**
 * A provider API failure. The English `message` is a safe fallback; call
 * `localize(lang)` for the text shown to a person. Neither ever contains the
 * token: only the provider host, an HTTP status and (for SAML SSO) the https
 * authorization link the provider itself sent back.
 */
export class GitProviderError extends HttpError {
  readonly providerHost: string;
  readonly providerStatus?: number;
  readonly ssoUrl?: string;

  constructor(code: GitProviderErrorCode, host: string, opts: { status?: number; ssoUrl?: string } = {}) {
    // 400 (or 429), never 401: the web client treats a 401 as "your Folio session ended" and logs the user out.
    super(code === 'git_provider_rate_limited' ? 429 : 400, '', code);
    this.name = 'GitProviderError';
    this.providerHost = host;
    this.providerStatus = opts.status;
    this.ssoUrl = opts.ssoUrl;
    this.message = this.localize('en');
  }

  localize(language?: string | null): string {
    const code = this.code as GitProviderErrorCode;
    const key: ServerTextKey = code === 'git_provider_sso_required' && this.ssoUrl ? 'gitRepos.ssoRequiredUrl' : TEXT_KEY[code];
    return serverText(key, language)
      .replace('{host}', this.providerHost)
      .replace('{status}', String(this.providerStatus ?? ''))
      .replace('{url}', this.ssoUrl ?? '');
  }

  /** The same error with its message in `language` — what a route throws so the client gets localized text plus the code. */
  toLocalizedHttpError(language?: string | null): HttpError {
    return new HttpError(this.status, this.localize(language), this.code);
  }
}

interface GitlabProject {
  name_with_namespace?: string;
  name: string;
  http_url_to_repo: string;
  default_branch: string | null;
  description: string | null;
}

interface GithubRepo {
  full_name?: string;
  name: string;
  clone_url: string;
  default_branch: string | null;
  description: string | null;
}

interface ProviderAdapter {
  /** First page URL. */
  reposUrl(scheme: string, host: string): string;
  authHeaders(token: string): Record<string, string>;
  mapRepo(raw: unknown): GitProviderRepo;
}

const ADAPTERS: Record<Provider, ProviderAdapter> = {
  gitlab: {
    reposUrl: (scheme, host) => `${scheme}://${host}/api/v4/projects?membership=true&simple=true&per_page=100`,
    authHeaders: (token) => ({ 'PRIVATE-TOKEN': token }),
    mapRepo: (raw) => {
      const p = raw as GitlabProject;
      return {
        name: p.name_with_namespace ?? p.name,
        url: p.http_url_to_repo,
        defaultBranch: p.default_branch ?? null,
        description: p.description ?? undefined,
      };
    },
  },
  github: {
    // github.com itself is reached via api.github.com; a GitHub Enterprise host serves its own API under /api/v3.
    reposUrl: (scheme, host) =>
      host === 'github.com' ? `${scheme}://api.github.com/user/repos?per_page=100` : `${scheme}://${host}/api/v3/user/repos?per_page=100`,
    authHeaders: (token) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }),
    mapRepo: (raw) => {
      const r = raw as GithubRepo;
      return {
        name: r.full_name ?? r.name,
        url: r.clone_url,
        defaultBranch: r.default_branch ?? null,
        description: r.description ?? undefined,
      };
    },
  },
};

/** localhost (and 127.0.0.1) get plain http — this is what makes GET /api/git/repos testable against a real local mock server; every real provider host gets https, always. */
function schemeFor(host: string): 'http' | 'https' {
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host) ? 'http' : 'https';
}

/** `Link: <https://…?page=2>; rel="next", <…>; rel="last"` -> the rel="next" target, if any. */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(/,(?=\s*<)/)) {
    const m = /^\s*<([^>]+)>(.*)$/.exec(part);
    if (!m) continue;
    for (const param of m[2].split(';')) {
      const rel = /^\s*rel\s*=\s*"?([^"]*)"?\s*$/i.exec(param);
      if (rel && rel[1].toLowerCase().split(/\s+/).includes('next')) return m[1];
    }
  }
  return null;
}

/** GitHub's `x-github-sso: required; url=https://…` -> that https url, or undefined (never anything but https). */
function ssoUrlFrom(header: string): string | undefined {
  const m = /url=(\S+?)\s*(?:[;,]|$)/i.exec(header);
  if (!m) return undefined;
  try {
    const u = new URL(m[1]);
    return u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function classifyFailure(res: Response, host: string): GitProviderError {
  const status = res.status;
  if (status === 401) return new GitProviderError('git_provider_token_invalid', host, { status });
  if (status === 429) return new GitProviderError('git_provider_rate_limited', host, { status });
  if (status === 403) {
    const sso = res.headers.get('x-github-sso');
    if (sso) return new GitProviderError('git_provider_sso_required', host, { status, ssoUrl: ssoUrlFrom(sso) });
    // GitHub: primary limit -> x-ratelimit-remaining 0; secondary (abuse) limit -> retry-after.
    if (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after')) {
      return new GitProviderError('git_provider_rate_limited', host, { status });
    }
    return new GitProviderError('git_provider_forbidden', host, { status });
  }
  return new GitProviderError('git_provider_error', host, { status });
}

async function fetchPage(url: string, headers: Record<string, string>, host: string): Promise<{ data: unknown[]; next: string | null }> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    // Network error or timeout. `headers` carries the token, so nothing from the thrown error or the request is echoed.
    throw new GitProviderError('git_provider_unreachable', host);
  }
  if (!res.ok) throw classifyFailure(res, host);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new GitProviderError('git_provider_error', host, { status: res.status });
  }
  if (!Array.isArray(data)) throw new GitProviderError('git_provider_error', host, { status: res.status });
  return { data, next: parseNextLink(res.headers.get('link')) };
}

export async function listRepos(host: string, provider: Provider, token: string): Promise<GitProviderRepos> {
  const adapter = ADAPTERS[provider];
  const scheme = schemeFor(host);
  const headers = adapter.authHeaders(token);
  let url: string | null = adapter.reposUrl(scheme, host);
  const firstUrl = new URL(url);
  const repos: GitProviderRepo[] = [];

  for (let page = 0; url && page < MAX_PAGES && repos.length < MAX_REPOS; page++) {
    const { data, next } = await fetchPage(url, headers, host);
    for (const raw of data) repos.push(adapter.mapRepo(raw));
    if (!next) break;
    // The token rides every request, so a next link is only ever followed on the host the first request went to
    // (its path and query are kept; a proxy that reports a different scheme or host in the header is ignored).
    let parsed: URL;
    try {
      parsed = new URL(next, firstUrl);
    } catch {
      break;
    }
    url = new URL(parsed.pathname + parsed.search, firstUrl.origin).toString();
  }
  return { provider, host, repos: repos.slice(0, MAX_REPOS) };
}
