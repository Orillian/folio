/**
 * Test-only helpers for the chat integration tests (slack.test.ts, teams.test.ts): a Fastify app
 * with the OAuth and chat routes, a recording stand-in for outbound HTTP, a Folio session, and
 * the browser's part of the Folio consent screen. Not imported by any production module.
 */
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { expect } from 'vitest';
import * as authStore from '../../auth/store.js';
import * as session from '../../auth/session.js';
import { HttpError } from '../../errors.js';
import { __resetOAuthRateLimitsForTests, registerOAuthRoutes } from '../../oauth/routes.js';
import { __resetConnectRateLimitForTests } from './connect.js';
import { __setChatFetchForTests } from './http.js';
import { registerChatIntegrationProtectedRoutes, registerChatIntegrationRoutes } from './routes.js';

const fastifyCookie = fastifyCookieModule.default;

export const BASE = 'https://folio.example.com';

export async function buildChatTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: String(err) });
  });
  await app.register(fastifyCookie);
  await registerOAuthRoutes(app, {
    serveSpa: (_request, reply) => {
      reply.status(401).send('login');
    },
  });
  await registerChatIntegrationRoutes(app);
  await app.register(async (scope) => {
    scope.addHook('onRequest', session.requireSession);
    registerChatIntegrationProtectedRoutes(scope);
  });
  await app.ready();
  __resetOAuthRateLimitsForTests();
  __resetConnectRateLimitForTests();
  return app;
}

export async function sessionCookie(userId: string): Promise<string> {
  const { token } = await authStore.createSession(userId);
  return `${session.SESSION_COOKIE_NAME}=${token}`;
}

export interface RecordedCall {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/** Replaces outbound fetch: `routes` answers by URL prefix; every call is recorded. */
export function stubChatFetch(routes: Record<string, (call: RecordedCall) => unknown>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  __setChatFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    let body: unknown = rawBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      if (rawBody.includes('=')) body = Object.fromEntries(new URLSearchParams(rawBody));
    }
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { url, body, headers };
    calls.push(call);
    const prefix = Object.keys(routes).find((p) => url.startsWith(p));
    if (!prefix) return new Response(JSON.stringify({ error: 'no stub' }), { status: 404 });
    return new Response(JSON.stringify(routes[prefix](call)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  return calls;
}

export function resetChatFetch(): void {
  __setChatFetchForTests(null);
}

/** `name=value` of a Set-Cookie the response carries. */
export function cookieFrom(res: LightMyRequestResponse, name: string): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const hit = list.find((c) => c.startsWith(`${name}=`));
  expect(hit, `Set-Cookie ${name}`).toBeTruthy();
  return hit!.split(';')[0];
}

export function pathOf(absolute: string): string {
  const u = new URL(absolute);
  return `${u.pathname}${u.search}`;
}

/** Plays the person on Folio's consent screen: opens `authorizeUrl` signed in, clicks Allow; returns where Folio redirects. */
export async function approveFolioConsent(app: FastifyInstance, authorizeUrl: string, cookie: string): Promise<string> {
  const page = await app.inject({ method: 'GET', url: pathOf(authorizeUrl), headers: { cookie } });
  expect(page.statusCode).toBe(200);
  const requestId = /name="request_id" value="([^"]+)"/.exec(page.body)?.[1];
  expect(requestId).toBeTruthy();
  const decided = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ request_id: requestId!, decision: 'allow' }).toString(),
  });
  expect(decided.statusCode).toBe(302);
  return String(decided.headers.location);
}
