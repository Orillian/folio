/**
 * A base's filters → a SQL PREFILTER on `pages_index p`: a necessary condition,
 * never stricter than the evaluator (shared/bases/evaluate.ts), so the rows it
 * keeps are a superset of the matches and the engine decides exactly. What it
 * buys is not reading every page of a big space for `file.inFolder("x")` or
 * `file.hasTag("y")`.
 *
 * Each translation is either EXACT (the SQL is true exactly when the statement
 * is: tags, folders, extension, file name / path / folder equality,
 * hasProperty) — only those may be negated — or NECESSARY (a property
 * comparison needs the property to be there). Anything else is not translated
 * (no constraint). `and` keeps what translates; `or` only when every branch
 * does; `not` negates only exact branches.
 */
import { parseExpr, type Expr } from '../../shared/bases/expr.js';
import { unsupportedFunctionIn } from '../../shared/bases/evaluate.js';
import type { BaseFilter } from '../../shared/bases/types.js';
import { sqlParam } from '../accessSql.js';

interface Sql {
  sql: string;
  exact: boolean;
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

function stringLit(e: Expr | undefined): string | null {
  return e && e.type === 'lit' && typeof e.value === 'string' ? e.value : null;
}

/** `status`, `note.status`, `note["my prop"]` → the front matter key; null for anything else. */
function noteKey(e: Expr): string | null {
  if (e.type === 'ident') return ['file', 'note', 'formula', 'this', 'values', 'value', 'index', 'acc'].includes(e.name) ? null : e.name;
  if (e.type === 'member' && e.object.type === 'ident' && e.object.name === 'note') return e.name;
  if (e.type === 'index' && e.object.type === 'ident' && e.object.name === 'note') return stringLit(e.index);
  return null;
}

function isFileRoot(e: Expr): boolean {
  return e.type === 'ident' && e.name === 'file';
}

/** `file.<name>` → name. */
function fileField(e: Expr): string | null {
  return e.type === 'member' && isFileRoot(e.object) ? e.name : null;
}

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}/;

