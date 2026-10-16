/**
 * Runs a base view over rows that are ALREADY access-checked (the server's SQL
 * applies the reader's ACL and a prefilter — server/bases/query.ts): filters
 * (global AND view), sort, limit, groupBy / groupOrder, summaries, the cells of
 * the view's columns, then one page of rows. Pure: no IO, so the same engine is
 * tested without a database.
 */
import { ExprSyntaxError, parseExpr, referencedFormulas, splitPropertyId, type Expr } from './expr.js';
import {
  BaseBudgetError,
  BaseEvalError,
  BaseUnsupportedError,
  evalSummaryFormula,
  makeBudget,
  rowEvaluator,
  unsupportedFunctionIn,
  type EvalEnv,
  type RowEvaluator,
} from './evaluate.js';
import type { BaseCell, BaseColumn, BaseConfig, BaseFilter, BaseGroup, BaseQueryResponse, BaseRow, BaseView, SupportedBaseViewType } from './types.js';
import { BASE_DEFAULT_LIMIT, BASE_MAX_LIMIT, SUPPORTED_BASE_VIEW_TYPES } from './types.js';
import {
  BDate,
  BDuration,
  BFile,
  BLink,
  dateIso,
  durationText,
  equals,
  isEmptyValue,
  isPlainObject,
  sortCompare,
  toText,
  type BaseRowData,
  type Value,
} from './values.js';

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

export type CompiledFilter =
  | { kind: 'stmt'; src: string; expr: Expr }
  | { kind: 'and' | 'or' | 'not'; items: CompiledFilter[] }
  | { kind: 'ignored'; src: string };

/** Parses every statement; one that cannot be read or uses an unsupported function is IGNORED (with a warning), not failed. */
export function compileFilter(f: BaseFilter | undefined, where: string, warnings: string[]): CompiledFilter | null {
  if (f === undefined) return null;
  if (typeof f === 'string') {
    if (f.trim() === '') return null;
    try {
      const expr = parseExpr(f);
      const unsupported = unsupportedFunctionIn(expr);
      if (unsupported) {
        warnings.push(`${where}: "${f}" uses ${unsupported}, which Folio does not support yet — this condition is ignored.`);
        return { kind: 'ignored', src: f };
      }
      return { kind: 'stmt', src: f, expr };
    } catch (err) {
      const msg = err instanceof ExprSyntaxError ? err.message : String(err);
      warnings.push(`${where}: "${f}" could not be read (${msg}) — this condition is ignored.`);
      return { kind: 'ignored', src: f };
    }
  }
  const kind = 'and' in f ? 'and' : 'or' in f ? 'or' : 'not';
  const list = (f as Record<string, BaseFilter[]>)[kind] ?? [];
  const items = list.map((x, i) => compileFilter(x, `${where}.${kind}[${i}]`, warnings)).filter((x): x is CompiledFilter => x !== null);
  return { kind, items };
}

/** true / false, or null when nothing in it can be evaluated (an ignored statement, an empty group): no constraint. */
export function evalFilter(f: CompiledFilter | null, ev: RowEvaluator): boolean | null {
  if (!f) return null;
  switch (f.kind) {
    case 'ignored':
      return null;
    case 'stmt':
      try {
        const v = ev.evalExpr(f.expr);
        return isTruthyValue(v);
      } catch (err) {
        if (err instanceof BaseBudgetError) throw err;
        if (err instanceof BaseUnsupportedError) return null;
        return false; // a type error or a bad argument: the row does not match
      }
    case 'and': {
      let any = false;
      for (const item of f.items) {
        const r = evalFilter(item, ev);
        if (r === false) return false;
        if (r === true) any = true;
      }
      return any ? true : null;
    }
    case 'or': {
      let any = false;
      for (const item of f.items) {
        const r = evalFilter(item, ev);
        if (r === true) return true;
        if (r === false) any = true;
      }
      return any ? false : null;
    }
    case 'not': {
      let any = false;
      for (const item of f.items) {
        const r = evalFilter(item, ev);
        if (r === true) return false;
        if (r === false) any = true;
      }
      return any ? true : null;
    }
  }
}

function isTruthyValue(v: Value): boolean {
  if (v === null || v === false || v === '' || v === 0) return false;
  if (typeof v === 'number') return !Number.isNaN(v);
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  return true;
}

// ---------------------------------------------------------------------------
// cells
// ---------------------------------------------------------------------------

