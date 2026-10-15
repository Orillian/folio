/**
 * Search — PostgreSQL FTS + pg_trgm (round 4; replaces round 2's in-memory
 * substring index, which is now deleted). Config 'simple' + unaccent (no
 * stemming — DEV-PLAN's explicit, fixed ru/uk/en compromise). Title carries
 * tsvector weight 'A', body 'B' (set at write time in storage.ts), so
 * ts_rank_cd alone already ranks title matches first; pg_trgm's `%`
 * similarity operator on title additionally catches a typo that wouldn't
 * tokenize-match at all. Permission filtering is a JOIN inside the query
 * (EXISTS against space_members, OR the space's own `visibility`), not a
 * post-filter, so an invisible space's rows are never even ranked, let alone
 * returned.
 *
 * The ACL itself is accessSql.ts's visiblePagesSql (14.10.2026), shared with
 * backlinks and the page index reads; the rules below are what it encodes.
 *
 * Round 27 (access and rights): removed the old instance-admin bypass (this
 * used to be `$2::boolean OR EXISTS(...)`, with an `isInstanceAdmin` flag
 * short-circuiting the membership check entirely). Search now applies the
 * SAME visibility rule as effectiveRole/membershipsFor in auth/session.ts:
 * an explicit `space_members` row, OR the space being `visibility:
 * 'instance'` (or `'public'`, which includes it). `isAdmin` grants nothing extra here — see docs/spec-access.md
 * §1/§2 ("not 'an admin cannot read a private space', but 'an admin cannot
 * read it silently'"). Callers (server/routes.ts, server/mcp.ts) no
 * longer pass an admin flag at all.
 */
import type { PageKind, SearchHit, SearchQueryAst } from '../shared/contracts.js';
import { isEmptySearchQuery, parseSearchQuery } from '../shared/searchQuery.js';
import { query } from './db/pool.js';
import { sqlParam, visiblePagesSql } from './accessSql.js';

/**
 * Wave 3 (search v2, Obsidian brief): `q` is parsed by shared/searchQuery.ts
 * into words, "phrases", -exclusions and the filters tag:/kind:/status:/in:/prop:
 * (grammar on SearchQueryAst in contracts.ts). All of it is one SQL statement:
 *
 *   words        plainto_tsquery('simple', unaccent(words)) — all words ANDed, exactly as before —
 *                OR a trigram-similar title (the typo net), so a plain-word query behaves as it always did
 *   "phrase"     phraseto_tsquery, ANDed with the words (the title net then only stands in for the words)
 *   -word        NOT (tsv @@ the word / the phrase)
 *   tag:a/b      EXISTS page_tags (tag = 'a/b' OR tag LIKE 'a/b/%'), one per tag, so tags AND
 *   kind:/status: equality against a list (OR inside one operator); a page without `status` is 'published'
 *   in:folder/   path LIKE 'folder/%' (several: OR)
 *   prop:k=v     front matter: scalar text equality (case-insensitive), a list holding v, a number equal to v, a date
 *                ('2026-10-14') on that day; prop:k — the key exists
 *
 * Operators AND together; a query with no words and no phrases is a filter listing, newest change first.
 * The ACL fragment is the same one as before and is ANDed on top of everything.
 */

interface SearchRow {
  id: string;
  space: string;
  path: string;
  title: string;
  kind: PageKind;
  snippet: string;
}

/** The grammar in one paragraph, for the MCP tool descriptions (docs/AGENT-API.md has the table). */
export const SEARCH_GRAMMAR_NOTE =
  'The query takes words (all must match), "an exact phrase", -excluded words and these filters, ANDed together: tag:name (tag:a also matches a/b), kind:doc|table|board|form|pdf|office, status:draft|published|archived, in:folder/ (path prefix), prop:key=value or prop:key (front matter). A query of filters alone lists the matching pages, most recently changed first.';

export const SEARCH_DEFAULT_LIMIT = 50;
export const SEARCH_MAX_LIMIT = 100;

/** `?limit=` -> 1..100, default 50. */
export function clampSearchLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return SEARCH_DEFAULT_LIMIT;
  return Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/** `?offset=` -> a non-negative integer, default 0. */
export function clampSearchOffset(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1_000_000) : 0;
}