function tagCondition(tags: string[], params: unknown[]): Sql | null {
  const clean = tags.map((t) => t.trim().replace(/^#+/, '').toLowerCase()).filter(Boolean);
  if (clean.length === 0) return null;
  const exact = sqlParam(params, clean);
  const prefixes = sqlParam(
    params,
    clean.map((t) => `${escapeLike(t)}/%`),
  );
  return { sql: `EXISTS (SELECT 1 FROM page_tags bt WHERE bt.page_id = p.id AND (bt.tag = ANY(${exact}::text[]) OR bt.tag LIKE ANY(${prefixes}::text[])))`, exact: true };
}

function folderCondition(folder: string, params: unknown[]): Sql {
  const f = folder.trim().replace(/^\/+|\/+$/g, '');
  if (f === '') return { sql: 'TRUE', exact: true };
  return { sql: `lower(p.path) LIKE ${sqlParam(params, `${escapeLike(f.toLowerCase())}/%`)}`, exact: true };
}

/** A property that must be there and not null for the statement to hold. */
function present(key: string, params: unknown[]): string {
  return `COALESCE(jsonb_typeof(p.frontmatter -> ${sqlParam(params, key)}::text), 'null') <> 'null'`;
}

function call(e: Extract<Expr, { type: 'call' }>, params: unknown[]): Sql | null {
  // Global spellings: taggedWith(file, "x"), inFolder(file, "x").
  if (e.callee.type === 'ident') {
    const [first, ...rest] = e.args;
    const onFile = first && (isFileRoot(first) || fileField(first) === 'file');
    if (!onFile) return null;
    if (e.callee.name === 'taggedWith') {
      const tags = rest.map(stringLit);
      return tags.every((t): t is string => t !== null) ? tagCondition(tags as string[], params) : null;
    }
    if (e.callee.name === 'inFolder') {
      const f = stringLit(rest[0]);
      return f === null || rest.length !== 1 ? null : folderCondition(f, params);
    }
    return null;
  }
  if (e.callee.type !== 'member') return null;
  const method = e.callee.name;
  const target = e.callee.object;
  if (isFileRoot(target)) {
    if (method === 'hasTag') {
      const tags = e.args.map(stringLit);
      return tags.length > 0 && tags.every((t) => t !== null) ? tagCondition(tags as string[], params) : null;
    }
    if (method === 'inFolder' && e.args.length === 1) {
      const f = stringLit(e.args[0]);
      return f === null ? null : folderCondition(f, params);
    }
    if (method === 'hasProperty' && e.args.length === 1) {
      const k = stringLit(e.args[0]);
      return k === null ? null : { sql: `COALESCE(p.frontmatter ? ${sqlParam(params, k)}::text, false)`, exact: true };
    }
    return null;
  }
  // property.contains(…) / startsWith / endsWith / !isEmpty: the property must be there.
  const key = noteKey(target);
  if (key !== null && ['contains', 'containsAll', 'containsAny', 'startsWith', 'endsWith'].includes(method)) {
    return { sql: present(key, params), exact: false };
  }
  return null;
}

function comparison(e: Extract<Expr, { type: 'binary' }>, params: unknown[]): Sql | null {
  let left = e.left;
  let right = e.right;
  let op = e.op;
  // `"x" == status` reads like `status == "x"`.
  if (left.type === 'lit' && right.type !== 'lit') {
    [left, right] = [right, left];
    op = op === '<' ? '>' : op === '>' ? '<' : op === '<=' ? '>=' : op === '>=' ? '<=' : op;
  }
  const field = fileField(left);
  const lit = right.type === 'lit' ? right.value : undefined;
  if (field && op === '==' && typeof lit === 'string') {
    switch (field) {
      case 'ext':
        return /^[a-z0-9]{1,16}$/i.test(lit) ? { sql: `lower(p.path) LIKE ${sqlParam(params, `%.${lit.toLowerCase()}`)}`, exact: true } : null;
      case 'path':
        return { sql: `p.path = ${sqlParam(params, lit)}`, exact: true };
      case 'name':
        return lit.includes('/') ? { sql: 'FALSE', exact: true } : { sql: `(p.path = ${sqlParam(params, lit)} OR p.path LIKE ${sqlParam(params, `%/${escapeLike(lit)}`)})`, exact: true };
      case 'folder': {
        const f = lit.replace(/\/+$/, '');
        if (lit === '/' || lit === '') return { sql: `strpos(p.path, '/') = 0`, exact: lit === '/' };
        return { sql: `(p.path LIKE ${sqlParam(params, `${escapeLike(f)}/%`)} AND strpos(substr(p.path, ${sqlParam(params, f.length + 2)}::int), '/') = 0)`, exact: true };
      }
      default:
        return null;
    }
  }
  const key = noteKey(left);
  if (key === null || lit === undefined || lit === null) return null;
  if (op === '!=') return null;
  if (op === '==' && typeof lit === 'boolean') return { sql: `p.frontmatter -> ${sqlParam(params, key)}::text = ${sqlParam(params, JSON.stringify(lit))}::jsonb`, exact: false };
  if (op === '==' && typeof lit === 'string' && !DATE_LIKE.test(lit) && !lit.includes('[[')) {
    const k = sqlParam(params, key);
    const v = sqlParam(params, lit);
    // The same text, or a value the evaluator compares by meaning (a link, a list, a number…).
    return {
      sql: `(${present(key, params)} AND (jsonb_typeof(p.frontmatter -> ${k}::text) <> 'string' OR p.frontmatter ->> ${k}::text = ${v} OR p.frontmatter ->> ${k}::text LIKE '[[%' OR p.frontmatter ->> ${k}::text ~ '^\\d{4}-\\d{2}-\\d{2}'))`,
      exact: false,
    };
  }
  // ==, <, >, <=, >= against a value: a missing / null property never matches.
  return { sql: present(key, params), exact: false };
}

function translateExpr(e: Expr, params: unknown[]): Sql | null {
  switch (e.type) {
    case 'call':
      return call(e, params);
    case 'binary':
      if (e.op === '&&') {
        const l = translateExpr(e.left, params);
        const r = translateExpr(e.right, params);
        if (l && r) return { sql: `(${l.sql} AND ${r.sql})`, exact: l.exact && r.exact };
        const one = l ?? r;
        return one ? { sql: one.sql, exact: false } : null;
      }
      if (e.op === '||') {
        const l = translateExpr(e.left, params);
        const r = translateExpr(e.right, params);
        return l && r ? { sql: `(${l.sql} OR ${r.sql})`, exact: l.exact && r.exact } : null;
      }
      return comparison(e, params);
    case 'unary': {
      if (e.op !== '!') return null;
      const inner = translateExpr(e.arg, params);
      return inner && inner.exact ? { sql: `NOT (${inner.sql})`, exact: true } : null;
    }
    case 'ident':
    case 'member':
    case 'index': {
      // A bare property: truthy needs it present.
      const key = noteKey(e);
      return key === null ? null : { sql: present(key, params), exact: false };
    }
    default:
      return null;
  }
}

function translateStatement(src: string, params: unknown[]): Sql | null {
  let expr: Expr;
  try {
    expr = parseExpr(src);
  } catch {
    return null; // ignored by the engine as well
  }
  if (unsupportedFunctionIn(expr)) return null; // ignored by the engine
  // Translate into a scratch list first: a branch that does not translate must not leave parameters behind.
  const scratch = [...params];
  const out = translateExpr(expr, scratch);
  if (!out) return null;
  params.splice(0, params.length, ...scratch);
  return out;
}

export function translateFilter(f: BaseFilter | undefined, params: unknown[]): Sql | null {
  if (f === undefined) return null;
  if (typeof f === 'string') return translateStatement(f, params);
  if ('and' in f) {
    const parts = f.and.map((x) => translateFilter(x, params));
    const kept = parts.filter((x): x is Sql => x !== null);
    if (kept.length === 0) return null;
    return { sql: `(${kept.map((x) => x.sql).join(' AND ')})`, exact: kept.length === parts.length && kept.every((x) => x.exact) };
  }
  if ('or' in f) {
    if (f.or.length === 0) return null;
    const scratch = [...params];
    const parts = f.or.map((x) => translateFilter(x, scratch));
    if (parts.some((x) => x === null)) return null;
    params.splice(0, params.length, ...scratch);
    const kept = parts as Sql[];
    return { sql: `(${kept.map((x) => x.sql).join(' OR ')})`, exact: kept.every((x) => x.exact) };
  }
  // not: none of the items — only exact ones can be negated in SQL.
  const items = (f as { not: BaseFilter[] }).not;
  const negated: string[] = [];
  let exact = true;
  for (const item of items) {
    const scratch = [...params];
    const t = translateFilter(item, scratch);
    if (t && t.exact) {
      params.splice(0, params.length, ...scratch);
      negated.push(`NOT (${t.sql})`);
    } else exact = false;
  }
  if (negated.length === 0) return null;
  return { sql: `(${negated.join(' AND ')})`, exact };
}

/** The prefilter for a view: the base's filters AND the view's (TRUE when nothing translates). */
export function prefilterSql(filters: Array<BaseFilter | undefined>, params: unknown[]): string {
  const parts = filters.map((f) => translateFilter(f, params)).filter((x): x is Sql => x !== null);
  return parts.length ? parts.map((x) => x.sql).join(' AND ') : 'TRUE';
}