export interface LinkResolution {
  pageId?: string;
  path?: string;
}

const MAX_LIST_CELLS = 200;

export function toCell(v: Value, resolve: (target: string) => LinkResolution | null, depth = 0): BaseCell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return { t: 'text', v };
  if (typeof v === 'number') return Number.isFinite(v) ? { t: 'number', v } : null;
  if (typeof v === 'boolean') return { t: 'bool', v };
  if (v instanceof BDate) return v.time ? { t: 'datetime', v: dateIso(v) } : { t: 'date', v: dateIso(v) };
  if (v instanceof BDuration) return { t: 'duration', v: durationText(v) };
  if (v instanceof BLink) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v.path) || v.path.startsWith('mailto:')) return { t: 'link', v: v.display ?? v.path, url: v.path };
    const r = resolve(v.path);
    return { t: 'link', v: v.display ?? v.path.replace(/\.md$/i, ''), ...(r?.path ? { path: r.path } : {}), ...(r?.pageId ? { pageId: r.pageId } : {}) };
  }
  if (v instanceof BFile) return { t: 'link', v: v.row.title || v.row.path, path: v.row.path, pageId: v.row.id };
  if (v instanceof RegExp) return { t: 'text', v: String(v) };
  if (Array.isArray(v)) {
    if (depth > 4) return { t: 'text', v: toText(v) };
    return { t: 'list', v: v.slice(0, MAX_LIST_CELLS).map((x) => toCell(x, resolve, depth + 1)) };
  }
  return { t: 'object', v: toText(v) };
}

function errorCell(err: unknown): BaseCell {
  if (err instanceof BaseUnsupportedError) return { t: 'unsupported', v: err.fn };
  if (err instanceof BaseEvalError) return { t: 'error', v: err.message };
  if (err instanceof ExprSyntaxError) return { t: 'error', v: `cannot read the formula: ${err.message}` };
  return { t: 'error', v: String((err as Error)?.message ?? err) };
}

// ---------------------------------------------------------------------------
// summaries
// ---------------------------------------------------------------------------

export const BUILTIN_SUMMARIES = ['Average', 'Min', 'Max', 'Sum', 'Range', 'Median', 'Stddev', 'Earliest', 'Latest', 'Checked', 'Unchecked', 'Empty', 'Filled', 'Unique'] as const;

function builtinSummary(name: string, values: Value[]): Value | undefined {
  const nums = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  const dates = values.filter((x): x is BDate => x instanceof BDate);
  switch (name.toLowerCase()) {
    case 'average':
    case 'mean':
      return nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : null;
    case 'min':
      return nums.length ? Math.min(...nums) : null;
    case 'max':
      return nums.length ? Math.max(...nums) : null;
    case 'sum':
      return nums.length ? nums.reduce((s, x) => s + x, 0) : null;
    case 'range':
      if (dates.length && dates.length >= nums.length) {
        const ms = dates.map((d) => d.ms);
        return new BDuration(Math.max(...ms) - Math.min(...ms));
      }
      return nums.length ? Math.max(...nums) - Math.min(...nums) : null;
    case 'median': {
      if (!nums.length) return null;
      const xs = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(xs.length / 2);
      return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
    }
    case 'stddev': {
      if (!nums.length) return null;
      const mean = nums.reduce((s, x) => s + x, 0) / nums.length;
      return Math.sqrt(nums.reduce((s, x) => s + (x - mean) ** 2, 0) / nums.length);
    }
    case 'earliest':
      return dates.length ? dates.reduce((a, b) => (b.ms < a.ms ? b : a)) : null;
    case 'latest':
      return dates.length ? dates.reduce((a, b) => (b.ms > a.ms ? b : a)) : null;
    case 'checked':
      return values.filter((x) => x === true).length;
    case 'unchecked':
      return values.filter((x) => x === false || x === null).length;
    case 'empty':
      return values.filter((x) => isEmptyValue(x)).length;
    case 'filled':
      return values.filter((x) => !isEmptyValue(x)).length;
    case 'unique': {
      const seen: Value[] = [];
      for (const x of values) if (!isEmptyValue(x) && !seen.some((y) => equals(x, y))) seen.push(x);
      return seen.length;
    }
    default:
      return undefined;
  }
}

