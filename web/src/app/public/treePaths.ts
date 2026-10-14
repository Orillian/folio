import type { TreeNode } from '@shared/contracts';

/** The chain of nodes from a top-level node down to the one with `id` (inclusive); null when there is none. */
export function pathToNode(nodes: readonly TreeNode[], id: string): TreeNode[] | null {
  for (const node of nodes) {
    if (node.id === id) return [node];
    const below = pathToNode(node.children, id);
    if (below) return [node, ...below];
  }
  return null;
}

/** Ids of every node that has children — what "expand everything" opens. */
export function expandableIds(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) => (node.children.length > 0 ? [node.id, ...expandableIds(node.children)] : []));
}
