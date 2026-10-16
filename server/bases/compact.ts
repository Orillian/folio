/**
 * A base answer in the compact shape agents get (MCP query_base, fetch): plain
 * values by column id instead of the UI's typed cells.
 */
import type { BaseCell, BaseQueryResponse } from '../../shared/bases/types.js';

export function plainCell(c: BaseCell): unknown {
  if (c === null) return null;
  switch (c.t) {
    case 'list':
      return c.v.map(plainCell);
    case 'link':
      return c.pageId ? { link: c.v, pageId: c.pageId } : c.url ? { link: c.v, url: c.url } : c.v;
    case 'error':
      return `#error: ${c.v}`;
    case 'unsupported':
      return `#unsupported: ${c.v}`;
    default:
      return c.v;
  }
}

export interface CompactBase {
  view: string | null;
  views: BaseQueryResponse['views'];
  columns: Array<{ id: string; label: string }>;
  rows: Array<{ id: string; title: string; path: string; values: Record<string, unknown>; group?: unknown }>;
  groups?: Array<{ key: unknown; count: number }>;
  summaries?: Record<string, unknown>;
  total: number;
  truncated: boolean;
  warnings: string[];
  error?: string;
}

export function compactBase(r: BaseQueryResponse): CompactBase {
  const summaries: Record<string, unknown> = {};
  for (const c of r.columns) if (c.summary) summaries[c.id] = { [c.summary.name]: plainCell(c.summary.value) };
  return {
    view: r.view,
    views: r.views,
    columns: r.columns.map((c) => ({ id: c.id, label: c.label })),
    rows: r.rows.map((row) => ({
      id: row.id,
      title: row.title,
      path: row.path,
      values: Object.fromEntries(Object.entries(row.cells).map(([k, v]) => [k, plainCell(v)])),
      ...(row.group !== undefined && r.groups ? { group: plainCell(r.groups[row.group].key) } : {}),
    })),
    ...(r.groups ? { groups: r.groups.map((g) => ({ key: plainCell(g.key), count: g.count })) } : {}),
    ...(Object.keys(summaries).length ? { summaries } : {}),
    total: r.total,
    truncated: r.truncated,
    warnings: r.warnings,
    ...(r.error ? { error: r.error.line ? `${r.error.message} (line ${r.error.line})` : r.error.message } : {}),
  };
}

/** The rows as a Markdown table (fetch). */
export function baseAsMarkdown(c: CompactBase): string {
  if (c.error) return `(${c.error})`;
  const cols = c.columns;
  const text = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.map(text).join(', ');
    if (typeof v === 'object') return String((v as { link?: unknown }).link ?? JSON.stringify(v));
    return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  };
  const head = `| ${cols.map((x) => x.label).join(' | ')} |\n| ${cols.map(() => '---').join(' | ')} |`;
  const body = c.rows.map((r) => `| ${cols.map((x) => text(r.values[x.id])).join(' | ')} |`).join('\n');
  return `${head}\n${body}\n\n(${c.rows.length} of ${c.total} row(s) shown${c.view ? `, view "${c.view}"` : ''})`;
}