function summarize(name: string, values: Value[], config: BaseConfig, env: EvalEnv, resolve: (t: string) => LinkResolution | null): BaseCell {
  const custom = config.summaries[name];
  if (custom !== undefined) {
    try {
      const expr = parseExpr(custom);
      const unsupported = unsupportedFunctionIn(expr);
      if (unsupported) return { t: 'unsupported', v: unsupported };
      return toCell(evalSummaryFormula(custom, values, env), resolve);
    } catch (err) {
      if (err instanceof BaseBudgetError) throw err;
      return errorCell(err);
    }
  }
  const builtin = builtinSummary(name, values);
  if (builtin === undefined) return { t: 'unsupported', v: name };
  return toCell(builtin, resolve);
}

// ---------------------------------------------------------------------------
// the view
// ---------------------------------------------------------------------------

export interface RunBaseInput {
  config: BaseConfig;
  /** The view to answer (by name); the first one when absent or unknown. */
  viewName?: string;
  /** Candidate rows: readable by the caller, prefiltered (a superset of the matches). */
  rows: BaseRowData[];
  env: Omit<EvalEnv, 'budget' | 'formulas'> & { budget?: { left: number } };
  canEditRow: (row: BaseRowData) => boolean;
  resolveLink: (target: string) => LinkResolution | null;
  /**
   * How a folder is shown (the title of its page, `Tech / Prompts`): used for the cells of `file.folder` and for
   * the headers of a `groupBy: file.folder`. Display only — filters, sorts and groups still compare the path.
   * Returning null keeps the path (the root `/`, a folder without a page).
   */
  folderLabel?: (dir: string) => string | null;
  offset?: number;
  limit?: number;
}

export type RunBaseResult = Omit<BaseQueryResponse, 'truncated'> & {
  /** Cards: per row id, the cover property's value as written (a link target, a URL or a colour), resolved by the server. */
  coverTargets?: Record<string, string>;
};

const DEFAULT_ORDER = ['file.name'];
const KNOWN_VIEW_KEYS = new Set(['type', 'name', 'filters', 'order', 'sort', 'groupBy', 'groupOrder', 'summaries', 'limit']);

/** A `file.folder` cell with the folder's display name in place of its path (the path stays the value everywhere else). */
function folderCell(cell: BaseCell, label: RunBaseInput['folderLabel']): BaseCell {
  if (!label || cell === null || cell.t !== 'text') return cell;
  const shown = label(cell.v);
  return shown ? { t: 'text', v: shown } : cell;
}

export function pickView(config: BaseConfig, name?: string): BaseView | null {
  if (config.views.length === 0) return null;
  return (name !== undefined ? config.views.find((v) => v.name === name) : undefined) ?? config.views[0];
}

/** `properties.<id>.displayName`, for `status` also `note.status` and the other way round. */
export function displayNameOf(config: BaseConfig, id: string): string | undefined {
  const direct = config.properties[id]?.displayName;
  if (typeof direct === 'string' && direct) return direct;
  const { source, name } = splitPropertyId(id);
  if (source === 'note') {
    const alt = id.startsWith('note.') ? config.properties[name]?.displayName : config.properties[`note.${name}`]?.displayName;
    if (typeof alt === 'string' && alt) return alt;
  }
  return undefined;
}

/** Why a formula cannot be evaluated by Folio (itself or a formula it reads), or undefined. */
export function formulaProblem(config: BaseConfig, name: string, seen = new Set<string>()): string | undefined {
  const src = config.formulas[name];
  if (src === undefined) return `no formula named ${name}`;
  if (seen.has(name)) return `circular formula: ${name}`;
  seen.add(name);
  let expr: Expr;
  try {
    expr = parseExpr(src);
  } catch (err) {
    return `cannot read the formula: ${(err as Error).message}`;
  }
  const unsupported = unsupportedFunctionIn(expr);
  if (unsupported) return `${unsupported} is not supported`;
  for (const ref of referencedFormulas(expr)) {
    if (config.formulas[ref] === undefined) continue;
    const p = formulaProblem(config, ref, new Set(seen));
    if (p) return p;
  }
  return undefined;
}

function groupKeyText(v: Value): string | null {
  if (isEmptyValue(v)) return null;
  if (v instanceof BDate) return `d:${dateIso(v)}`;
  if (typeof v === 'number') return `n:${v}`;
  if (typeof v === 'boolean') return `b:${v}`;
  return `s:${toText(v)}`;
}

function groupOrderMatches(entry: string | number | boolean | null, key: Value): boolean {
  if (entry === null) return isEmptyValue(key);
  if (isEmptyValue(key)) return false;
  return toText(key) === String(entry) || equals(key, entry);
}

