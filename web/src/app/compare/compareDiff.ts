import { diffLines, exceedsDiffLimit } from '../settings/lineDiff';

/**
 * Highlighting of a version column against the compare view's base (its leftmost column).
 *
 * The version's markdown is cut into top-level BLOCKS (paragraphs, headings, list items, fenced code, tables…:
 * runs of lines between blank lines, a fence is never cut). A block holding a line the base does not have is
 * "changed"; lines the base had and this text lost come back as "removed" placeholders where they used to be. The
 * segments are what the column draws: runs of untouched blocks and runs of changed blocks are each ONE segment,
 * so a big page costs a handful of Markdown renders rather than one per paragraph.
 */
export type Segment =
  | { kind: 'same' | 'changed'; text: string }
  | { kind: 'removed'; lines: string[] };

export type Highlight = { tooLarge: true } | { tooLarge: false; segments: Segment[]; changedBlocks: number; removedGroups: number };

interface Block {
  /** First and last line index (inclusive) in the text's lines. */
  start: number;
  end: number;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** Top-level blocks of a markdown text: runs of non-blank lines; a fenced code block may contain blank lines and stays whole. */
export function splitBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let start = -1;
  let fence: string | null = null;
  lines.forEach((line, index) => {
    if (fence) {
      const m = FENCE.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
      return;
    }
    if (line.trim() === '') {
      if (start >= 0) blocks.push({ start, end: index - 1 });
      start = -1;
      return;
    }
    if (start < 0) start = index;
    const m = FENCE.exec(line);
    if (m) fence = m[1];
  });
  if (start >= 0) blocks.push({ start, end: lines.length - 1 });
  return blocks;
}

export function highlightChanges(base: string, current: string): Highlight {
  const baseText = base.replace(/\r\n?/g, '\n');
  const text = current.replace(/\r\n?/g, '\n');
  if (exceedsDiffLimit(baseText, text)) return { tooLarge: true };

  const lines = text === '' ? [] : text.split('\n');
  const rows = diffLines(baseText, text);
  const added = new Set<number>();
  // Removed lines by the index of the current line they stood in front of.
  const removedAt = new Map<number, string[]>();
  let at = 0;
  for (const row of rows) {
    if (row.kind === 'same') at++;
    else if (row.kind === 'add') added.add(at++);
    else if (row.text.trim() !== '') removedAt.set(at, [...(removedAt.get(at) ?? []), row.text]);
  }

  const blocks = splitBlocks(lines);
  const changed = blocks.map((block) => {
    for (let i = block.start; i <= block.end; i++) if (added.has(i)) return true;
    return false;
  });
  // A removal inside a block (not in front of it) changes that block, and its placeholder follows the block.
  const before = new Map<number, string[]>();
  const after = new Map<number, string[]>();
  let trailing: string[] = [];
  for (const [position, removed] of removedAt) {
    const index = blocks.findIndex((block) => block.end >= position);
    if (index < 0) trailing = [...trailing, ...removed];
    else if (blocks[index].start >= position) before.set(index, [...(before.get(index) ?? []), ...removed]);
    else {
      changed[index] = true;
      after.set(index, [...(after.get(index) ?? []), ...removed]);
    }
  }

  const segments: Segment[] = [];
  let removedGroups = 0;
  const pushRemoved = (removed: string[] | undefined) => {
    if (!removed?.length) return;
    segments.push({ kind: 'removed', lines: removed });
    removedGroups++;
  };
  let changedBlocks = 0;
  let runStart = -1;
  const flush = (endBlock: number) => {
    if (runStart < 0) return;
    const kind = changed[runStart] ? 'changed' : 'same';
    segments.push({ kind, text: lines.slice(blocks[runStart].start, blocks[endBlock].end + 1).join('\n') });
    runStart = -1;
  };
  blocks.forEach((_, index) => {
    if (changed[index]) changedBlocks++;
    if (runStart >= 0 && (changed[runStart] !== changed[index] || before.has(index))) flush(index - 1);
    pushRemoved(before.get(index));
    if (runStart < 0) runStart = index;
    if (after.has(index)) {
      flush(index);
      pushRemoved(after.get(index));
    }
  });
  flush(blocks.length - 1);
  pushRemoved(trailing);
  return { tooLarge: false, segments, changedBlocks, removedGroups };
}
