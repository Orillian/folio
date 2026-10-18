// @vitest-environment jsdom
/**
 * Live properties (16.10.2026), the client half: a `page-properties` frame from the
 * `/events` socket refetches the page's properties (and its base views) — unless this tab
 * already holds that etag, the page is not open here, or a save of it is in flight — and
 * the panel shows another user's change without a reload, never over a field its own user
 * is typing into. Also: `status` in a light-footprint space (folioKeys without `status`) is
 * an ordinary, editable text property.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { PagePropertiesResponse } from '@shared/contracts';
import { ToastProvider } from '../ui/Toast';
import { PropertiesPanel } from './PropertiesPanel';
import { applyPagePropertiesFrame, BASE_REFRESH_DELAY_MS, markSaving, resetPropertiesLive } from './propertiesLive';
import '../i18n/register';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function payload(properties: Record<string, unknown>, etag: string, extra: Partial<PagePropertiesResponse> = {}): PagePropertiesResponse {
  return { properties: { id: '01ABC', ...properties }, types: {}, foreign: [], readOnly: ['id'], canEdit: true, etag, ...extra };
}

/** The server: `state.current` is what GET answers; a PUT stores the sent map under a new etag. */
function stubServer(initial: PagePropertiesResponse) {
  const state = { current: initial, n: 1 };
  const calls: { method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url === '/api/pages/p1/properties') {
        calls.push({ method, body });
        if (method === 'PUT') {
          state.n += 1;
          state.current = { ...state.current, properties: { id: '01ABC', ...body.properties }, etag: `etag-${state.n}` };
        }
        return json(state.current);
      }
      if (url.startsWith('/api/spaces/demo/property-types')) return json({ types: {}, source: 'folio', known: [] });
      return json({ error: 'not found' }, 404);
    }),
  );
  /** Another user's write: the server state moves, and the frame the server would send. */
  const remoteWrite = (properties: Record<string, unknown>) => {
    state.n += 1;
    state.current = { ...state.current, properties: { id: '01ABC', ...properties }, etag: `etag-${state.n}` };
    return { type: 'page-properties' as const, space: 'demo', pageId: 'p1', etag: state.current.etag };
  };
  return { state, calls, remoteWrite };
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <PropertiesPanel pageId="p1" space="demo" canEdit canManageTypes={false} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return client;
}

async function openPanel() {
  await userEvent.click(await screen.findByRole('button', { name: /^(Properties \(\d+\)|Add property)$/ }));
}

const gets = (calls: { method: string }[]) => calls.filter((c) => c.method === 'GET').length;

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

