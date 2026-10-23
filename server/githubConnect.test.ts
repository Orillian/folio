/**
 * "Connect with GitHub" (server/auth/githubConnect.ts) end to end over HTTP,
 * against a real PostgreSQL schema and a local mock HTTP server standing in
 * for github.com's token endpoint and api.github.com — no real network.
 */
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { setUpTestSchema } from './db/testSchema.js';
import { query } from './db/pool.js';
import * as userGitCredentials from './userGitCredentials.js';
import { redactRequestUrl, requestLogSerializers } from './logRedaction.js';
import {
  GITHUB_CONNECT_CALLBACK_PATH,
  GITHUB_CONNECT_START_PATH,
  __setGitHubEndpointsForTests,
  isGitHubConnectEnabled,
  registerGitHubConnectRoutes,
  safeReturnPath,
} from './auth/githubConnect.js';

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret-value';
const ISSUED_TOKEN = 'gho_issuedTokenThatMustNeverLeak123';
const ONE_TIME_CODE = 'one-time-code-abc';
const PUBLIC_URL = 'https://folio.example.com';

interface MockGitHub {
  base: string;
  server: http.Server;
  tokenRequests: URLSearchParams[];
  userAuth: string[];
  /** What the token endpoint answers; default: a token with the `repo` scope. */
  tokenResponse: { status: number; body: unknown };
  userResponse: { status: number; body: unknown };
}

function startMockGitHub(): Promise<MockGitHub> {
  const mock: Omit<MockGitHub, 'base' | 'server'> = {
    tokenRequests: [],
    userAuth: [],
    tokenResponse: { status: 200, body: { access_token: ISSUED_TOKEN, token_type: 'bearer', scope: 'repo' } },
    userResponse: { status: 200, body: { login: 'octo-user', id: 1 } },
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'POST' && req.url === '/login/oauth/access_token') {
          mock.tokenRequests.push(new URLSearchParams(raw));
          res.statusCode = mock.tokenResponse.status;
          res.end(JSON.stringify(mock.tokenResponse.body));
          return;
        }
        if (req.method === 'GET' && req.url === '/user') {
          mock.userAuth.push(String(req.headers.authorization ?? ''));
          res.statusCode = mock.userResponse.status;
          res.end(JSON.stringify(mock.userResponse.body));
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(Object.assign(mock, { base: `http://127.0.0.1:${port}`, server }));
    });
  });
}

const ENV_KEYS = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'PUBLIC_URL', 'FOLIO_DEMO_MODE'] as const;

