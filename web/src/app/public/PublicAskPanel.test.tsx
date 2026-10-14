// @vitest-environment jsdom
/**
 * "Ask AI about this space" on a public site, end to end at the fetch boundary: a question starts a run
 * through the anonymous /api/public/** routes, the answer streams in from the NDJSON events (two deltas,
 * then the final message), and the conversation is remembered in localStorage so a reload can restore it.
 * <Markdown> has its own suites; here it is a stub that shows what it was given.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import type { PublicSiteInfo } from '@shared/contracts';

vi.mock('../../markdown', () => ({
  Markdown: ({ markdown, publicSite }: { markdown: string; publicSite?: { pageUrl: (id: string) => string } }) => (
    <div data-testid="answer" data-link={publicSite?.pageUrl('p2') ?? ''}>
      {markdown}
    </div>
  ),
}));

const { PublicAskPanel } = await import('./PublicAskPanel');

const SITE: PublicSiteInfo = {
  space: 'docs',
  name: 'Docs',
  allowDownload: false,
  allowAssistant: true,
  mode: 'path',
  homePageId: 'p1',
  instanceUrl: 'https://folio.example.com',
};

const STORAGE_KEY = 'folio:public-ask:docs';
const RUNS_URL = '/api/public/spaces/docs/assistant/runs';
const encoder = new TextEncoder();

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** An NDJSON events response the test feeds by hand, so it can look at the screen between two events. */
function liveStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
  return {
    response: () => new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }),
    send: (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)),
    close: () => controller.close(),
  };
}

function renderPanel(pageId?: string) {
  return render(
    <MemoryRouter>
      <PublicAskPanel site={SITE} pageId={pageId} />
    </MemoryRouter>,
  );
}

async function openPanel() {
  fireEvent.click(await screen.findByRole('button', { name: 'Ask AI about this space' }));
  return (await screen.findByRole('textbox')) as HTMLTextAreaElement;
}

function ask(input: HTMLTextAreaElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('<PublicAskPanel>', () => {
  it('streams the answer into the chat and remembers the conversation', async () => {
    const events = liveStream();
    const requests: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url === RUNS_URL) return json(202, { runId: 'run-1', conversationId: 'conv-1', guestToken: 'tok-1' });
        if (url === `${RUNS_URL}/run-1/events?since=0&guestToken=tok-1`) return events.response();
        return json(404, { error: 'not found' });
      }),
    );

    renderPanel('p1');
    const input = await openPanel();
    expect(screen.getByText('Answers come from the pages of Docs only.')).toBeTruthy();

    ask(input, 'How do I install it?');

    // The question is asked with the page the visitor is on, as a new conversation (no id, no token yet).
    await waitFor(() => expect(requests.some((r) => r.url === RUNS_URL)).toBe(true));
    const start = requests.find((r) => r.url === RUNS_URL)!;
    expect(start.init?.method).toBe('POST');
    expect(JSON.parse(String(start.init?.body))).toEqual({ message: 'How do I install it?', pageId: 'p1' });
    expect(screen.getByText('How do I install it?')).toBeTruthy();

    // Two deltas: the answer builds up in the streaming bubble, with a Stop button next to the step line.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy());
    events.send({ seq: 1, type: 'status', status: 'thinking' });
    events.send({ seq: 2, type: 'delta', text: 'Install ' });
    events.send({ seq: 3, type: 'delta', text: 'with npm.' });
    expect(await screen.findByText('Install with npm.')).toBeTruthy();

    // The final message replaces the stream and is drawn as Markdown that knows this site's page URLs.
    events.send({
      seq: 4,
      type: 'complete',
      conversationId: 'conv-1',
      message: { id: 'm2', role: 'assistant', content: 'Install with npm. See [Guide](/s/docs/p/p2).', createdAt: '2026-10-13T10:00:00Z' },
    });
    events.close();
    const answer = await screen.findByTestId('answer');
    expect(answer.textContent).toBe('Install with npm. See [Guide](/s/docs/p/p2).');
    expect(answer.getAttribute('data-link')).toBe('/public/docs/p/p2');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ conversationId: 'conv-1', guestToken: 'tok-1' });
  });

  it('restores the remembered conversation when opened, and forgets one the server no longer knows', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ conversationId: 'conv-1', guestToken: 'tok-1' }));
    const conversationUrl = `${RUNS_URL.replace('/runs', '')}/conversations/conv-1?guestToken=tok-1`;
    let known = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        if (String(input) !== conversationUrl) return json(404, { error: 'not found' });
        return known
          ? json(200, {
              messages: [
                { id: 'm1', role: 'user', content: 'What is Folio?', createdAt: '2026-10-13T10:00:00Z' },
                { id: 'm2', role: 'assistant', content: 'A wiki.', createdAt: '2026-10-13T10:00:01Z' },
              ],
              activeRunId: null,
            })
          : json(404, { error: 'assistant conversation not found' });
      }),
    );

    const first = renderPanel();
    await openPanel();
    expect(await screen.findByText('What is Folio?')).toBeTruthy();
    expect((await screen.findByTestId('answer')).textContent).toBe('A wiki.');
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    first.unmount();

    known = false;
    sessionStorage.clear();
    renderPanel();
    await openPanel();
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBeNull());
    expect(screen.queryByTestId('answer')).toBeNull();
  });

  it('says so when the visitor is rate limited, and gives the question back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(429, { error: 'too many questions, try again later' }, { 'Retry-After': '600' })),
    );

    renderPanel();
    const input = await openPanel();
    ask(input, 'Anything?');

    expect((await screen.findByRole('alert')).textContent).toContain('try again in 10 minutes');
    await waitFor(() => expect(input.value).toBe('Anything?'));
    expect(screen.queryByText('Anything?', { selector: 'div' })).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
