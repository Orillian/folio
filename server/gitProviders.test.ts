import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as gitProviders from './gitProviders.js';

/** Spins a tiny real HTTP server standing in for a GitLab/GitHub API, and records exactly what it received (path + headers) so tests can assert the request shape, not just the parsed response. */
function startMockProvider(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ host: string; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ host: `127.0.0.1:${port}`, server });
    });
  });
}

describe('gitProviders.ts (round 11, real local mock HTTP server -- no real network)', () => {
  let openServer: http.Server | undefined;
  afterEach(async () => {
    if (openServer) await new Promise((r) => openServer!.close(r));
    openServer = undefined;
  });

  it('listRepos(gitlab): hits /api/v4/projects with PRIVATE-TOKEN and maps the response into GitProviderRepos', async () => {
    let receivedPath = '';
    let receivedToken: string | undefined;
    const { host, server } = await startMockProvider((req, res) => {
      receivedPath = req.url ?? '';
      receivedToken = req.headers['private-token'] as string | undefined;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify([
          { name: 'repo-one', name_with_namespace: 'group / repo-one', http_url_to_repo: 'https://gitlab.example.com/group/repo-one.git', default_branch: 'main', description: 'First repo' },
          { name: 'repo-two', http_url_to_repo: 'https://gitlab.example.com/group/repo-two.git', default_branch: null, description: null },
        ]),
      );
    });
    openServer = server;

    const result = await gitProviders.listRepos(host, 'gitlab', 'glpat-mock-token');

    expect(receivedPath).toContain('/api/v4/projects');
    expect(receivedPath).toContain('membership=true');
    expect(receivedToken).toBe('glpat-mock-token');
    expect(result.provider).toBe('gitlab');
    expect(result.host).toBe(host);
    expect(result.repos).toEqual([
      { name: 'group / repo-one', url: 'https://gitlab.example.com/group/repo-one.git', defaultBranch: 'main', description: 'First repo' },
      { name: 'repo-two', url: 'https://gitlab.example.com/group/repo-two.git', defaultBranch: null, description: undefined },
    ]);
  });

  it('listRepos(github): hits /api/v3/user/repos (GitHub Enterprise shape for a non-github.com host) with a Bearer Authorization header', async () => {
    let receivedPath = '';
    let receivedAuth: string | undefined;
    const { host, server } = await startMockProvider((req, res) => {
      receivedPath = req.url ?? '';
      receivedAuth = req.headers.authorization;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ name: 'repo', full_name: 'org/repo', clone_url: 'https://github.example.com/org/repo.git', default_branch: 'main', description: 'A repo' }]));
    });
    openServer = server;

    const result = await gitProviders.listRepos(host, 'github', 'ghp-mock-token');

    expect(receivedPath).toContain('/api/v3/user/repos');
    expect(receivedAuth).toBe('Bearer ghp-mock-token');
    expect(result.provider).toBe('github');
    expect(result.repos).toEqual([{ name: 'org/repo', url: 'https://github.example.com/org/repo.git', defaultBranch: 'main', description: 'A repo' }]);
  });

  it('a 401 becomes a typed token-invalid error that never carries the token', async () => {
    const { host, server } = await startMockProvider((_req, res) => {
      res.statusCode = 401;
      res.end('Unauthorized');
    });
    openServer = server;

    const err = await listError(host, 'gitlab', 'a-bad-token');
    expect(err.code).toBe('git_provider_token_invalid');
    expect(err.status).toBe(400); // never 401: the web client would read that as "Folio session ended"
    expect(err.message).toContain(host);
    expect(JSON.stringify(err)).not.toContain('a-bad-token');
    expect(err.message).not.toContain('a-bad-token');
  });

  it('an unreachable host fails with a typed error naming the host, never the token', async () => {
    // Port 1 is reserved/unroutable -- a fast, reliable "connection refused" without a real network call.
    const err = await listError('127.0.0.1:1', 'gitlab', 'a-secret-token');
    expect(err.code).toBe('git_provider_unreachable');
    expect(err.message).toContain('127.0.0.1:1');
    expect(err.message).not.toContain('a-secret-token');
  });
});