export interface SearchWindow {
  limit?: number;
  offset?: number;
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

const HEADLINE_OPTIONS = `'MaxWords=30, MinWords=10, ShortWord=3, HighlightAll=false'`;

interface BuiltSearch {
  /** AND-ed conditions on `p` (everything but the ACL and the space). */
  conditions: string[];
  /** The ts_headline query: the positive (words + phrases) tsquery, or an empty one. */
  headlineQuery: string;
  orderBy: string;
}

/** `lower(...)` comparison helpers for `prop:` — `k` and `v` are `$n::text` placeholders. */
function propCondition(prop: { key: string; value?: string }, params: unknown[]): string {
  const k = `${sqlParam(params, prop.key)}::text`;
  if (prop.value === undefined) return `p.frontmatter ? ${k}`;
  const value = prop.value;
  const v = `${sqlParam(params, value)}::text`;
  const field = `(p.frontmatter -> ${k})`;
  const alternatives = [
    `lower(p.frontmatter ->> ${k}) = lower(${v})`,
    `EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${field}) = 'array' THEN ${field} ELSE '[]'::jsonb END) pe(val) WHERE lower(pe.val) = lower(${v}))`,
  ];
  if (/^-?\d{1,30}(?:\.\d{1,30})?$/.test(value)) alternatives.push(`(jsonb_typeof(${field}) = 'number' AND (p.frontmatter ->> ${k})::numeric = ${v}::numeric)`);
  // The index stores a YAML date as an ISO timestamp.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) alternatives.push(`(jsonb_typeof(${field}) = 'string' AND (p.frontmatter ->> ${k}) LIKE ${v} || 'T%')`);
  return `(${alternatives.join(' OR ')})`;
}

/**
 * `publicReader`: the anonymous reader of a published site. It gets the text grammar and the filters that rest on
 * what the site shows (`kind:`, `status:`, `in:`), and `tag:` over the tags written in the BODY only — the front
 * matter is not published, so `prop:` is ignored and front matter tags are neither matched nor returned.
 */
function buildSearch(ast: SearchQueryAst, params: unknown[], publicReader: boolean): BuiltSearch {
  const conditions: string[] = [];

  const wordsText = ast.words.join(' ');
  const wordsParam = ast.words.length > 0 ? sqlParam(params, wordsText) : null;
  const tsWords = wordsParam ? `plainto_tsquery('simple', unaccent(${wordsParam}))` : null;
  const tsPhrases = ast.phrases.length > 0 ? ast.phrases.map((ph) => `phraseto_tsquery('simple', unaccent(${sqlParam(params, ph)}))`).join(' && ') : null;
  const positive = tsWords && tsPhrases ? `(${tsWords} && ${tsPhrases})` : (tsWords ?? (tsPhrases ? `(${tsPhrases})` : null));

  if (positive) {
    if (wordsParam && !tsPhrases) conditions.push(`(p.tsv @@ ${positive} OR p.title % ${wordsParam})`);
    else if (wordsParam && tsPhrases) conditions.push(`(p.tsv @@ ${positive} OR (p.title % ${wordsParam} AND p.tsv @@ (${tsPhrases})))`);
    else conditions.push(`p.tsv @@ ${positive}`);
  }

  if (ast.excluded.length > 0) {
    const excluded = ast.excluded.map((e) => `${/\s/.test(e) ? 'phraseto_tsquery' : 'plainto_tsquery'}('simple', unaccent(${sqlParam(params, e)}))`);
    conditions.push(`NOT coalesce(p.tsv @@ (${excluded.join(' || ')}), false)`);
  }

  for (const tag of ast.tags) {
    const exact = sqlParam(params, tag);
    const children = sqlParam(params, `${escapeLike(tag)}/%`);
    conditions.push(
      `EXISTS (SELECT 1 FROM page_tags pt WHERE pt.page_id = p.id AND (pt.tag = ${exact} OR pt.tag LIKE ${children})${publicReader ? " AND pt.source = 'body'" : ''})`,
    );
  }

  if (ast.kinds.length > 0) conditions.push(`p.kind = ANY(${sqlParam(params, ast.kinds)}::text[])`);
  if (ast.statuses.length > 0) conditions.push(`COALESCE(p.status, 'published') = ANY(${sqlParam(params, ast.statuses)}::text[])`);
  if (ast.pathPrefixes.length > 0) conditions.push(`p.path LIKE ANY(${sqlParam(params, ast.pathPrefixes.map((prefix) => `${escapeLike(prefix)}%`))}::text[])`);
  if (!publicReader) for (const prop of ast.props) conditions.push(propCondition(prop, params));

  const rank = [positive ? `ts_rank_cd(p.tsv, ${positive})` : null, wordsParam ? `similarity(p.title, ${wordsParam})` : null].filter(Boolean).join(' + ');
  return {
    conditions,
    headlineQuery: positive ?? `''::tsquery`,
    orderBy: positive ? `ORDER BY (${rank}) DESC, p.title, p.id` : 'ORDER BY p.updated_at DESC, p.title, p.id',
  };
}

// ts_headline's default StartSel/StopSel are <b>/</b> (its options string doesn't
// accept an empty override in this PG version) — SearchHit.snippet is plain text.
async function runSearch(ast: SearchQueryAst, window: SearchWindow, params: unknown[], publicReader: boolean, access: (params: unknown[]) => string): Promise<SearchHit[]> {
  if (isEmptySearchQuery(ast)) return [];
  const built = buildSearch(ast, params, publicReader);
  const visible = access(params);
  const limit = sqlParam(params, clampSearchLimit(window.limit));
  const offset = sqlParam(params, clampSearchOffset(window.offset));
  const rows = await query<SearchRow>(
    `SELECT p.id, p.space_slug AS space, p.path, p.title, p.kind,
            ts_headline('simple', coalesce(NULLIF(p.plain_text, ''), p.title), ${built.headlineQuery}, ${HEADLINE_OPTIONS}) AS snippet
       FROM pages_index p
      WHERE ${[...built.conditions, visible].join('\n        AND ')}
      ${built.orderBy}
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  if (rows.length === 0) return [];

  // The hits' tags in one more query (only for the page of results, not for every match).
  const tagRows = await query<{ page_id: string; tags: string[] }>(
    `SELECT page_id, array_agg(DISTINCT tag ORDER BY tag) AS tags
       FROM page_tags
      WHERE page_id = ANY($1::text[])${publicReader ? " AND source = 'body'" : ''}
      GROUP BY page_id`,
    [rows.map((r) => r.id)],
  );
  const tagsById = new Map(tagRows.map((r) => [r.page_id, r.tags]));
  return rows.map((r) => ({
    id: r.id,
    space: r.space,
    path: r.path,
    title: r.title,
    snippet: r.snippet.replace(/<\/?b>/g, '').trim(),
    kind: r.kind,
    tags: tagsById.get(r.id) ?? [],
  }));
}

export interface SearchOptions extends SearchWindow {
  userId: string;
  /** Restrict to one space; omit to search every space the caller can see. */
  space?: string;
  /**
   * Round `.agent` (owner spec, 21.09.2026): instance admins see `.agent/**`
   * hits everywhere, same as canAdministerSpace's rule elsewhere — a space
   * admin without that flag still sees them via the per-row space_members
   * EXISTS below. Default false (every caller must say explicitly).
   */
  isInstanceAdmin?: boolean;
}

export async function searchPages(q: string, options: SearchOptions): Promise<SearchHit[]> {
  const ast = parseSearchQuery(q);
  const params: unknown[] = [];
  return runSearch(ast, options, params, false, (p) => {
    // Templates stay searchable for members (unchanged); only the index reads hide them.
    const visible = visiblePagesSql('p', { kind: 'user', userId: options.userId, isInstanceAdmin: options.isInstanceAdmin ?? false }, p);
    if (options.space === undefined) return visible;
    return `${visible}\n        AND p.space_slug = ${sqlParam(p, options.space)}`;
  });
}

/**
 * Search for the PUBLIC SITE of one space (anonymous visitors). Same matching
 * and ranking as `searchPages`, but the only access rule is the site's own:
 * the space is published, and the page is not restricted (no `page_access`
 * row), not `.agent/**` and not in `_templates/` — accessSql.ts's public
 * reader, the same set as publicSites.publicReadablePageIds. No user is involved.
 */
export async function searchPublicSpace(q: string, space: string, window: SearchWindow = {}): Promise<SearchHit[]> {
  return runSearch(parseSearchQuery(q), window, [], true, (p) => visiblePagesSql('p', { kind: 'public', space }, p));
}