export function runBase(input: RunBaseInput): RunBaseResult {
  const { config } = input;
  const warnings: string[] = [];
  const view = pickView(config, input.viewName);
  const env: EvalEnv = { ...input.env, formulas: config.formulas, budget: input.env.budget ?? makeBudget() };

  const declaredType = view?.type ?? 'table';
  const supported = (SUPPORTED_BASE_VIEW_TYPES as readonly string[]).includes(declaredType);
  const layout: SupportedBaseViewType = supported ? (declaredType as SupportedBaseViewType) : 'table';

  // Filters: the base's AND the view's.
  const globalFilter = compileFilter(config.filters, 'filters', warnings);
  const viewFilter = compileFilter(view?.filters, `view "${view?.name ?? ''}" filters`, warnings);

  // Columns.
  const order = view?.order && view.order.length > 0 ? view.order : DEFAULT_ORDER;
  const columns: BaseColumn[] = [];
  const seenColumns = new Set<string>();
  for (const id of order) {
    if (seenColumns.has(id)) continue;
    seenColumns.add(id);
    const { source, name } = splitPropertyId(id);
    const label = displayNameOf(config, id) ?? (source === 'note' ? name : id);
    const column: BaseColumn = { id, label, source, editable: source === 'note' && name !== '' };
    if (source === 'note') column.key = name;
    if (source === 'formula') {
      const problem = formulaProblem(config, name);
      if (problem) column.unsupported = problem;
    }
    columns.push(column);
  }

  // Evaluate.
  type Work = { row: BaseRowData; ev: RowEvaluator };
  const matched: Work[] = [];
  for (const row of input.rows) {
    const ev = rowEvaluator(row, env);
    const g = evalFilter(globalFilter, ev);
    if (g === false) continue;
    const v = evalFilter(viewFilter, ev);
    if (v === false) continue;
    matched.push({ row, ev });
  }

  const safeProperty = (w: Work, id: string): Value => {
    try {
      return w.ev.property(id);
    } catch (err) {
      if (err instanceof BaseBudgetError) throw err;
      return null;
    }
  };

  // Sort (stable), default by title.
  const sorts = view?.sort ?? [];
  const keyed = matched.map((w, i) => ({ w, i, keys: sorts.map((s) => safeProperty(w, s.property)) }));
  keyed.sort((a, b) => {
    for (let k = 0; k < sorts.length; k++) {
      const c = sortCompare(a.keys[k], b.keys[k]);
      if (c !== 0) {
        // Empty values stay last in both directions.
        const emptyInvolved = isEmptyValue(a.keys[k]) || isEmptyValue(b.keys[k]);
        return sorts[k].direction === 'DESC' && !emptyInvolved ? -c : c;
      }
    }
    if (sorts.length === 0) {
      const c = (a.w.row.title || a.w.row.path).localeCompare(b.w.row.title || b.w.row.path, undefined, { numeric: true, sensitivity: 'base' });
      if (c !== 0) return c;
    }
    return a.i - b.i;
  });
  let ordered = keyed.map((k) => k.w);
  if (view?.limit && ordered.length > view.limit) ordered = ordered.slice(0, view.limit);

  // Group.
  let groups: BaseGroup[] | undefined;
  const groupOf = new Map<Work, number>();
  const groupMembers: Work[][] = [];
  if (view?.groupBy) {
    const gb = view.groupBy;
    const byKey = new Map<string | null, { value: Value; members: Work[] }>();
    for (const w of ordered) {
      const value = safeProperty(w, gb.property);
      const key = groupKeyText(value);
      const slot = byKey.get(key);
      if (slot) slot.members.push(w);
      else byKey.set(key, { value: isEmptyValue(value) ? null : value, members: [w] });
    }
    let entries = [...byKey.entries()];
    if (view.groupOrder) {
      const picked: typeof entries = [];
      for (const want of view.groupOrder) {
        const hit = entries.find(([, slot]) => groupOrderMatches(want, slot.value));
        if (hit && !picked.includes(hit)) picked.push(hit);
      }
      entries = picked;
    } else {
      entries.sort(([ka, a], [kb, b]) => {
        if (ka === null || kb === null) return ka === kb ? 0 : ka === null ? 1 : -1;
        const c = sortCompare(a.value, b.value);
        return gb.direction === 'DESC' ? -c : c;
      });
    }
    groups = [];
    const kept: Work[] = [];
    entries.forEach(([, slot], gi) => {
      const key = toCell(slot.value, input.resolveLink);
      groups!.push({ key: gb.property === 'file.folder' ? folderCell(key, input.folderLabel) : key, count: slot.members.length });
      groupMembers.push(slot.members);
      for (const w of slot.members) {
        groupOf.set(w, gi);
        kept.push(w);
      }
    });
    ordered = kept;
  }

  // Summaries (of the whole result, and of each group).
  const summaryOf = view?.summaries ?? {};
  for (const column of columns) {
    const name = summaryOf[column.id];
    if (!name) continue;
    const values = ordered.map((w) => safeProperty(w, column.id));
    column.summary = { name, value: summarize(name, values, config, env, input.resolveLink) };
    if (groups) {
      groups.forEach((g, gi) => {
        const groupValues = groupMembers[gi].map((w) => safeProperty(w, column.id));
        (g.summaries ??= {})[column.id] = summarize(name, groupValues, config, env, input.resolveLink);
      });
    }
  }

  // One page of rows.
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const limit = Math.min(BASE_MAX_LIMIT, Math.max(1, Math.floor(input.limit ?? BASE_DEFAULT_LIMIT)));
  const page = ordered.slice(offset, offset + limit);
  const coverProp = layout === 'cards' && typeof view?.image === 'string' && view.image ? view.image : undefined;
  const coverTargets: Record<string, string> = {};
  const rows: BaseRow[] = page.map((w) => {
    const cells: Record<string, BaseCell> = {};
    for (const column of columns) {
      if (column.id === 'file.name' || column.id === 'file.basename') {
        cells[column.id] = { t: 'link', v: w.row.title || w.row.path, path: w.row.path, pageId: w.row.id };
        continue;
      }
      try {
        const cell = toCell(w.ev.property(column.id), input.resolveLink);
        cells[column.id] = column.id === 'file.folder' ? folderCell(cell, input.folderLabel) : cell;
      } catch (err) {
        if (err instanceof BaseBudgetError) throw err;
        cells[column.id] = errorCell(err);
      }
    }
    const out: BaseRow = { id: w.row.id, title: w.row.title, path: w.row.path, kind: w.row.kind, canEdit: input.canEditRow(w.row), cells };
    const gi = groupOf.get(w);
    if (gi !== undefined) out.group = gi;
    if (coverProp) {
      const v = safeProperty(w, coverProp);
      const target = v instanceof BLink ? v.path : typeof v === 'string' ? v : Array.isArray(v) && v[0] instanceof BLink ? v[0].path : null;
      if (target) coverTargets[w.row.id] = target;
    }
    return out;
  });

  if (!supported) warnings.unshift(`"${declaredType}" views are not supported yet — shown as a table.`);

  const options: Record<string, unknown> = {};
  if (view) for (const [k, v] of Object.entries(view)) if (!KNOWN_VIEW_KEYS.has(k)) options[k] = v;

  return {
    views: config.views.map((v) => ({ name: v.name, type: v.type, supported: (SUPPORTED_BASE_VIEW_TYPES as readonly string[]).includes(v.type) })),
    view: view?.name ?? null,
    layout,
    ...(supported ? {} : { unsupportedType: declaredType }),
    columns,
    rows,
    ...(groups ? { groups } : {}),
    total: ordered.length,
    offset,
    limit,
    warnings,
    ...(Object.keys(options).length ? { options } : {}),
    ...(coverProp ? { coverTargets } : {}),
  };
}

/** Does the base read file fields that cost an extra query (backlinks, embeds, ctime)? */
export function baseReadsFields(config: BaseConfig, fields: string[]): Set<string> {
  const texts: string[] = [...Object.values(config.formulas), ...Object.values(config.summaries)];
  const collect = (f: BaseFilter | undefined) => {
    if (f === undefined) return;
    if (typeof f === 'string') texts.push(f);
    else for (const x of Object.values(f) as BaseFilter[][]) x.forEach(collect);
  };
  collect(config.filters);
  const ids: string[] = [];
  for (const v of config.views) {
    collect(v.filters);
    ids.push(...(v.order ?? []), ...(v.sort ?? []).map((s) => s.property));
    if (v.groupBy) ids.push(v.groupBy.property);
  }
  const out = new Set<string>();
  for (const f of fields) {
    if (ids.includes(`file.${f}`) || texts.some((t) => t.includes(`.${f}`) || t.includes(`"${f}"`))) out.add(f);
  }
  return out;
}
