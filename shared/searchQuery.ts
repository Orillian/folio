/**
 * The search query grammar (Obsidian brief, wave 3) — pure TS with no DOM and no
 * database, so the server (`server/search.ts`), the web search box and the
 * saved-search chips all read a query the same way. The grammar itself is
 * documented on `SearchQueryAst` in `contracts.ts`; this file is its parser and
 * its printer.
 *
 *   words                   plain words, ANDed
 *   "exact phrase"          a phrase
 *   -word  /  -"a phrase"   exclusion
 *   tag:a/b                 a tag, hierarchy included (`tag:a` also matches `a/b`); a leading `#` is tolerated
 *   kind:doc,table          one or more page kinds (OR); `kind:doc kind:table` is the same
 *   status:draft            one or more of draft | published | archived (OR) — Folio's page status; any other
 *                           value (`status:todo`) is the front matter `status` as text (`statusValues`), OR-ed in
 *   in:folder/              path prefix (normalized to end with `/`); several are OR
 *   prop:key=value          front matter equality; `prop:key` — the key exists
 *
 * Rules worth knowing:
 *  - Operator names are case-insensitive (`TAG:x`, `Kind:Doc`); values of `tag`,
 *    `kind` and `status` are lowercased.
 *  - A token with a name that is not an operator (`foo:bar`) is a plain word. So
 *    is a `kind:` whose values are all unknown (`kind:nonsense`). A `status:` value
 *    outside Folio's three is not unknown: a vault writes `status: todo` (16.10.2026).
 *  - An operator with an empty value (`tag:` while the user is still typing) is
 *    dropped, not searched for.
 *  - Quotes are honoured right after the colon or the equals sign too:
 *    `prop:author="Ada Lovelace"`, `in:"My Notes/"`.
 *  - A `-` starts an exclusion only at the beginning of a token and only when
 *    something follows it, so `well-known` is one word and a lone `-` is nothing.
 *    Exclusion is for words and phrases: `-tag:x` excludes the text `tag:x`,
 *    it is not a negated tag filter.
 *  - Tokens with no letter or digit (`&`, `-`, `…`) carry nothing to search for and are dropped.
 *
 * `formatSearchQuery(parseSearchQuery(q))` parses back to the same AST.
 */
import { pageKindSchema, pageStatusSchema } from './contracts.js';
import type { PageKind, PageStatus, SearchQueryAst } from './contracts.js';

/** A query longer than this is cut before parsing (the endpoints cap it too). */
export const SEARCH_QUERY_MAX_CHARS = 1000;
/** At most this many terms of each kind are kept. */
const MAX_TERMS = 24;

const PAGE_KINDS: readonly string[] = pageKindSchema.options;
const PAGE_STATUSES: readonly string[] = pageStatusSchema.options;

export function emptySearchQuery(): SearchQueryAst {
  return { words: [], phrases: [], excluded: [], tags: [], kinds: [], statuses: [], pathPrefixes: [], props: [] };
}

interface Token {
  text: string;
  /** Started as a `"quoted phrase"`. */
  quoted: boolean;
  negated: boolean;
}

const isSpace = (c: string): boolean => /\s/.test(c);

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  const n = input.length;
  let i = 0;
  while (i < n) {
    while (i < n && isSpace(input[i])) i++;
    if (i >= n) break;
    let negated = false;
    if (input[i] === '-' && i + 1 < n && !isSpace(input[i + 1])) {
      negated = true;
      i++;
    }
    if (input[i] === '"') {
      const end = input.indexOf('"', i + 1);
      const raw = end === -1 ? input.slice(i + 1) : input.slice(i + 1, end);
      out.push({ text: raw.replace(/\s+/g, ' ').trim(), quoted: true, negated });
      i = end === -1 ? n : end + 1;
      continue;
    }
    let text = '';
    while (i < n && !isSpace(input[i])) {
      if (input[i] === '"') {
        // A quote opens a value only right after `name:` or `name:key=`; anywhere else it ends the token.
        if (/^[A-Za-z]+:/.test(text) && /[:=]$/.test(text)) {
          const end = input.indexOf('"', i + 1);
          text += end === -1 ? input.slice(i + 1) : input.slice(i + 1, end);
          i = end === -1 ? n : end + 1;
          continue;
        }
        break;
      }
      text += input[i];
      i++;
    }
    if (text) out.push({ text, quoted: false, negated });
  }
  return out;
}

/** A tag as the index stores it: lowercase, no `#`, no doubled or edge slashes (the same as the page parser; the letter and hex-colour rules are not applied — a tag the index cannot hold just matches nothing). */
export function normalizeSearchTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
}

/** `in:` value -> a space-relative folder prefix ending with `/`; '' when it names the root (no filter). */
export function normalizePathPrefix(raw: string): string {
  let v = raw.trim().replace(/\\/g, '/').replace(/^(?:\.?\/)+/, '').replace(/\/{2,}/g, '/');
  if (v === '.' || v === '') return '';
  if (!v.endsWith('/')) v += '/';
  return v;
}

