// @vitest-environment jsdom
/**
 * subscribeAssistantRun reads a run's NDJSON events from a configurable source: the signed-in route by
 * default, and an `anonymous` one for the public site's Ask panel (no session to lose, so a refusal is final
 * and never signs anyone out).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, UNAUTHORIZED_EVENT } from '../api';
import { subscribeAssistantRun } from './stream';

afterEach(() => {
  vi.unstubAllGlobals();
});

function ndjson(...events: unknown[]): Response {
  return new Response(events.map((e) => `${JSON.stringify(e)}\n`).join(''), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

function refusal(status: number): Response {
  return new Response(JSON.stringify({ error: 'nope' }), { status, headers: { 'content-type': 'application/json' } });
}

describe('subscribeAssistantRun', () => {
  it('reads the signed-in route by default and resolves with the terminal event', async () => {
    const fetchMock = vi.fn(async (_url: string) => ndjson({ seq: 1, type: 'delta', text: 'Hi' }, { seq: 2, type: 'stopped', conversationId: 'c1' }));
    vi.stubGlobal('fetch', fetchMock);
    const seen: unknown[] = [];

    const terminal = await subscribeAssistantRun({ runId: 'r 1', since: 0, signal: new AbortController().signal, onEvent: (e) => seen.push(e) });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/assistant/runs/r%201/events?since=0');
    expect(seen).toEqual([{ seq: 1, type: 'delta', text: 'Hi' }, { seq: 2, type: 'stopped', conversationId: 'c1' }]);
    expect(terminal.type).toBe('stopped');
  });

  it('reads the URL an injected source builds, from the given resume point', async () => {
    const fetchMock = vi.fn(async (_url: string) => ndjson({ seq: 6, type: 'stopped', conversationId: 'c1' }));
    vi.stubGlobal('fetch', fetchMock);

    await subscribeAssistantRun({
      runId: 'r1',
      since: 5,
      source: { url: (runId, since) => `/api/public/spaces/docs/assistant/runs/${runId}/events?since=${since}&guestToken=t`, anonymous: true },
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/public/spaces/docs/assistant/runs/r1/events?since=5&guestToken=t');
  });

  it('signs the user out on a 401 from the signed-in route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refusal(401)));
    const unauthorized = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);

    await expect(
      subscribeAssistantRun({ runId: 'r1', since: 0, signal: new AbortController().signal, onEvent: () => undefined }),
    ).rejects.toMatchObject({ status: 401 });

    window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized);
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it.each([401, 404])('rejects an anonymous source at once on a %i, without UNAUTHORIZED_EVENT or a reconnect', async (status) => {
    const fetchMock = vi.fn(async (_url: string) => refusal(status));
    vi.stubGlobal('fetch', fetchMock);
    const unauthorized = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);

    const result = subscribeAssistantRun({
      runId: 'r1',
      since: 0,
      source: { url: () => '/events', anonymous: true },
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    await expect(result).rejects.toBeInstanceOf(ApiError);

    window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized);
    expect(unauthorized).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
