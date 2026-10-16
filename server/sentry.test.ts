/** Optional error reporting: inert without SENTRY_DSN, scrubbed when on, 4xx ignored and 5xx captured. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Sentry from '@sentry/node';
import { HttpError } from './errors.js';
import { __resetSentryForTests, flushSentry, initSentry, sentryConfig, sentryEnabled, sentryWebConfig, setSentryUser, shouldCaptureStatus } from './sentry.js';

const DSN = 'https://abc123@o1.ingest.de.sentry.io/42';

interface Item {
  header: Record<string, unknown>;
  payload: Record<string, any>;
}

/** A transport that keeps the envelopes instead of sending them. */
function recorder() {
  const items: Item[] = [];
  const transport = () => ({
    send: async (envelope: unknown[]) => {
      const list = (envelope[1] as Array<[Record<string, unknown>, Record<string, any>]>) ?? [];
      for (const [header, payload] of list) items.push({ header, payload });
      return {};
    },
    flush: async () => true,
  });
  return { items, transport: transport as never };
}

afterEach(async () => {
  await __resetSentryForTests();
});

describe('sentryConfig', () => {
  it('is off without a DSN, with a blank one, or with one that is not a URL', () => {
    expect(sentryConfig({})).toBeUndefined();
    expect(sentryConfig({ SENTRY_DSN: '   ' })).toBeUndefined();
    expect(sentryConfig({ SENTRY_DSN: 'not a url' })).toBeUndefined();
    expect(sentryConfig({ SENTRY_DSN: 'ftp://x@y/1' })).toBeUndefined();
    expect(sentryWebConfig({})).toBeUndefined();
  });

  it('defaults the environment from NODE_ENV, the sample rate to 0.1, profiles off', () => {
    expect(sentryConfig({ SENTRY_DSN: DSN, NODE_ENV: 'production' })).toMatchObject({ environment: 'production', tracesSampleRate: 0.1, profiles: false });
    expect(sentryConfig({ SENTRY_DSN: DSN })).toMatchObject({ environment: 'development' });
    expect(sentryConfig({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: 'staging', SENTRY_TRACES_SAMPLE_RATE: '0.5', SENTRY_PROFILES: 'true' })).toMatchObject({
      environment: 'staging',
      tracesSampleRate: 0.5,
      profiles: true,
    });
  });

  it('clamps the sample rate and ignores nonsense', () => {
    expect(sentryConfig({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: '7' })?.tracesSampleRate).toBe(1);
    expect(sentryConfig({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: '-1' })?.tracesSampleRate).toBe(0);
    expect(sentryConfig({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: 'abc' })?.tracesSampleRate).toBe(0.1);
  });

  it('takes the release from SENTRY_RELEASE, else FOLIO_RELEASE, and hands the browser no server-only switch', () => {
    expect(sentryConfig({ SENTRY_DSN: DSN, FOLIO_RELEASE: '0f425d6' })?.release).toBe('0f425d6');
    expect(sentryConfig({ SENTRY_DSN: DSN, FOLIO_RELEASE: '0f425d6', SENTRY_RELEASE: 'v1' })?.release).toBe('v1');
    expect(sentryConfig({ SENTRY_DSN: DSN })?.release).toBeUndefined();
    expect(sentryWebConfig({ SENTRY_DSN: DSN, SENTRY_PROFILES: '1' })).not.toHaveProperty('profiles');
  });
});

describe('initSentry', () => {
  it('does nothing without a DSN: no client, nothing enabled', () => {
    expect(initSentry({})).toBe(false);
    expect(sentryEnabled()).toBe(false);
    expect(Sentry.getClient()).toBeUndefined();
    setSentryUser('u1'); // a no-op, not a crash
  });

  it('starts with the configured environment and release', () => {
    const { transport } = recorder();
    expect(initSentry({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: 'test', FOLIO_RELEASE: 'abc1234' }, { transport })).toBe(true);
    const opts = Sentry.getClient()?.getOptions();
    expect(opts?.environment).toBe('test');
    expect(opts?.release).toBe('abc1234');
    expect(opts?.tracesSampleRate).toBe(0.1);
  });
});