const hasContent = (s: string): boolean => /[\p{L}\p{N}]/u.test(s);

function pushUnique<T>(list: T[], value: T): void {
  if (list.length < MAX_TERMS && !list.includes(value)) list.push(value);
}

function splitValues(value: string): string[] {
  return value.split(/[,|]/).map((v) => v.trim().toLowerCase()).filter(Boolean);
}

const OPERATOR_RE = /^([A-Za-z]+):([\s\S]*)$/;

export function parseSearchQuery(q: string): SearchQueryAst {
  const ast = emptySearchQuery();
  for (const token of tokenize(q.slice(0, SEARCH_QUERY_MAX_CHARS))) {
    if (token.quoted) {
      if (!hasContent(token.text)) continue;
      if (token.negated) pushUnique(ast.excluded, token.text);
      else pushUnique(ast.phrases, token.text);
      continue;
    }
    if (token.negated) {
      if (hasContent(token.text)) pushUnique(ast.excluded, token.text);
      continue;
    }
    const op = OPERATOR_RE.exec(token.text);
    const name = op?.[1].toLowerCase();
    const value = op?.[2].trim() ?? '';
    if (!op || (name !== 'tag' && name !== 'kind' && name !== 'status' && name !== 'in' && name !== 'prop')) {
      if (hasContent(token.text)) pushUnique(ast.words, token.text);
      continue;
    }
    if (value === '') continue; // `tag:` still being typed
    switch (name) {
      case 'tag': {
        const tag = normalizeSearchTag(value);
        if (tag) pushUnique(ast.tags, tag);
        break;
      }
      case 'kind': {
        const kinds = splitValues(value).filter((v): v is PageKind => PAGE_KINDS.includes(v));
        if (kinds.length === 0) pushUnique(ast.words, token.text);
        for (const kind of kinds) pushUnique(ast.kinds, kind);
        break;
      }
      case 'status': {
        for (const status of splitValues(value)) {
          if (PAGE_STATUSES.includes(status)) pushUnique(ast.statuses, status as PageStatus);
          else pushUnique((ast.statusValues ??= []), status);
        }
        break;
      }
      case 'in': {
        const prefix = normalizePathPrefix(value);
        if (prefix) pushUnique(ast.pathPrefixes, prefix);
        break;
      }
      case 'prop': {
        const eq = value.indexOf('=');
        const key = (eq === -1 ? value : value.slice(0, eq)).trim();
        if (!key) break;
        const propValue = eq === -1 ? '' : value.slice(eq + 1).trim();
        const prop: { key: string; value?: string } = propValue === '' ? { key } : { key, value: propValue };
        if (ast.props.length < MAX_TERMS && !ast.props.some((p) => p.key === prop.key && p.value === prop.value)) ast.props.push(prop);
        break;
      }
    }
  }
  return ast;
}

/** Wraps a value in quotes when it holds whitespace (a `"` inside cannot be represented and is dropped). */
function quoteIfNeeded(value: string): string {
  const clean = value.replace(/"/g, '');
  return /\s/.test(clean) || clean === '' ? `"${clean}"` : clean;
}

/** The query as text; `parseSearchQuery` reads it back to the same AST. */
export function formatSearchQuery(ast: SearchQueryAst): string {
  const parts: string[] = [];
  for (const w of ast.words) parts.push(w);
  for (const p of ast.phrases) parts.push(`"${p.replace(/"/g, '')}"`);
  for (const e of ast.excluded) parts.push(/\s/.test(e) ? `-"${e.replace(/"/g, '')}"` : `-${e}`);
  for (const t of ast.tags) parts.push(`tag:${quoteIfNeeded(t)}`);
  if (ast.kinds.length > 0) parts.push(`kind:${ast.kinds.join(',')}`);
  const statuses = [...ast.statuses, ...(ast.statusValues ?? [])];
  if (statuses.length > 0) parts.push(`status:${quoteIfNeeded(statuses.join(','))}`);
  for (const prefix of ast.pathPrefixes) parts.push(`in:${quoteIfNeeded(prefix)}`);
  for (const prop of ast.props) {
    const key = quoteIfNeeded(prop.key);
    parts.push(prop.value === undefined ? `prop:${key}` : `prop:${key}=${quoteIfNeeded(prop.value)}`);
  }
  return parts.join(' ');
}

/** Nothing to search for at all (an empty box, or only operators with empty values). */
export function isEmptySearchQuery(ast: SearchQueryAst): boolean {
  return (
    ast.words.length === 0 &&
    ast.phrases.length === 0 &&
    ast.excluded.length === 0 &&
    ast.tags.length === 0 &&
    ast.kinds.length === 0 &&
    ast.statuses.length === 0 &&
    (ast.statusValues?.length ?? 0) === 0 &&
    ast.pathPrefixes.length === 0 &&
    ast.props.length === 0
  );
}