beforeEach(() => {
  localStorage.clear();
  resetPropertiesLive();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('applyPagePropertiesFrame', () => {
  it('refetches a cached page whose etag moved; skips the same etag, a page not open here and a malformed frame', () => {
    const client = new QueryClient();
    client.setQueryData(['page-properties', 'p1'], payload({}, 'e1'));
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    applyPagePropertiesFrame(client, { type: 'page-properties', space: 'demo', pageId: 'p1', etag: 'e1' });
    applyPagePropertiesFrame(client, { type: 'page-properties', space: 'demo', pageId: 'not-open', etag: 'x' });
    applyPagePropertiesFrame(client, { type: 'page-properties', space: '' } as never);
    expect(invalidate.mock.calls.filter(([f]) => JSON.stringify((f as { queryKey?: unknown }).queryKey ?? null).includes('p'))).toEqual([]);

    applyPagePropertiesFrame(client, { type: 'page-properties', space: 'demo', pageId: 'p1', etag: 'e2' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['page-properties', 'p1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['page', 'p1'] });
  });

  it('waits for a save of that page in flight, then refetches once it ends', () => {
    const client = new QueryClient();
    client.setQueryData(['page-properties', 'p1'], payload({}, 'e1'));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    markSaving('p1', true);
    applyPagePropertiesFrame(client, { type: 'page-properties', space: 'demo', pageId: 'p1', etag: 'e9' });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['page-properties', 'p1'] });
    markSaving('p1', false);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['page-properties', 'p1'] });
  });

  it('a space-wide frame re-reads every open properties panel; base views of THAT space refresh once, after a short delay', () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    client.setQueryData(['page-properties', 'p1'], payload({}, 'e1'));
    client.setQueryData(['page-properties', 'p2'], payload({}, 'e1'));
    client.setQueryData(['base', 'b1', null, 50, 'demo'], { rows: [] });
    client.setQueryData(['base', 'b2', null, 50, 'other'], { rows: [] });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    applyPagePropertiesFrame(client, { type: 'page-properties', space: 'demo' });
    applyPagePropertiesFrame(client, { type: 'page-properties', space: 'demo', pageId: 'p1', etag: 'e1' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['page-properties', 'p1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['page-properties', 'p2'] });

    vi.advanceTimersByTime(BASE_REFRESH_DELAY_MS + 1);
    const basePredicates = invalidate.mock.calls.map(([f]) => (f as { predicate?: (q: { queryKey: unknown[] }) => boolean }).predicate).filter(Boolean);
    expect(basePredicates).toHaveLength(1);
    expect(basePredicates[0]!({ queryKey: ['base', 'b1', null, 50, 'demo'] })).toBe(true);
    expect(basePredicates[0]!({ queryKey: ['base', 'b2', null, 50, 'other'] })).toBe(false);
  });
});

describe('the panel, live', () => {
  it("another user's change shows up without a reload; this tab's own save does not refetch", async () => {
    const server = stubServer(payload({ owner: 'dana' }, 'etag-1'));
    const client = renderPanel();
    await openPanel();
    expect((screen.getByRole('textbox', { name: 'owner' }) as HTMLInputElement).value).toBe('dana');

    const frame = server.remoteWrite({ owner: 'dana', priority: 'high' });
    act(() => applyPagePropertiesFrame(client, frame));
    expect(((await screen.findByRole('textbox', { name: 'priority' })) as HTMLInputElement).value).toBe('high');

    // Our own save: the frame that follows carries the etag this tab already holds.
    const owner = screen.getByRole('textbox', { name: 'owner' });
    await userEvent.clear(owner);
    await userEvent.type(owner, 'marcus{Enter}');
    await waitFor(() => expect(server.calls.some((c) => c.method === 'PUT')).toBe(true));
    await waitFor(() => expect(client.getQueryData<PagePropertiesResponse>(['page-properties', 'p1'])?.etag).toBe(server.state.current.etag));
    const before = gets(server.calls);
    act(() => applyPagePropertiesFrame(client, { type: 'page-properties', space: 'demo', pageId: 'p1', etag: server.state.current.etag }));
    await new Promise((r) => setTimeout(r, 30));
    expect(gets(server.calls)).toBe(before);
  });

  it('never overwrites a field being typed into: the hint says what changed, Enter keeps ours, other keys merge', async () => {
    const server = stubServer(payload({ owner: 'dana', stage: 'one' }, 'etag-1'));
    const client = renderPanel();
    await openPanel();

    const owner = screen.getByRole('textbox', { name: 'owner' }) as HTMLInputElement;
    await userEvent.clear(owner);
    await userEvent.type(owner, 'marcus');

    // Meanwhile Dana changes the same key AND another one.
    act(() => applyPagePropertiesFrame(client, server.remoteWrite({ owner: 'dana-2', stage: 'two' })));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'stage' }) as HTMLInputElement).value).toBe('two'));
    expect(owner.value).toBe('marcus');
    expect(within(screen.getByRole('group', { name: 'owner' })).getByRole('status').textContent).toMatch(/Someone else changed this to “dana-2”/);

    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(server.calls.some((c) => c.method === 'PUT')).toBe(true));
    const sent = server.calls.find((c) => c.method === 'PUT')!.body as { properties: Record<string, unknown>; etag: string };
    expect(sent.properties).toMatchObject({ owner: 'marcus', stage: 'two' });
    expect(sent.etag).toBe('etag-2'); // the fresh one: no 409 for a change already merged
    expect(screen.queryByText(/Someone else changed/)).toBeNull();
  });

  it('Esc on a field changed meanwhile takes the other value', async () => {
    const server = stubServer(payload({ owner: 'dana' }, 'etag-1'));
    const client = renderPanel();
    await openPanel();
    const owner = screen.getByRole('textbox', { name: 'owner' }) as HTMLInputElement;
    await userEvent.clear(owner);
    await userEvent.type(owner, 'mine');
    act(() => applyPagePropertiesFrame(client, server.remoteWrite({ owner: 'theirs' })));
    await screen.findByText(/Someone else changed this to “theirs”/);
    await userEvent.keyboard('{Escape}');
    expect(owner.value).toBe('theirs');
    expect(server.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('a field with focus but no edit simply shows the new value', async () => {
    const server = stubServer(payload({ owner: 'dana' }, 'etag-1'));
    const client = renderPanel();
    await openPanel();
    const owner = screen.getByRole('textbox', { name: 'owner' }) as HTMLInputElement;
    await userEvent.click(owner);
    act(() => applyPagePropertiesFrame(client, server.remoteWrite({ owner: 'dana-2' })));
    await waitFor(() => expect(owner.value).toBe('dana-2'));
    expect(screen.queryByText(/Someone else changed/)).toBeNull();
  });

  it('a property removed by someone else while it is being edited stays, says so, and Enter puts it back', async () => {
    const server = stubServer(payload({ owner: 'dana', stage: 'one' }, 'etag-1'));
    const client = renderPanel();
    await openPanel();
    const stage = screen.getByRole('textbox', { name: 'stage' }) as HTMLInputElement;
    await userEvent.clear(stage);
    await userEvent.type(stage, 'three');
    act(() => applyPagePropertiesFrame(client, server.remoteWrite({ owner: 'dana' })));
    await screen.findByText(/Someone else removed this property/);
    expect(stage.value).toBe('three');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(server.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect((server.calls.find((c) => c.method === 'PUT')!.body as { properties: Record<string, unknown> }).properties).toMatchObject({ owner: 'dana', stage: 'three' });
  });
});

describe('status in a light-footprint space', () => {
  it('is an ordinary text property: `doing` is editable, not foreign, no draft/published/archived picker', async () => {
    const server = stubServer(payload({ status: 'doing' }, 'etag-1', { types: { status: 'text' }, folioKeys: ['id', 'order', 'icon', 'cover'] }));
    renderPanel();
    await openPanel();
    const status = screen.getByRole('textbox', { name: 'status' }) as HTMLInputElement;
    expect(status.value).toBe('doing');
    expect(screen.queryByRole('combobox', { name: 'status' })).toBeNull();
    await userEvent.clear(status);
    await userEvent.type(status, 'done{Enter}');
    await waitFor(() => expect(server.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect((server.calls.find((c) => c.method === 'PUT')!.body as { properties: Record<string, unknown> }).properties.status).toBe('done');
  });

  it('even `draft` there is plain text', async () => {
    stubServer(payload({ status: 'draft' }, 'etag-1', { folioKeys: ['id', 'order', 'icon', 'cover'] }));
    renderPanel();
    await openPanel();
    expect((screen.getByRole('textbox', { name: 'status' }) as HTMLInputElement).value).toBe('draft');
  });

  it('in a native space (status among folioKeys) the draft/published/archived picker stays', async () => {
    stubServer(payload({ status: 'draft' }, 'etag-1', { folioKeys: ['id', 'order', 'status', 'icon', 'cover'] }));
    renderPanel();
    await openPanel();
    expect(screen.getByRole('combobox', { name: 'status' })).toBeTruthy();
  });
});
