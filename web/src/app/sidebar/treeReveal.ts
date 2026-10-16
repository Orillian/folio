/**
 * "Reveal this page in the sidebar tree": expand every ancestor of a page
 * and scroll its row into view. A page created from somewhere other than
 * the tree (a dialog, the quick switcher, the top «+») lands inside a
 * collapsed branch otherwise — the user sees a new page open and no trace of
 * it in the tree. The tree (PageTree) owns the expanded set and the scroll,
 * so callers only leave a request here and PageTree serves it once the
 * fresh tree holds the page.
 */
import { useSyncExternalStore } from 'react';
import type { TreeNode } from '@shared/contracts';

export interface TreeRevealRequest {
  space: string;
  pageId: string;
}

let pending: TreeRevealRequest | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Ask the tree of `space` to reveal the page (it must be in the tree by the time the tree refetches). */
export function requestTreeReveal(space: string, pageId: string): void {
  pending = { space, pageId };
  emit();
}

export function clearTreeReveal(): void {
  if (pending === null) return;
  pending = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The pending request for `space`, if any. */
export function useTreeRevealRequest(space: string): TreeRevealRequest | null {
  const current = useSyncExternalStore(subscribe, () => pending);
  return current && current.space === space ? current : null;
}

/** Ids of the ancestors of `pageId` (outermost first), or null when the page is not in the tree. */
export function ancestorIds(nodes: TreeNode[], pageId: string): string[] | null {
  for (const node of nodes) {
    if (node.id === pageId) return [];
    const inner = ancestorIds(node.children, pageId);
    if (inner) return [node.id, ...inner];
  }
  return null;
}
