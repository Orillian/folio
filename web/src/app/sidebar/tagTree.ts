import type { SpaceTag } from '@shared/contracts';

export interface TagNode {
  /** The last segment of the tag: `alpha` for `project/alpha`. */
  name: string;
  /** The whole normalized tag (`project/alpha`) — what a search or a rename is given. */
  tag: string;
  /** Pages carrying exactly this tag; null for a parent that exists only because a child does (`project` when only `project/alpha` is used). */
  pages: number | null;
  children: TagNode[];
}

/**
 * The flat `GET /tags` list as the tree its `/` hierarchy describes. A parent nobody tagged
 * directly still gets a node (so `project/alpha` has somewhere to hang) but no count — the
 * server counts distinct pages per tag, and summing children would count a page twice.
 * Siblings are sorted by name.
 */
export function buildTagTree(tags: readonly SpaceTag[]): TagNode[] {
  const roots: TagNode[] = [];
  const byTag = new Map<string, TagNode>();

  function ensure(tag: string, name: string, parent: TagNode | undefined): TagNode {
    const existing = byTag.get(tag);
    if (existing) return existing;
    const node: TagNode = { name, tag, pages: null, children: [] };
    byTag.set(tag, node);
    (parent ? parent.children : roots).push(node);
    return node;
  }

  for (const { tag, pages } of tags) {
    const segments = tag.split('/').filter(Boolean);
    let parent: TagNode | undefined;
    let path = '';
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment;
      parent = ensure(path, segment, parent);
    }
    if (parent) parent.pages = pages;
  }

  const sort = (nodes: TagNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}