describe('what leaves the process', () => {
  let rec: ReturnType<typeof recorder>;
  beforeEach(() => {
    rec = recorder();
    initSentry({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: '0' }, { transport: rec.transport });
  });

  it('strips cookies, authorization, bodies, query strings and personal fields from an error event', async () => {
    Sentry.withScope((scope) => {
      scope.setUser({ id: 'u-1', email: 'a@b.c', username: 'alice', ip_address: '1.2.3.4' });
      scope.setSDKProcessingMetadata({
        normalizedRequest: {
          method: 'POST',
          url: 'https://wiki.example.com/share/SECRET-TOKEN/p/1?share=SECRET-TOKEN&q=my+search',
          query_string: 'q=my+search',
          cookies: { folio_session: 'cookie-secret' },
          headers: { authorization: 'Bearer pat-secret', cookie: 'folio_session=cookie-secret', 'user-agent': 'UA/1' },
          data: '{"title":"private page"}',
        },
      });
      scope.addBreadcrumb({ category: 'fetch', message: 'GET /api/x?token=SECRET-TOKEN', data: { url: 'https://h/api/share/TKN?x=1' } });
      scope.addBreadcrumb({ category: 'console', message: 'typed text' });
      Sentry.captureException(new Error('boom at /share/SECRET-TOKEN?x=1'));
    });
    await flushSentry(500);
    const ev = rec.items.find((i) => i.header.type === 'event')?.payload;
    expect(ev).toBeDefined();
    // the stack's source lines are this test file itself, so look at everything but the frames
    const json = JSON.stringify({ ...ev, exception: ev?.exception?.values?.map((v: { value: string }) => v.value) });
    for (const secret of ['SECRET-TOKEN', 'cookie-secret', 'pat-secret', 'private page', 'my+search', 'a@b.c', 'alice', '1.2.3.4']) expect(json).not.toContain(secret);
    expect(ev?.user).toEqual({ id: 'u-1' });
    expect(ev?.request?.headers?.authorization).toBeUndefined();
    expect(ev?.request?.cookies).toBeUndefined();
    expect(ev?.request?.data).toBeUndefined();
    expect((ev?.breadcrumbs ?? []).some((b: { category?: string }) => b.category === 'console')).toBe(false);
  });

  it('captures a 500 from a route and ignores 4xx (HttpError and fastify validation)', async () => {
    const { default: Fastify } = await import('fastify');
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      const status = err instanceof HttpError ? err.status : ((err as { statusCode?: number }).statusCode ?? 500);
      void reply.status(status).send({ error: 'x' });
    });
    app.get('/nf', async () => {
      throw new HttpError(404, 'page not found');
    });
    app.get('/forbidden', async () => {
      throw new HttpError(403, 'nope');
    });
    app.get('/boom', async () => {
      throw new Error('real failure');
    });
    app.get('/http500', async () => {
      throw new HttpError(500, 'db is down');
    });
    await app.ready();
    expect((await app.inject('/nf')).statusCode).toBe(404);
    expect((await app.inject('/forbidden')).statusCode).toBe(403);
    expect((await app.inject('/boom?token=abc')).statusCode).toBe(500);
    expect((await app.inject('/http500')).statusCode).toBe(500);
    await flushSentry(500);
    const messages = rec.items.filter((i) => i.header.type === 'event').map((i) => i.payload.exception?.values?.[0]?.value);
    expect(messages).toContain('real failure');
    expect(messages).toContain('db is down');
    expect(messages).not.toContain('page not found');
    expect(messages).not.toContain('nope');
    await app.close();
  });
});

describe('shouldCaptureStatus', () => {
  it('reports server faults only', () => {
    expect(shouldCaptureStatus(500)).toBe(true);
    expect(shouldCaptureStatus(503)).toBe(true);
    for (const s of [200, 301, 400, 401, 403, 404, 409, 410, 429]) expect(shouldCaptureStatus(s)).toBe(false);
  });
});
