/**
 * Where a new base can be created: the space root, every folder and every
 * page (a page's children live in the directory next to it, exactly as the
 * tree's own "+ New …" creates them). The list mirrors the tree order, with
 * the depth for indentation.
 */
import type { TreeNode } from '@shared/contracts';
import type { TreeResponse } from '../app/api';
import { childDirOf, excludeAgentFolder, excludeTemplatesFolder, getTopLevelNodes } from '../app/sidebar/treeUtils';

export interface BaseLocation {
  /** Directory the `.base` file goes to ("" = the space root). */
  dir: string;
  label: string;
  depth: number;
}

export function collectBaseLocations(data: TreeResponse | undefined, rootLabel: string): BaseLocation[] {
  const out: BaseLocation[] = [{ dir: '', label: rootLabel, depth: 0 }];
  if (!data) return out;
  const seen = new Set<string>(['']);
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      // Only what can hold something: folders, documents, anything that already has children.
      const holds = node.kind === 'folder' || node.kind === 'doc' || node.children.length > 0;
      const dir = childDirOf(node);
      if (holds && !seen.has(dir)) {
        seen.add(dir);
        out.push({ dir, label: node.title, depth });
      }
      walk(node.children, holds ? depth + 1 : depth);
    }
  };
  walk(excludeAgentFolder(excludeTemplatesFolder(getTopLevelNodes(data))), 1);
  return out;
}

/** The name to show for a directory: its tree node's title, else its last path segment; the space root has its own label. */
export function locationLabel(locations: BaseLocation[], dir: string, rootLabel: string): string {
  if (dir === '') return rootLabel;
  return locations.find((l) => l.dir === dir)?.label ?? (dir.split('/').pop() || dir);
}
