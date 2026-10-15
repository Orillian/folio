// @vitest-environment jsdom
/**
 * The sidebar's Tags section (Obsidian wave 3): the `/` hierarchy as a tree with counts,
 * a click that hands the tag to the quick switcher, and "Rename tag…" posting the right body.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { ToastProvider } from '../ui/Toast';
import { TagsSection } from './TagsSection';
import { buildTagTree } from './tagTree';
import '../i18n/register';

const TAGS = [
  { tag: 'project/alpha', pages: 2 },
  { tag: 'project', pages: 3 },
  { tag: 'ideas/later', pages: 1 }, // `ideas` itself is nobody's tag
  { tag: 'zeta', pages: 5 },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubNetwork() {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/spaces/demo/tags' && (init?.method ?? 'GET') === 'GET') return json({ tags: TAGS });
      if (url === '/api/spaces/demo/tags/rename' && init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return json({ pagesChanged: 4, pagesSkipped: 1 });
      }
      return json({ error: 'not found' }, 404);
    }),
  );
  return posts;
}

function renderSection(onOpenTag = vi.fn(), canEdit = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <TagsSection space="demo" canEdit={canEdit} onOpenTag={onOpenTag} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return onOpenTag;
}

beforeAll(async () => {
  await i18next.changeLanguage('en');
});
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('buildTagTree', () => {
  it('nests by "/", gives a parent nobody tagged no count, and sorts siblings', () => {
    const tree = buildTagTree(TAGS);
    expect(tree.map((n) => n.name)).toEqual(['ideas', 'project', 'zeta']);
    expect(tree[0]).toMatchObject({ tag: 'ideas', pages: null });
    expect(tree[0].children[0]).toMatchObject({ tag: 'ideas/later', pages: 1 });
    expect(tree[1]).toMatchObject({ tag: 'project', pages: 3 });
    expect(tree[1].children[0]).toMatchObject({ tag: 'project/alpha', name: 'alpha', pages: 2 });
  });
});

describe('TagsSection', () => {
  it('lists tags as a collapsed tree with counts and opens a tag in the switcher on click', async () => {
    stubNetwork();
    const onOpenTag = renderSection();

    const header = await screen.findByRole('button', { name: /Tags/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('zeta')).toBeNull();

    await userEvent.click(header);
    expect(screen.getByText('zeta')).toBeTruthy();
    expect(within(screen.getByText('zeta').closest('button') as HTMLElement).getByText('5')).toBeTruthy();
    expect(screen.queryByText('alpha')).toBeNull(); // a child waits for its parent to be expanded

    await userEvent.click(screen.getByRole('button', { name: 'Expand #project' }));
    await userEvent.click(screen.getByText('alpha'));
    expect(onOpenTag).toHaveBeenCalledWith('project/alpha');
  });

  it('renames a tag from the row menu: the dialog posts {from, to} and the toast reports changed and skipped pages', async () => {
    const posts = stubNetwork();
    renderSection();

    await userEvent.click(await screen.findByRole('button', { name: /Tags/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Actions for #zeta' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename tag…' }));

    const input = await screen.findByRole('textbox');
    expect((input as HTMLInputElement).value).toBe('zeta');
    const confirm = screen.getByRole('button', { name: 'Rename' });
    expect(confirm.hasAttribute('disabled')).toBe(true); // unchanged

    await userEvent.clear(input);
    await userEvent.type(input, '#Omega');
    await userEvent.click(confirm);

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toEqual({ from: 'zeta', to: 'omega' });
    expect(await screen.findByText('Tag renamed. Pages changed: 4, skipped (no edit access): 1.')).toBeTruthy();
  });

  it('offers no rename to a viewer', async () => {
    stubNetwork();
    renderSection(vi.fn(), false);
    await userEvent.click(await screen.findByRole('button', { name: /Tags/ }));
    expect(screen.queryByRole('button', { name: 'Actions for #zeta' })).toBeNull();
  });
});
