/**
 * A `#tag` chip in the reading view asks the app to search for it. markdown/ is
 * a standalone module (it must not import from app/), so it says so with a
 * window event and the shell, which owns the quick switcher, listens
 * (app/Shell.tsx). The query is `tag:<tag>`, the operator wave 3 adds to the
 * server search; until it lands the switcher simply searches the text it is
 * given. On a public site and on a share link the chip is plain text (there is
 * no search with operators there yet).
 */
export const SEARCH_REQUEST_EVENT = 'folio:search-request';

export interface SearchRequestDetail {
  query: string;
}

export function requestSearch(query: string): void {
  window.dispatchEvent(new CustomEvent<SearchRequestDetail>(SEARCH_REQUEST_EVENT, { detail: { query } }));
}