/** Runs listRepos and returns the GitProviderError it must throw. */
async function listError(host: string, provider: 'github' | 'gitlab', token: string): Promise<gitProviders.GitProviderError> {
  try {
    await gitProviders.listRepos(host, provider, token);
  } catch (err) {
    expect(err).toBeInstanceOf(gitProviders.GitProviderError);
    return err as gitProviders.GitProviderError;
  }
  throw new Error('expected listRepos to fail');
}

describe('gitProviders.ts: pagination and provider errors', () => {
  let openServer: http.Server | undefined;
  afterEach(async () => {
    if (openServer) await new Promise((r) => openServer!.close(r));
    openServer = undefined;
  });

  /** A paged mock: `pages` repos arrays served at ?page=N, each linking to the next via a Link header. */
  function pagedHandler(pagesData: unknown[][], seen: string[], origin?: () => string) {
    return (req: http.IncomingMessage, res: http.ServerResponse) => {
      seen.push(req.url ?? '');
      const page = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('page') ?? '1');
      const base = origin ? origin() : `http://${req.headers.host}`;
      if (page < pagesData.length) {
        res.setHeader('Link', `<${base}${(req.url ?? '').split('?')[0]}?page=${page + 1}>; rel="next", <${base}/last>; rel="last"`);
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(pagesData[page - 1] ?? []));
    };
  }

  const ghRepo = (n: number) => ({ name: `r${n}`, full_name: `org/r${n}`, clone_url: `https://github.example.com/org/r${n}.git`, default_branch: 'master', description: null });
  const glRepo = (n: number) => ({ name: `r${n}`, http_url_to_repo: `https://gitlab.example.com/g/r${n}.git`, default_branch: 'main', description: null });

  it('github: follows the Link rel=next header across pages', async () => {
    const seen: string[] = [];
    const { host, server } = await startMockProvider(pagedHandler([[ghRepo(1), ghRepo(2)], [ghRepo(3)], [ghRepo(4)]], seen));
    openServer = server;

    const result = await gitProviders.listRepos(host, 'github', 't');
    expect(result.repos.map((r) => r.name)).toEqual(['org/r1', 'org/r2', 'org/r3', 'org/r4']);
    expect(result.repos[0].defaultBranch).toBe('master');
    expect(seen).toHaveLength(3);
    expect(seen.every((u) => u.startsWith('/api/v3/user/repos'))).toBe(true);
  });

  it('gitlab: follows the Link rel=next header across pages', async () => {
    const seen: string[] = [];
    const { host, server } = await startMockProvider(pagedHandler([[glRepo(1)], [glRepo(2)]], seen));
    openServer = server;

    const result = await gitProviders.listRepos(host, 'gitlab', 't');
    expect(result.repos.map((r) => r.name)).toEqual(['r1', 'r2']);
    expect(seen).toHaveLength(2);
    expect(seen.every((u) => u.startsWith('/api/v4/projects'))).toBe(true);
  });

  it('stops at the page cap even when the provider keeps sending next links', async () => {
    const seen: string[] = [];
    const endless = Array.from({ length: 50 }, (_, i) => [glRepo(i)]);
    const { host, server } = await startMockProvider(pagedHandler(endless, seen));
    openServer = server;

    const result = await gitProviders.listRepos(host, 'gitlab', 't');
    expect(seen).toHaveLength(gitProviders.MAX_PAGES);
    expect(result.repos).toHaveLength(gitProviders.MAX_PAGES);
  });

  it('stops at the repo cap', async () => {
    const seen: string[] = [];
    const big = Array.from({ length: 600 }, (_, i) => glRepo(i));
    const { host, server } = await startMockProvider(pagedHandler([big, big, big, big], seen));
    openServer = server;

    const result = await gitProviders.listRepos(host, 'gitlab', 't');
    expect(result.repos).toHaveLength(gitProviders.MAX_REPOS);
    expect(seen).toHaveLength(2);
  });

  it('never sends the token to another host named in a Link header; the next page is requested on the original host', async () => {
    const seen: string[] = [];
    const { host, server } = await startMockProvider(pagedHandler([[glRepo(1)], [glRepo(2)]], seen, () => 'https://attacker.example.com'));
    openServer = server;

    const result = await gitProviders.listRepos(host, 'gitlab', 't');
    expect(result.repos.map((r) => r.name)).toEqual(['r1', 'r2']);
    expect(seen).toHaveLength(2);
  });

  it('parseNextLink picks rel=next and ignores other relations', () => {
    expect(gitProviders.parseNextLink(null)).toBeNull();
    expect(gitProviders.parseNextLink('<https://a.example.com/x?page=1>; rel="prev", <https://a.example.com/x?page=9>; rel="last"')).toBeNull();
    expect(gitProviders.parseNextLink('<https://a.example.com/x?page=1>; rel="prev", <https://a.example.com/x?page=3>; rel="next"')).toBe('https://a.example.com/x?page=3');
    expect(gitProviders.parseNextLink('<https://a.example.com/x?a=1,2&page=3>; rel=next')).toBe('https://a.example.com/x?a=1,2&page=3');
  });

  it('github 403 with x-ratelimit-remaining 0 is a rate-limit error (429)', async () => {
    const { host, server } = await startMockProvider((_req, res) => {
      res.statusCode = 403;
      res.setHeader('x-ratelimit-remaining', '0');
      res.end('{}');
    });
    openServer = server;

    const err = await listError(host, 'github', 'ghp-secret');
    expect(err.code).toBe('git_provider_rate_limited');
    expect(err.status).toBe(429);
  });

  it('a 429 is a rate-limit error', async () => {
    const { host, server } = await startMockProvider((_req, res) => {
      res.statusCode = 429;
      res.end('slow down');
    });
    openServer = server;
    expect((await listError(host, 'gitlab', 't')).code).toBe('git_provider_rate_limited');
  });

  it('github 403 with x-github-sso is an SSO error carrying the https authorization link, not the token', async () => {
    const { host, server } = await startMockProvider((_req, res) => {
      res.statusCode = 403;
      res.setHeader('x-github-sso', 'required; url=https://github.com/orgs/acme/sso?authorization_request=abc123');
      res.end('{}');
    });
    openServer = server;

    const err = await listError(host, 'github', 'ghp-secret');
    expect(err.code).toBe('git_provider_sso_required');
    expect(err.ssoUrl).toBe('https://github.com/orgs/acme/sso?authorization_request=abc123');
    expect(err.localize('en')).toContain('https://github.com/orgs/acme/sso?authorization_request=abc123');
    expect(err.localize('uk')).toContain('https://github.com/orgs/acme/sso');
    expect(JSON.stringify(err.localize('en'))).not.toContain('ghp-secret');
  });

  it('an SSO header whose url is not https keeps the SSO error but drops the link', async () => {
    const { host, server } = await startMockProvider((_req, res) => {
      res.statusCode = 403;
      res.setHeader('x-github-sso', 'required; url=javascript:alert(1)');
      res.end('{}');
    });
    openServer = server;

    const err = await listError(host, 'github', 't');
    expect(err.code).toBe('git_provider_sso_required');
    expect(err.ssoUrl).toBeUndefined();
    expect(err.localize('en')).not.toContain('javascript');
  });

  it('a plain 403 is a forbidden error, other statuses a generic provider error with the status', async () => {
    let status = 403;
    const { host, server } = await startMockProvider((_req, res) => {
      res.statusCode = status;
      res.end('{}');
    });
    openServer = server;

    expect((await listError(host, 'github', 't')).code).toBe('git_provider_forbidden');
    status = 500;
    const err = await listError(host, 'github', 't');
    expect(err.code).toBe('git_provider_error');
    expect(err.localize('en')).toContain('500');
  });

  it('a 200 with a body that is not a repository array is a provider error, not a crash', async () => {
    const { host, server } = await startMockProvider((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: 'not an array' }));
    });
    openServer = server;
    expect((await listError(host, 'github', 't')).code).toBe('git_provider_error');
  });

  it('error texts exist in every server language and keep the {host} placeholder substituted', () => {
    const err = new gitProviders.GitProviderError('git_provider_token_invalid', 'git.example.com');
    for (const lang of ['en', 'uk', 'ru']) {
      const text = err.localize(lang);
      expect(text).toContain('git.example.com');
      expect(text).not.toContain('{host}');
    }
    expect(err.localize('uk')).not.toBe(err.localize('en'));
    const localized = err.toLocalizedHttpError('ru');
    expect(localized.code).toBe('git_provider_token_invalid');
    expect(localized.message).toBe(err.localize('ru'));
  });
});
