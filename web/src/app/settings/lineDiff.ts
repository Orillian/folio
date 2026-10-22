/**
 * A small line diff for the "Changed in the repository" panel: the repository's version against the
 * editor's draft. Common head and tail are cut off first, the middle goes through an LCS; a middle
 * too large for that is shown as "all removed, all added" rather than freezing the page.
 */
export type DiffLine = { kind: 'same' | 'del' | 'add'; text: string };
export type DiffRow = DiffLine | { kind: 'skip'; count: number };

const LCS_CELL_LIMIT = 4_000_000;

/** The lines of a text; the empty text has none. */
function toLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/** How many lines the two texts share at the start and at the end. */
function commonEdges(a: string[], b: string[]): { head: number; tail: number } {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { head, tail };
}

/**
 * True when the changed middle of the two texts is too big for the LCS — `diffLines` then degrades to "all removed,
 * all added", which says nothing. A caller that wants to HIGHLIGHT changes (the compare view) asks first and says so.
 */
export function exceedsDiffLimit(theirs: string, mine: string): boolean {
  const a = toLines(theirs);
  const b = toLines(mine);
  const { head, tail } = commonEdges(a, b);
  return (a.length - head - tail) * (b.length - head - tail) > LCS_CELL_LIMIT;
}

export function diffLines(theirs: string, mine: string): DiffLine[] {
  const a = toLines(theirs);
  const b = toLines(mine);
  const { head, tail } = commonEdges(a, b);
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: 'same', text }));
  if (midA.length * midB.length > LCS_CELL_LIMIT) {
    out.push(...midA.map((text): DiffLine => ({ kind: 'del', text })), ...midB.map((text): DiffLine => ({ kind: 'add', text })));
  } else {
    out.push(...lcsDiff(midA, midB));
  }
  out.push(...a.slice(a.length - tail).map((text): DiffLine => ({ kind: 'same', text })));
  return out;
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      out.push({ kind: 'del', text: a[i++] });
    } else {
      out.push({ kind: 'add', text: b[j++] });
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] });
  while (j < b.length) out.push({ kind: 'add', text: b[j++] });
  return out;
}

/** Long runs of unchanged lines collapse into one "skip" row, keeping `context` lines around every change. */
export function collapseUnchanged(lines: DiffLine[], context = 2): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) rows.push({ kind: 'skip', count: skipped });
      skipped = 0;
      rows.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped) rows.push({ kind: 'skip', count: skipped });
  return rows;
}
