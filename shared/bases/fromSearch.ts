/**
 * "Save as base" from a search: the search query's FILTERS (shared/searchQuery.ts)
 * become the base's filters, in Obsidian syntax. Full-text words, phrases and
 * exclusions have no Bases equivalent (a base filters by properties, not by
 * text) — they are returned as `dropped` so the dialog can say so.
 */
import type { PageKind, SearchQueryAst } from '../contracts.js';
import { propertyRef, quoteString } from './expr.js';
import type { BaseConfig, BaseFilter } from './types.js';

const KIND_STATEMENTS: Partial<Record<PageKind, string>> = {
  doc: 'file.ext == "md" && !file.name.endsWith(".table.md") && !file.name.endsWith(".form.md")',
  table: 'file.name.endsWith(".table.md")',
  form: 'file.name.endsWith(".form.md")',
  board: 'file.name.endsWith(".excalidraw.svg")',
  pdf: 'file.ext == "pdf"',
  office: '["docx", "xlsx", "pptx"].contains(file.ext)',
  base: 'file.ext == "base"',
  folder: 'false',
};

function kindStatement(kind: string): string | undefined {
  if (kind === 'canvas') return 'file.ext == "canvas"';
  return (KIND_STATEMENTS as Record<string, string>)[kind];
}

function literal(value: string): string {
  return /^-?\d{1,15}(?:\.\d{1,15})?$/.test(value) ? value : quoteString(value);
}

export interface SearchToBase {
  filters: BaseFilter | undefined;
  /** Text parts of the query that a base cannot express. */
  dropped: string[];
}

export function searchToBaseFilters(ast: SearchQueryAst): SearchToBase {
  const and: BaseFilter[] = [];
  for (const tag of ast.tags) and.push(`file.hasTag(${quoteString(tag)})`);
  const kinds = ast.kinds.map(kindStatement).filter((s): s is string => s !== undefined);
  if (kinds.length === 1) and.push(kinds[0]);
  else if (kinds.length > 1) and.push({ or: kinds });
  if (ast.statuses.length) {
    const st = ast.statuses.map((s) => (s === 'published' ? '(status.isEmpty() || status == "published")' : `status == ${quoteString(s)}`));
    and.push(st.length === 1 ? st[0] : { or: st });
  }
  const folders = ast.pathPrefixes.map((p) => `file.inFolder(${quoteString(p.replace(/\/+$/, ''))})`);
  if (folders.length === 1) and.push(folders[0]);
  else if (folders.length > 1) and.push({ or: folders });
  for (const prop of ast.props) {
    const ref = propertyRef(prop.key);
    if (prop.value === undefined) and.push(`file.hasProperty(${quoteString(prop.key)})`);
    else and.push(`${ref} == ${literal(prop.value)}`);
  }
  const dropped = [...ast.words, ...ast.phrases.map((p) => `"${p}"`), ...ast.excluded.map((e) => `-${e}`)];
  return { filters: and.length ? { and } : undefined, dropped };
}

/** A new base for a search: its filters, one table view with the name, and the properties the query names as columns. */
export function baseConfigFromSearch(ast: SearchQueryAst, viewName: string): { config: BaseConfig; dropped: string[] } {
  const { filters, dropped } = searchToBaseFilters(ast);
  const order = ['file.name', ...ast.props.map((p) => p.key).filter((k, i, all) => all.indexOf(k) === i), 'file.mtime'];
  return {
    config: {
      ...(filters !== undefined ? { filters } : {}),
      formulas: {},
      properties: {},
      summaries: {},
      views: [{ type: 'table', name: viewName, order, sort: [{ property: 'file.mtime', direction: 'DESC' }] }],
    },
    dropped,
  };
}