describe('Connect with GitHub (OAuth App) over HTTP', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let github: MockGitHub;
  let logs = '';
  let userId: string;
  let userCookie: string;
  let otherCookie: string;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeAll(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    teardownSchema = await setUpTestSchema();
    github = await startMockGitHub();
    __setGitHubEndpointsForTests({
      authorizeUrl: `${github.base}/login/oauth/authorize`,
      tokenUrl: `${github.base}/login/oauth/access_token`,
      apiBaseUrl: github.base,
    });

    const user = await authStore.createUser({ email: 'connector@example.com', name: 'Connector', passwordHash: 'x', isAdmin: false });
    const other = await authStore.createUser({ email: 'other@example.com', name: 'Other', passwordHash: 'x', isAdmin: false });
    userId = user.id;
    userCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(user.id)).token}`;
    otherCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(other.id)).token}`;

    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logs += chunk.toString();
        callback();
      },
    });
    const app_ = Fastify({ logger: { level: 'trace', stream: logStream, serializers: requestLogSerializers } });
    app_.decorateRequest('authUser', null);
    await app_.register(fastifyCookieModule.default);
    registerGitHubConnectRoutes(app_);
    await app_.ready();
    app = app_;
  });

  afterAll(async () => {
    await app?.close();
    __setGitHubEndpointsForTests(null);
    await new Promise((r) => github.server.close(r));
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await teardownSchema();
  });

  beforeEach(async () => {
    process.env.GITHUB_CLIENT_ID = CLIENT_ID;
    process.env.GITHUB_CLIENT_SECRET = CLIENT_SECRET;
    process.env.PUBLIC_URL = PUBLIC_URL;
    delete process.env.FOLIO_DEMO_MODE;
    github.tokenRequests.length = 0;
    github.userAuth.length = 0;
    github.tokenResponse = { status: 200, body: { access_token: ISSUED_TOKEN, token_type: 'bearer', scope: 'repo' } };
    github.userResponse = { status: 200, body: { login: 'octo-user', id: 1 } };
    await query('DELETE FROM git_credentials');
  });

  afterEach(() => {
    expect(logs).not.toContain(ISSUED_TOKEN);
    expect(logs).not.toContain(ONE_TIME_CODE);
    expect(logs).not.toContain(CLIENT_SECRET);
  });

  /** Runs /start as `cookie` and returns what the callback needs: GitHub's authorize URL and the state cookie. */
  async function start(cookie: string, returnTo?: string) {
    const url = returnTo ? `${GITHUB_CONNECT_START_PATH}?returnTo=${encodeURIComponent(returnTo)}` : GITHUB_CONNECT_START_PATH;
    const res = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    const stateCookie = res.cookies.find((c) => c.name === 'folio_github_connect');
    return { res, location, stateCookie };
  }

  function callback(cookie: string, params: Record<string, string>) {
    return app.inject({ method: 'GET', url: `${GITHUB_CONNECT_CALLBACK_PATH}?${new URLSearchParams(params)}`, headers: { cookie } });
  }

  function resultOf(location: unknown): string | null {
    return new URL(String(location)).searchParams.get('gitConnect');
  }

  it('is disabled unless both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set: /start goes back with gitConnect=disabled', async () => {
    expect(isGitHubConnectEnabled()).toBe(true);
    delete process.env.GITHUB_CLIENT_SECRET;
    expect(isGitHubConnectEnabled()).toBe(false);
    const res = await app.inject({ method: 'GET', url: GITHUB_CONNECT_START_PATH, headers: { cookie: userCookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${PUBLIC_URL}/?gitConnect=disabled`);
    expect(res.cookies.find((c) => c.name === 'folio_github_connect')).toBeUndefined();
  });

  it('is disabled in the public demo', async () => {
    process.env.FOLIO_DEMO_MODE = '1';
    expect(isGitHubConnectEnabled()).toBe(false);
    const res = await app.inject({ method: 'GET', url: GITHUB_CONNECT_START_PATH, headers: { cookie: userCookie } });
    expect(resultOf(res.headers.location)).toBe('demo');
  });

  it('/start requires a cookie session — no session, or only a Bearer token, goes back with gitConnect=session', async () => {
    const anonymous = await app.inject({ method: 'GET', url: GITHUB_CONNECT_START_PATH });
    expect(anonymous.statusCode).toBe(302);
    expect(resultOf(anonymous.headers.location)).toBe('session');

    const bearer = await app.inject({ method: 'GET', url: GITHUB_CONNECT_START_PATH, headers: { authorization: 'Bearer folio_pat_whatever' } });
    expect(resultOf(bearer.headers.location)).toBe('session');
  });

  it('/start redirects to GitHub with scope repo, allow_signup=false, PKCE S256 and the callback URL under PUBLIC_URL', async () => {
    const { location, stateCookie } = await start(userCookie);
    expect(`${location.origin}${location.pathname}`).toBe(`${github.base}/login/oauth/authorize`);
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(location.searchParams.get('scope')).toBe('repo');
    expect(location.searchParams.get('allow_signup')).toBe('false');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}${GITHUB_CONNECT_CALLBACK_PATH}`);
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(stateCookie?.httpOnly).toBe(true);
    expect(stateCookie?.path).toBe(GITHUB_CONNECT_CALLBACK_PATH);
    // Sealed: neither the state nor anything else readable sits in the cookie.
    expect(stateCookie?.value).not.toContain(location.searchParams.get('state')!);
  });

  it('success: exchanges the code with the PKCE verifier, saves the token as an oauth github.com credential, and never returns it', async () => {
    const { location, stateCookie } = await start(userCookie, '/s/team/handbook?tab=x');
    const res = await callback(`${userCookie}; folio_github_connect=${stateCookie!.value}`, { code: ONE_TIME_CODE, state: location.searchParams.get('state')! });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${PUBLIC_URL}/s/team/handbook?gitConnect=ok`);
    expect(res.body).not.toContain(ISSUED_TOKEN);
    expect(JSON.stringify(res.headers)).not.toContain(ISSUED_TOKEN);

    expect(github.tokenRequests).toHaveLength(1);
    const sent = github.tokenRequests[0];
    expect(sent.get('client_id')).toBe(CLIENT_ID);
    expect(sent.get('client_secret')).toBe(CLIENT_SECRET);
    expect(sent.get('code')).toBe(ONE_TIME_CODE);
    expect(sent.get('redirect_uri')).toBe(`${PUBLIC_URL}${GITHUB_CONNECT_CALLBACK_PATH}`);
    const verifier = sent.get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(location.searchParams.get('code_challenge'));
    expect(github.userAuth).toEqual([`Bearer ${ISSUED_TOKEN}`]);

    const [cred] = await userGitCredentials.listForUser(userId);
    expect(cred).toMatchObject({ host: 'github.com', provider: 'github', label: '@octo-user', source: 'oauth', accountLogin: 'octo-user' });
    expect(JSON.stringify(cred)).not.toContain(ISSUED_TOKEN);
    expect((await userGitCredentials.getDecryptedTokenForHost(userId, 'github.com'))?.token).toBe(ISSUED_TOKEN);
  });

  it('connecting replaces an existing github.com PAT (one credential per host); a later PAT save turns it back into a pat', async () => {
    await userGitCredentials.saveCredential(userId, 'github.com', 'github', 'ghp_oldPastedToken', 'old');
    const { location, stateCookie } = await start(userCookie);
    const res = await callback(`${userCookie}; folio_github_connect=${stateCookie!.value}`, { code: ONE_TIME_CODE, state: location.searchParams.get('state')! });
    expect(resultOf(res.headers.location)).toBe('ok');
    const creds = await userGitCredentials.listForUser(userId);
    expect(creds).toHaveLength(1);
    expect(creds[0].source).toBe('oauth');

    const pat = await userGitCredentials.saveCredential(userId, 'github.com', 'github', 'ghp_newPastedToken');
    expect(pat.source).toBe('pat');
    expect(pat.accountLogin).toBeUndefined();
  });

  it('state mismatch, a missing state cookie, or a callback in another user\'s session saves nothing (gitConnect=state)', async () => {
    const { location, stateCookie } = await start(userCookie);
    const state = location.searchParams.get('state')!;

    const wrongState = await callback(`${userCookie}; folio_github_connect=${stateCookie!.value}`, { code: ONE_TIME_CODE, state: 'not-the-state' });
    expect(resultOf(wrongState.headers.location)).toBe('state');

    const noCookie = await callback(userCookie, { code: ONE_TIME_CODE, state });
    expect(resultOf(noCookie.headers.location)).toBe('state');

    const forged = await callback(`${userCookie}; folio_github_connect=${Buffer.from(JSON.stringify({ state, codeVerifier: 'x', userId, returnTo: '/' })).toString('base64url')}`, {
      code: ONE_TIME_CODE,
      state,
    });
    expect(resultOf(forged.headers.location)).toBe('state');

    const otherSession = await callback(`${otherCookie}; folio_github_connect=${stateCookie!.value}`, { code: ONE_TIME_CODE, state });
    expect(resultOf(otherSession.headers.location)).toBe('state');

    expect(github.tokenRequests).toHaveLength(0);
    expect(await userGitCredentials.listForUser(userId)).toHaveLength(0);
  });

  it('the callback also requires the session: none -> gitConnect=session', async () => {
    const { location, stateCookie } = await start(userCookie);
    const res = await callback(`folio_github_connect=${stateCookie!.value}`, { code: ONE_TIME_CODE, state: location.searchParams.get('state')! });
    expect(resultOf(res.headers.location)).toBe('session');
    expect(github.tokenRequests).toHaveLength(0);
  });

  it('the user pressing Cancel on GitHub (error=access_denied) -> gitConnect=denied, nothing exchanged', async () => {
    const { location, stateCookie } = await start(userCookie);
    const res = await callback(`${userCookie}; folio_github_connect=${stateCookie!.value}`, {
      error: 'access_denied',
      error_description: 'The user has denied your application access.',
      state: location.searchParams.get('state')!,
    });
    expect(resultOf(res.headers.location)).toBe('denied');
    expect(github.tokenRequests).toHaveLength(0);
  });

  it.each([
    { name: 'a non-2xx token endpoint', token: { status: 500, body: {} }, expected: 'exchange' },
    { name: 'a 200 carrying an OAuth error (bad code)', token: { status: 200, body: { error: 'bad_verification_code' } }, expected: 'exchange' },
    { name: 'a token without the repo scope', token: { status: 200, body: { access_token: ISSUED_TOKEN, scope: 'read:user' } }, expected: 'scope' },
  ])('exchange failure — $name — saves nothing and goes back with gitConnect=$expected', async ({ token, expected }) => {
    github.tokenResponse = token;
    const { location, stateCookie } = await start(userCookie);
    const res = await callback(`${userCookie}; folio_github_connect=${stateCookie!.value}`, { code: ONE_TIME_CODE, state: location.searchParams.get('state')! });
    expect(resultOf(res.headers.location)).toBe(expected);
    expect(await userGitCredentials.listForUser(userId)).toHaveLength(0);
  });

  it('GET /user failing after a good exchange saves nothing (gitConnect=exchange)', async () => {
    github.userResponse = { status: 401, body: { message: 'Bad credentials' } };
    const { location, stateCookie } = await start(userCookie);
    const res = await callback(`${userCookie}; folio_github_connect=${stateCookie!.value}`, { code: ONE_TIME_CODE, state: location.searchParams.get('state')! });
    expect(resultOf(res.headers.location)).toBe('exchange');
    expect(await userGitCredentials.listForUser(userId)).toHaveLength(0);
  });
});

describe('redactRequestUrl', () => {
  it('hides the query string of OAuth callbacks only', () => {
    expect(redactRequestUrl('/api/auth/github-connect/callback?code=abc&state=def')).toBe('/api/auth/github-connect/callback?[redacted]');
    expect(redactRequestUrl('/api/auth/google/callback?code=abc')).toBe('/api/auth/google/callback?[redacted]');
    expect(redactRequestUrl('/api/auth/oidc/keycloak/callback?code=abc&state=s')).toBe('/api/auth/oidc/keycloak/callback?[redacted]');
    expect(redactRequestUrl('/api/pages?space=x')).toBe('/api/pages?space=x');
    expect(redactRequestUrl('/api/auth/github-connect/callback')).toBe('/api/auth/github-connect/callback');
  });
});

describe('safeReturnPath', () => {
  it('keeps a same-origin path and drops its query', () => {
    expect(safeReturnPath('/s/team/page?x=1#h')).toBe('/s/team/page');
    expect(safeReturnPath('/')).toBe('/');
  });

  it('refuses absolute, protocol-relative and junk values', () => {
    for (const bad of ['https://evil.example.com/', '//evil.example.com/x', '/\\evil.example.com', 'relative/path', '', undefined, 42, `/${'a'.repeat(600)}`]) {
      expect(safeReturnPath(bad)).toBe('/');
    }
  });
});
