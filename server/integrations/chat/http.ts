/**
 * Outbound HTTP of the chat integrations (Slack Web API, Slack OpenID Connect, Bot Framework
 * OpenID metadata). One swappable `fetch`, so tests answer for slack.com and
 * login.botframework.com without a network.
 */
let impl: typeof fetch = (...args) => fetch(...args);

export function chatFetch(input: string, init?: RequestInit): Promise<Response> {
  return impl(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) });
}

export function __setChatFetchForTests(fn: typeof fetch | null): void {
  impl = fn ?? ((...args) => fetch(...args));
}
