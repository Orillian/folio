// @vitest-environment jsdom
/**
 * A page created from a dialog lands inside a collapsed branch of the tree:
 * the tree must expand its ancestors and bring its row into view (the owner's
 * new base was "not visible in the tree"). Also: `.base` / `.canvas` pages are
 * ordinary rows with their icons.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { PageTree } from './PageTree';
import { ancestorIds, clearTreeReveal, requestTreeReveal } from './treeReveal';
import '../i18n/register';

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'T', email: 't@t.local', isAdmin: false, createdAt: '' }, memberships: {}, logout: () => {}, loggingOut: false }),
  useSpaceRole: () => 'editor' as const,
}));

const node = (over: Record<string, unknown>) => ({ space: 'sp', kind: 'doc', order: 0, status: 'published', updatedAt: '', children: [], ...over });
const baseNode = node({ id: 'nb', path: 'Cases/Новая база.base', kind: 'base', title: 'Новая база' });
const TREE = {
  tree: [
    node({
      id: 'root',
      path: 'index.md',
      title: 'Root',
      children: [
        node({ id: 'cases', path: 'Cases.md', title: 'Cases', children: [node({ id: 'deepdir', path: 'Cases/sub', kind: 'folder', title: 'Sub', children: [baseNode] })] }),
        node({ id: 'cv', path: 'map.canvas', kind: 'canvas', title: 'map' }),
        node({ id: 'bs', path: 'All.base', kind: 'base', title: 'All' }),
      ],
    }),
  ],
};

let scrollIntoView: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  await i18next.changeLanguage('en');
  window.localStorage.clear();
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as never;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/templates') ? { ok: false, status: 404, json: async () => ({ error: 'not found' }) } : { ok: true, status: 200, json: async () => TREE },
    ),
  );
});
afterEach(() => {
  cleanup();
  clearTreeReveal();
  vi.unstubAllGlobals();
});

function renderTree() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <PageTree space="sp" activeId="nb" activeFolderPath={undefined} canEdit />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ancestorIds', () => {
  it('walks from the outermost ancestor to the parent', () => {
    expect(ancestorIds(TREE.tree as never, 'nb')).toEqual(['root', 'cases', 'deepdir']);
    expect(ancestorIds(TREE.tree as never, 'root')).toEqual([]);
    expect(ancestorIds(TREE.tree as never, 'nope')).toBeNull();
  });
});

describe('the tree shows bases and canvases', () => {
  it('as rows with their own icons', async () => {
    renderTree();
    const baseRow = (await screen.findByText('All')).closest('[role="button"]')!;
    expect(baseRow.querySelector('svg.lucide-database')).toBeTruthy();
    const canvasRow = screen.getByText('map').closest('[role="button"]')!;
    expect(canvasRow.querySelector('svg.lucide-waypoints')).toBeTruthy();
  });
});

describe('reveal request', () => {
  it('expands every ancestor of the page and scrolls its row into view', async () => {
    renderTree();
    await screen.findByText('Cases');
    expect(screen.queryByText('Новая база')).toBeNull(); // collapsed: this is what the owner saw
    act(() => requestTreeReveal('sp', 'nb'));
    expect(await screen.findByText('Новая база')).toBeTruthy();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' }));
    expect(JSON.parse(window.localStorage.getItem('folio:expanded:sp')!)).toEqual(expect.arrayContaining(['cases', 'deepdir']));
    expect((scrollIntoView.mock.instances[0] as HTMLElement).getAttribute('data-tree-page-id')).toBe('nb');
  });

  it('waits for the tree to hold the page, and ignores another space', async () => {
    renderTree();
    await screen.findByText('Cases');
    act(() => requestTreeReveal('other', 'nb'));
    act(() => requestTreeReveal('sp', 'not-yet'));
    await new Promise((r) => setTimeout(r, 30));
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.queryByText('Новая база')).toBeNull();
  });
});
