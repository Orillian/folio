// @vitest-environment jsdom
/**
 * The properties panel (Obsidian wave 3): collapsed by default, typed editors per
 * property type, whole-map optimistic saves, "foreign value" read-only rows, and the
 * 409 reload prompt. The network is a fetch stub keyed by method + URL.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { PagePropertiesResponse } from '@shared/contracts';
import { ToastProvider } from '../ui/Toast';
import { PropertiesPanel } from './PropertiesPanel';
import '../i18n/register';

const BASE: PagePropertiesResponse = {
  properties: { id: '01ABC', title: 'Roadmap', year: 2026, done: false, due: '2026-10-14', tags: ['plan'], meta: { a: 1 } },
  types: { id: 'text', title: 'text', year: 'number', done: 'checkbox', due: 'date', tags: 'tags', meta: 'text' },
  foreign: [],
  readOnly: ['id'],
  canEdit: true,
  etag: 'etag-1',
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A page whose GET returns `state`; a PUT is answered by `onPut` (default: the state with the sent map and etag-2). */
function stubNetwork(state: PagePropertiesResponse, onPut?: (body: { properties: Record<string, unknown>; etag?: string }) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url === '/api/pages/p1/properties' && method === 'GET') return json(state);
      if (url === '/api/pages/p1/properties' && method === 'PUT') {
        return onPut ? onPut(body) : json({ ...state, properties: { id: '01ABC', ...body.properties }, etag: 'etag-2' });
      }
      if (url === '/api/spaces/demo/property-types') {
        return json({ types: { status: 'text' }, source: 'folio', known: [{ key: 'author', inferred: 'text', pages: 4 }] });
      }
      return json({ error: 'not found' }, 404);
    }),
  );
  return calls;
}

function renderPanel(props: { canEdit?: boolean; canManageTypes?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <PropertiesPanel pageId="p1" space="demo" canEdit={props.canEdit ?? true} canManageTypes={props.canManageTypes ?? false} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openPanel() {
  const toggle = await screen.findByRole('button', { name: /^Properties \(\d+\)$/ });
  await userEvent.click(toggle);
  return toggle;
}

describe('PropertiesPanel', () => {
  it('is collapsed by default, counts the editable properties, opens on click and remembers it per space', async () => {
    stubNetwork(BASE);
    renderPanel();

    const toggle = await screen.findByRole('button', { name: 'Properties (6)' }); // `id` is not counted
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('textbox', { name: 'title' })).toBeNull();

    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('textbox', { name: 'title' })).toBeTruthy();
    expect(localStorage.getItem('folio:properties-open:demo')).toBe('true');
  });

  it('renders an editor per type and sends the WHOLE editable map in one PUT, with the etag', async () => {
    const calls = stubNetwork(BASE);
    renderPanel();
    await openPanel();

    expect((screen.getByRole('textbox', { name: 'title' }) as HTMLInputElement).value).toBe('Roadmap');
    expect((screen.getByRole('spinbutton', { name: 'year' }) as HTMLInputElement).value).toBe('2026');
    expect((screen.getByRole('checkbox', { name: 'done' }) as HTMLInputElement).checked).toBe(false);
    const due = within(screen.getByRole('group', { name: 'due' })).getByLabelText('due') as HTMLInputElement;
    expect(due.type).toBe('date');
    expect(due.value).toBe('2026-10-14');
    expect(screen.getByRole('button', { name: 'Remove plan' })).toBeTruthy(); // tags are chips
    expect(screen.getByText(/"a": 1/)).toBeTruthy(); // a nested map is read-only JSON
    // `id` is shown, locked: no editor, no remove button
    const idRow = screen.getByRole('group', { name: 'id' });
    expect(within(idRow).queryByRole('textbox')).toBeNull();
    expect(within(idRow).queryByRole('button')).toBeNull();

    await userEvent.type(screen.getByRole('textbox', { name: 'title' }), ' v2{Enter}');
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      properties: { title: 'Roadmap v2', year: 2026, done: false, due: '2026-10-14', tags: ['plan'], meta: { a: 1 } },
      etag: 'etag-1',
    });

    // The answer's etag rides on the next save, and it keeps the first edit.
    await userEvent.click(screen.getByRole('checkbox', { name: 'done' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
    const second = calls.filter((c) => c.method === 'PUT')[1].body as { properties: Record<string, unknown>; etag: string };
    expect(second.etag).toBe('etag-2');
    expect(second.properties).toMatchObject({ title: 'Roadmap v2', done: true });
  });

  it('Esc puts the old value back and sends nothing; tag chips are normalized when added', async () => {
    const calls = stubNetwork(BASE);
    renderPanel();
    await openPanel();

    const title = screen.getByRole('textbox', { name: 'title' }) as HTMLInputElement;
    await userEvent.type(title, 'zzz{Escape}');
    expect(title.value).toBe('Roadmap');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    await userEvent.type(screen.getByRole('textbox', { name: 'tags' }), '#Plan/Q4{Enter}');
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect((calls.find((c) => c.method === 'PUT')?.body as { properties: { tags: string[] } }).properties.tags).toEqual(['plan', 'plan/q4']);
  });

  it('shows a Folio key with a foreign value read-only, with a badge, and still sends it back unchanged', async () => {
    const calls = stubNetwork({
      ...BASE,
      properties: { id: '01ABC', status: 'deprecated', title: 'Roadmap' },
      types: { id: 'text', status: 'text', title: 'text' },
      foreign: ['status'],
    });
    renderPanel();
    await openPanel();

    const row = screen.getByRole('group', { name: 'status' });
    expect(within(row).getByText('deprecated')).toBeTruthy();
    const badge = within(row).getByText('foreign value');
    expect(badge.getAttribute('title')).toBe('Written by another tool; Folio keeps it as is');
    expect(within(row).queryByRole('textbox')).toBeNull();
    expect(within(row).queryByRole('combobox')).toBeNull();
    expect(within(row).queryByRole('button')).toBeNull();

    await userEvent.type(screen.getByRole('textbox', { name: 'title' }), '!{Enter}');
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect((calls.find((c) => c.method === 'PUT')?.body as { properties: Record<string, unknown> }).properties).toEqual({
      status: 'deprecated',
      title: 'Roadmap!',
    });
  });

  it('is read-only for a viewer: no editors, no add button', async () => {
    stubNetwork({ ...BASE, canEdit: false });
    renderPanel({ canEdit: false });
    await openPanel();

    expect(screen.getByText('Roadmap')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add property' })).toBeNull();
  });

  it('on a 409 stops editing, shows the reload prompt, and Reload reads the front matter again', async () => {
    const calls = stubNetwork(BASE, () => json({ error: 'front matter changed' }, 409));
    renderPanel();
    await openPanel();

    await userEvent.type(screen.getByRole('textbox', { name: 'title' }), '!{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('changed elsewhere');
    // Editing stops until the reload: the rows turn read-only.
    expect(screen.queryByRole('textbox', { name: 'title' })).toBeNull();

    const getsBefore = calls.filter((c) => c.method === 'GET').length;
    await userEvent.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(getsBefore));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect((screen.getByRole('textbox', { name: 'title' }) as HTMLInputElement).value).toBe('Roadmap');
  });
});
