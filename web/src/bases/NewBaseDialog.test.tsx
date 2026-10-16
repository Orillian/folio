// @vitest-environment jsdom
/**
 * "New base" dialog (owner, 16.10.2026): a name and an explicit location, one
 * request however often "Create" is pressed, a spinner meanwhile, and after
 * the create: tree refreshed, row revealed, base opened with Configure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import i18next from 'i18next';
import { parseBaseConfig } from '@shared/bases/parse';
import { ToastProvider } from '../app/ui/Toast';
import { clearTreeReveal, useTreeRevealRequest } from '../app/sidebar/treeReveal';
import NewBaseDialog, { starterBaseSource } from './NewBaseDialog';
import { collectBaseLocations } from './baseLocations';
import './i18n/register';

beforeEach(async () => {
  await i18next.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  clearTreeReveal();
  vi.unstubAllGlobals();
});

const node = (over: Record<string, unknown>) => ({ space: 'sp', kind: 'doc', order: 0, status: 'published', updatedAt: '', children: [], ...over });
const TREE = {
  tree: [
    node({
      id: 'root',
      path: 'index.md',
      title: 'Root',
      children: [
        node({ id: 'cases', path: 'Коммунікаційні кейси.md', title: 'Коммунікаційні кейси', children: [node({ id: 'c1', path: 'Коммунікаційні кейси/one.md', title: 'One' })] }),
        node({ id: 'dir:guides', path: 'guides', kind: 'folder', title: 'Guides', children: [node({ id: 'g1', path: 'guides/one.md', title: 'Guide one' })] }),
        node({ id: 'pdf1', path: 'file.pdf', kind: 'pdf', title: 'file.pdf' }),
      ],
    }),
  ],
};

interface Call {
  url: string;
  method: string;
  body: any;
}

function stubFetch(options: { createStatus?: number; createDelay?: Promise<void> } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'POST' && url === '/api/pages') {
        await options.createDelay;
        if (options.createStatus && options.createStatus >= 400) return { ok: false, status: options.createStatus, json: async () => ({ error: 'nope' }) };
        return { ok: true, status: 201, json: async () => ({ id: 'newbase', space: 'sp', path: 'x.base', kind: 'base', title: 'x' }) };
      }
      return { ok: true, status: 200, json: async () => TREE };
    }),
  );
  return calls;
}

function Probe() {
  const location = useLocation();
  const reveal = useTreeRevealRequest('sp');
  return (
    <div>
      <output data-testid="loc">{location.pathname}</output>
      <output data-testid="state">{JSON.stringify(location.state)}</output>
      <output data-testid="reveal">{reveal ? reveal.pageId : ''}</output>
    </div>
  );
}

function renderDialog(initialParentPath: string, extra: { onClose?: () => void; onCreated?: () => void } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const onClose = extra.onClose ?? vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/s/sp']}>
          <NewBaseDialog space="sp" initialParentPath={initialParentPath} onClose={onClose} onCreated={extra.onCreated} />
          <Probe />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { invalidate, onClose };
}

const nameInput = () => screen.getByLabelText('Name') as HTMLInputElement;
const createButton = () => screen.getByRole('button', { name: /^(Create base|Creating…)$/ }) as HTMLButtonElement;
const creates = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

describe('starterBaseSource', () => {
  it('is a table of name, folder, tags, updated — limited to the folder when given', () => {
    const scoped = parseBaseConfig(starterBaseSource('Коммунікаційні кейси', 'Table')).config!;
    expect(scoped.filters).toEqual({ and: ['file.inFolder("Коммунікаційні кейси")'] });
    expect(scoped.views[0]).toMatchObject({ type: 'table', name: 'Table', order: ['file.name', 'file.folder', 'file.tags', 'file.mtime'] });
    expect(parseBaseConfig(starterBaseSource('', 'Table')).config!.filters).toBeUndefined();
  });
});

describe('collectBaseLocations', () => {
  it('lists the root, folders and pages in tree order — not files that cannot hold anything', () => {
    const dirs = collectBaseLocations(TREE as never, 'Root!').map((l) => [l.dir, l.label, l.depth]);
    expect(dirs).toEqual([
      ['', 'Root!', 0],
      ['Коммунікаційні кейси', 'Коммунікаційні кейси', 1],
      ['Коммунікаційні кейси/one', 'One', 2],
      ['guides', 'Guides', 1],
      ['guides/one', 'Guide one', 2],
    ]);
  });
});

describe('NewBaseDialog', () => {
  it('opens with a default name and the explicit location, limited to it', async () => {
    stubFetch();
    renderDialog('Коммунікаційні кейси');
    expect(nameInput().value).toBe('New base');
    expect(await screen.findByText('Коммунікаційні кейси', { selector: '.font-medium' })).toBeTruthy();
    expect(screen.getByText(/Only pages in “Коммунікаційні кейси”/)).toBeTruthy();
    expect((screen.getByLabelText(/Only pages in/) as HTMLInputElement).checked).toBe(true);
  });

  it('at the space root there is nothing to limit', () => {
    stubFetch();
    renderDialog('');
    expect(screen.getByText('Space root', { selector: '.font-medium' })).toBeTruthy();
    expect(screen.getByText('The base lists all pages of the space.')).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('refuses an invalid or empty name', () => {
    stubFetch();
    renderDialog('');
    fireEvent.change(nameInput(), { target: { value: 'a/b' } });
    expect(createButton().disabled).toBe(true);
    expect(nameInput().getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(nameInput(), { target: { value: '   ' } });
    expect(createButton().disabled).toBe(true);
    fireEvent.change(nameInput(), { target: { value: 'Мої задачі 2026' } });
    expect(createButton().disabled).toBe(false);
  });

  it('sends ONE request on a double click, with a spinner and a disabled button meanwhile', async () => {
    let release!: () => void;
    const calls = stubFetch({ createDelay: new Promise<void>((r) => (release = r)) });
    renderDialog('guides');
    fireEvent.change(nameInput(), { target: { value: 'Мої задачі' } });
    const button = createButton();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.submit(document.getElementById('new-base-form')!);
    await waitFor(() => expect(createButton().textContent).toContain('Creating…'));
    expect(createButton().disabled).toBe(true);
    expect(createButton().querySelector('svg.animate-spin')).toBeTruthy();
    expect(nameInput().disabled).toBe(true);
    release();
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/s/sp/p/newbase'));
    expect(creates(calls)).toHaveLength(1);
    const body = creates(calls)[0].body;
    expect(body).toMatchObject({ space: 'sp', parentPath: 'guides', title: 'Мої задачі', kind: 'base' });
    expect(parseBaseConfig(body.base).config!.filters).toEqual({ and: ['file.inFolder("guides")'] });
  });

  it('can list the whole space instead, and a picked location changes the folder', async () => {
    const calls = stubFetch();
    renderDialog('guides');
    fireEvent.click(screen.getByLabelText('All pages of the space'));
    fireEvent.click(createButton());
    await waitFor(() => expect(creates(calls)).toHaveLength(1));
    expect(creates(calls)[0].body.parentPath).toBe('guides');
    expect(parseBaseConfig(creates(calls)[0].body.base).config!.filters).toBeUndefined();
  });

  it('picks another location from the list', async () => {
    const calls = stubFetch();
    renderDialog('');
    await screen.findByText('Space root', { selector: '.font-medium' });
    fireEvent.click(screen.getByRole('button', { name: /Change/ }));
    fireEvent.change(screen.getByLabelText('Find a folder or page'), { target: { value: 'guide' } });
    fireEvent.click(await screen.findByRole('option', { name: /^Guides/ }));
    expect(screen.getByText('guides', { selector: '.text-xs' })).toBeTruthy();
    fireEvent.click(createButton());
    await waitFor(() => expect(creates(calls)).toHaveLength(1));
    expect(creates(calls)[0].body.parentPath).toBe('guides');
    expect(parseBaseConfig(creates(calls)[0].body.base).config!.filters).toEqual({ and: ['file.inFolder("guides")'] });
  });

  it('after the create: refreshes the tree, asks to reveal the row, opens the base with Configure, tells where', async () => {
    stubFetch();
    const onCreated = vi.fn();
    const { invalidate, onClose } = renderDialog('guides', { onCreated });
    await screen.findByText('Guides', { selector: '.font-medium' }); // the tree is loaded: the toast names the folder by its title
    fireEvent.click(createButton());
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/s/sp/p/newbase'));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tree', 'sp'] });
    expect(screen.getByTestId('reveal').textContent).toBe('newbase');
    expect(JSON.parse(screen.getByTestId('state').textContent!)).toEqual({ folioConfigureBase: 'newbase' });
    expect(await screen.findByText('Base created in “Guides”')).toBeTruthy();
    expect(onCreated).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a failure inline and lets the user try again', async () => {
    const calls = stubFetch({ createStatus: 500 });
    const { onClose } = renderDialog('');
    fireEvent.click(createButton());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(createButton().disabled).toBe(false);
    fireEvent.click(createButton());
    await waitFor(() => expect(creates(calls)).toHaveLength(2));
  });
});
