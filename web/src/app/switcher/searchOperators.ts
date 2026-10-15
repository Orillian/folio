/**
 * The operators search v2 understands (grammar: shared/contracts.ts, "search v2"; parsed on the
 * server by shared/searchQuery.ts). The switcher lists them under the input and a click types one in.
 */
export interface SearchOperator {
  /** Key of the tooltip (`search.operators.<id>`). */
  id: 'tag' | 'kind' | 'status' | 'in' | 'prop' | 'phrase' | 'exclude';
  /** What the help line shows. */
  label: string;
  /** What gets typed into the query. */
  text: string;
  /** The caret goes one character back from the end — inside the quotes of `""`. */
  caretBack?: boolean;
}

export const SEARCH_OPERATORS: readonly SearchOperator[] = [
  { id: 'tag', label: 'tag:', text: 'tag:' },
  { id: 'kind', label: 'kind:', text: 'kind:' },
  { id: 'status', label: 'status:', text: 'status:' },
  { id: 'in', label: 'in:', text: 'in:' },
  { id: 'prop', label: 'prop:', text: 'prop:' },
  { id: 'phrase', label: '"phrase"', text: '""', caretBack: true },
  { id: 'exclude', label: '-word', text: '-' },
];

/** The query with the operator appended (a space between it and what is already typed) and where the caret belongs. */
export function insertOperator(query: string, operator: SearchOperator): { query: string; caret: number } {
  const base = query.trim() === '' ? '' : /\s$/.test(query) ? query : `${query} `;
  const next = base + operator.text;
  return { query: next, caret: operator.caretBack ? next.length - 1 : next.length };
}
