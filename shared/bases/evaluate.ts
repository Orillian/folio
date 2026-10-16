/**
 * The Bases expression evaluator: walks an AST from expr.ts against one row.
 * No `eval`; every function is in the tables below. A function that is not
 * there throws BaseUnsupportedError (the column shows "formula not supported",
 * a filter statement using it is ignored with a warning); a bad argument or a
 * type mismatch throws BaseEvalError (the cell shows the error, a filter
 * statement is false for that row). Missing properties are null, and most
 * methods on null are null too — the way Obsidian shows an empty cell.
 *
 * Budget: a query evaluates at most `budget` AST nodes in total (all rows), so a
 * hostile base cannot pin the server; regular expressions with nested
 * quantifiers or back-references are refused, and their input is capped.
 */
import { calledFunctions, parseExpr, type Expr } from './expr.js';
import {
  addDuration,
  basenameOf,
  BDate,
  BDuration,
  BFile,
  BLink,
  compare,
  equals,
  formatDate,
  fromJson,
  isEmptyValue,
  isPlainObject,
  parseDateText,
  parseDuration,
  parseWikilinkText,
  relativeText,
  sameTarget,
  sortCompare,
  toText,
  truthy,
  typeName,
  type BaseRowData,
  type Value,
  type ValueObject,
} from './values.js';

export class BaseEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaseEvalError';
  }
}

export class BaseUnsupportedError extends Error {
  constructor(public fn: string) {
    super(`${fn} is not supported`);
    this.name = 'BaseUnsupportedError';
  }
}

export class BaseBudgetError extends Error {
  constructor() {
    super('the base is too expensive to evaluate');
    this.name = 'BaseBudgetError';
  }
}

/** What an expression sees beyond its row. */
export interface EvalEnv {
  /** `formula.<name>` → its expression text. */
  formulas: Record<string, string>;
  /** Property keys the space types as date / datetime. */
  dateKeys: ReadonlySet<string>;
  /** `this`: the base page, or the page a base block is embedded in. */
  thisRow: BaseRowData | null;
  /** A page by link target (path or name), for `link.asFile()`, `file("…")`. */
  lookupFile: (target: string) => BaseRowData | null;
  nowMs: number;
  /** Nodes left to evaluate in this query (shared by all rows). */
  budget: { left: number };
  random?: () => number;
}

export function makeBudget(nodes = 3_000_000): { left: number } {
  return { left: nodes };
}

interface Scope {
  row: BaseRowData;
  env: EvalEnv;
  /** Formula values of this row (memo) and the formulas being evaluated (cycle check). */
  formulaMemo: Map<string, Value>;
  formulaStack: Set<string>;
  /** `value`, `index`, `acc` inside filter/map/reduce; `values` in a summary. */
  locals?: Record<string, Value>;
  /** Note properties converted once per row. */
  propsCache?: Map<string, Value>;
}

// ---------------------------------------------------------------------------
// supported names (static check)
// ---------------------------------------------------------------------------

export const GLOBAL_FUNCTIONS = new Set([
  'if',
  'now',
  'today',
  'date',
  'duration',
  'number',
  'list',
  'max',
  'min',
  'link',
  'file',
  'escapeHTML',
  'random',
  // older Obsidian spellings, still found in vaults
  'taggedWith',
  'linksTo',
  'inFolder',
]);

/** Globals Obsidian has that Folio does not render (yet). */
export const UNSUPPORTED_GLOBALS = new Set(['html', 'image', 'icon']);

const METHODS_ANY = ['isTruthy', 'isType', 'toString', 'isEmpty'];
const METHODS_STRING = ['contains', 'containsAll', 'containsAny', 'endsWith', 'startsWith', 'lower', 'replace', 'repeat', 'reverse', 'slice', 'split', 'title', 'trim'];
const METHODS_NUMBER = ['abs', 'ceil', 'floor', 'round', 'toFixed'];
const METHODS_DATE = ['date', 'format', 'time', 'relative'];
const METHODS_LIST = ['contains', 'containsAll', 'containsAny', 'filter', 'map', 'reduce', 'flat', 'join', 'reverse', 'slice', 'sort', 'unique', 'mean', 'median', 'stddev', 'sum', 'min', 'max'];
const METHODS_LINK = ['asFile', 'linksTo'];
const METHODS_FILE = ['asLink', 'hasLink', 'hasProperty', 'hasTag', 'inFolder'];
const METHODS_OBJECT = ['keys', 'values'];
const METHODS_REGEXP = ['matches'];

export const KNOWN_METHODS = new Set([
  ...METHODS_ANY,
  ...METHODS_STRING,
  ...METHODS_NUMBER,
  ...METHODS_DATE,
  ...METHODS_LIST,
  ...METHODS_LINK,
  ...METHODS_FILE,
  ...METHODS_OBJECT,
  ...METHODS_REGEXP,
]);

/** The first function an expression uses that Folio does not implement, or null. */
export function unsupportedFunctionIn(e: Expr): string | null {
  const { globals, methods } = calledFunctions(e);
  for (const g of globals) if (!GLOBAL_FUNCTIONS.has(g)) return `${g}()`;
  for (const m of methods) if (!KNOWN_METHODS.has(m)) return `.${m}()`;
  return null;
}

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

function tick(scope: Scope): void {
  if (--scope.env.budget.left < 0) throw new BaseBudgetError();
}

function noteProperty(scope: Scope, key: string): Value {
  const cache = (scope.propsCache ??= new Map());
  if (cache.has(key)) return cache.get(key)!;
  const props = scope.row.properties;
  const v = Object.prototype.hasOwnProperty.call(props, key) ? fromJson(props[key], scope.env.dateKeys.has(key)) : null;
  cache.set(key, v);
  return v;
}

function notePropertiesObject(row: BaseRowData, env: EvalEnv): ValueObject {
  const out: ValueObject = {};
  for (const [k, v] of Object.entries(row.properties)) out[k] = fromJson(v, env.dateKeys.has(k));
  return out;
}

function evalFormula(scope: Scope, name: string): Value {
  if (scope.formulaMemo.has(name)) return scope.formulaMemo.get(name)!;
  const src = scope.env.formulas[name];
  if (src === undefined) return null;
  if (scope.formulaStack.has(name)) throw new BaseEvalError(`circular formula: ${name}`);
  scope.formulaStack.add(name);
  try {
    const v = evaluate(parseExpr(String(src)), { ...scope, locals: undefined });
    scope.formulaMemo.set(name, v);
    return v;
  } finally {
    scope.formulaStack.delete(name);
  }
}

const FILE_REF = Symbol('fileRoot');
const NOTE_REF = Symbol('noteRoot');
const FORMULA_REF = Symbol('formulaRoot');
const THIS_REF = Symbol('thisRoot');
type RootRef = typeof FILE_REF | typeof NOTE_REF | typeof FORMULA_REF | typeof THIS_REF;
type Ref = Value | { root: RootRef } | { thisFile: true };

function isRootRef(v: Ref): v is { root: RootRef } {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, 'root') && typeof (v as { root: unknown }).root === 'symbol';
}
function isThisFileRef(v: Ref): v is { thisFile: true } {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && (v as { thisFile?: unknown }).thisFile === true && Object.keys(v).length === 1 && !isPlainObjectValue(v);
}
// Plain objects from properties never carry our marker shapes as own symbols, but `thisFile: true` could be a
// property value — guarded by building the marker with a null prototype.
function isPlainObjectValue(v: unknown): boolean {
  return isPlainObject(v);
}
function thisFileMarker(): { thisFile: true } {
  const o = Object.create(null) as { thisFile: true };
  o.thisFile = true;
  return o;
}
function rootMarker(root: RootRef): { root: RootRef } {
  const o = Object.create(null) as { root: RootRef };
  o.root = root;
  return o;
}

/** Evaluates `e` for `scope.row`. */
export function evaluate(e: Expr, scope: Scope): Value {
  const r = evalRef(e, scope);
  return materialize(r, scope);
}

function materialize(r: Ref, scope: Scope): Value {
  if (isRootRef(r)) {
    if (r.root === FILE_REF) return new BFile(scope.row);
    if (r.root === NOTE_REF) return notePropertiesObject(scope.row, scope.env);
    if (r.root === THIS_REF) return scope.env.thisRow ? new BFile(scope.env.thisRow) : null;
    return null;
  }
  if (isThisFileRef(r)) return scope.env.thisRow ? new BFile(scope.env.thisRow) : null;
  return r as Value;
}

function evalRef(e: Expr, scope: Scope): Ref {
  tick(scope);
  switch (e.type) {
    case 'lit':
      return e.value;
    case 'regex':
      return makeRegex(e.source, e.flags);
    case 'list':
      return e.items.map((x) => evaluate(x, scope));
    case 'object': {
      const o: ValueObject = {};
      for (const en of e.entries) o[en.key] = evaluate(en.value, scope);
      return o;
    }
    case 'ident':
      return identifier(e.name, scope);
    case 'member':
      return member(evalRef(e.object, scope), e.name, scope);
    case 'index': {
      const obj = evalRef(e.object, scope);
      const idx = evaluate(e.index, scope);
      if (typeof idx === 'number' && !isRootRef(obj)) {
        const v = materialize(obj, scope);
        if (Array.isArray(v)) return v[idx < 0 ? v.length + idx : idx] ?? null;
        if (typeof v === 'string') return v[idx] ?? null;
        return null;
      }
      return member(obj, toText(idx), scope);
    }
    case 'unary': {
      const v = evaluate(e.arg, scope);
      if (e.op === '!') return !truthy(v);
      if (v === null) return null;
      if (typeof v === 'number') return -v;
      if (v instanceof BDuration) return new BDuration(-v.ms, -v.months);
      throw new BaseEvalError(`cannot negate a ${typeName(v)}`);
    }
    case 'binary':
      return binary(e, scope);
    case 'call':
      return call(e, scope);
  }
}

function identifier(name: string, scope: Scope): Ref {
  if (scope.locals && Object.prototype.hasOwnProperty.call(scope.locals, name)) return scope.locals[name];
  switch (name) {
    case 'file':
      return rootMarker(FILE_REF);
    case 'note':
      return rootMarker(NOTE_REF);
    case 'formula':
      return rootMarker(FORMULA_REF);
    case 'this':
      return rootMarker(THIS_REF);
    default:
      return noteProperty(scope, name);
  }
}

const FILE_FIELDS = new Set(['name', 'basename', 'path', 'folder', 'ext', 'size', 'properties', 'tags', 'links', 'embeds', 'backlinks', 'ctime', 'mtime', 'file']);

export function fileField(row: BaseRowData, name: string, env: EvalEnv): Value {
  const p = row.path;
  const slash = p.lastIndexOf('/');
  const fileName = p.slice(slash + 1);
  switch (name) {
    case 'name':
      return fileName;
    case 'basename':
      return basenameOf(p);
    case 'path':
      return p;
    case 'folder':
      return slash === -1 ? '/' : p.slice(0, slash);
    case 'ext': {
      const dot = fileName.lastIndexOf('.');
      return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
    }
    case 'size':
      return row.size;
    case 'properties':
      return notePropertiesObject(row, env);
    case 'tags':
      return [...row.tags];
    case 'links':
      return row.links.map((l) => new BLink(l));
    case 'embeds':
      return (row.embeds ?? []).map((l) => new BLink(l));
    case 'backlinks':
      return (row.backlinks ?? []).map((l) => new BLink(l));
    case 'ctime':
      return row.ctime === null ? (row.mtime === null ? null : new BDate(row.mtime, true)) : new BDate(row.ctime, true);
    case 'mtime':
      return row.mtime === null ? null : new BDate(row.mtime, true);
    case 'file':
      return new BFile(row);
    default:
      return null;
  }
}

function member(obj: Ref, name: string, scope: Scope): Ref {
  if (isRootRef(obj)) {
    if (obj.root === FILE_REF) return FILE_FIELDS.has(name) ? fileField(scope.row, name, scope.env) : null;
    if (obj.root === NOTE_REF) return noteProperty(scope, name);
    if (obj.root === FORMULA_REF) return evalFormula(scope, name);
    // this.file.x, this.<property>
    if (name === 'file') return thisFileMarker();
    const t = scope.env.thisRow;
    if (!t) return null;
    return Object.prototype.hasOwnProperty.call(t.properties, name) ? fromJson(t.properties[name], scope.env.dateKeys.has(name)) : null;
  }
  if (isThisFileRef(obj)) {
    const t = scope.env.thisRow;
    return t && FILE_FIELDS.has(name) ? fileField(t, name, scope.env) : null;
  }
  return valueMember(obj as Value, name, scope);
}

function valueMember(v: Value, name: string, scope: Scope): Value {
  if (v === null) return null;
  if (typeof v === 'string') return name === 'length' ? v.length : null;
  if (Array.isArray(v)) return name === 'length' ? v.length : null;
  if (v instanceof BDate) {
    const d = new Date(v.ms);
    switch (name) {
      case 'year':
        return d.getUTCFullYear();
      case 'month':
        return d.getUTCMonth() + 1;
      case 'day':
        return d.getUTCDate();
      case 'hour':
        return d.getUTCHours();
      case 'minute':
        return d.getUTCMinutes();
      case 'second':
        return d.getUTCSeconds();
      case 'millisecond':
        return d.getUTCMilliseconds();
      default:
        return null;
    }
  }
  if (v instanceof BFile) return FILE_FIELDS.has(name) ? fileField(v.row, name, scope.env) : (fromJson(v.row.properties[name], scope.env.dateKeys.has(name)) ?? null);
  if (v instanceof BLink) {
    if (name === 'display') return v.display ?? null;
    return null;
  }
  if (isPlainObject(v)) return Object.prototype.hasOwnProperty.call(v, name) ? v[name] : null;
  return null;
}

// ---------------------------------------------------------------------------
// operators
// ---------------------------------------------------------------------------

function asDuration(v: Value): BDuration | null {
  if (v instanceof BDuration) return v;
  if (typeof v === 'string') return parseDuration(v);
  return null;
}

function binary(e: Extract<Expr, { type: 'binary' }>, scope: Scope): Value {
  if (e.op === '&&') {
    const l = evaluate(e.left, scope);
    return truthy(l) ? truthy(evaluate(e.right, scope)) : false;
  }
  if (e.op === '||') {
    const l = evaluate(e.left, scope);
    return truthy(l) ? true : truthy(evaluate(e.right, scope));
  }
  const a = evaluate(e.left, scope);
  const b = evaluate(e.right, scope);
  switch (e.op) {
    case '==':
      return equals(a, b);
    case '!=':
      return !equals(a, b);
    case '<':
    case '>':
    case '<=':
    case '>=': {
      const c = compare(a, b);
      if (c === null) return false;
      return e.op === '<' ? c < 0 : e.op === '>' ? c > 0 : e.op === '<=' ? c <= 0 : c >= 0;
    }
    case '+':
      return add(a, b);
    case '-':
      return subtract(a, b);
    case '*':
    case '/':
    case '%':
      return multiplicative(e.op, a, b);
  }
  return null;
}

const MAX_TEXT = 100_000;

function capText(s: string): string {
  if (s.length > MAX_TEXT) throw new BaseEvalError('text too long');
  return s;
}

function add(a: Value, b: Value): Value {
  if (a instanceof BDate) {
    const d = asDuration(b);
    if (d) return addDuration(a, d, 1);
    if (b === null) return null;
    if (typeof b === 'number') return new BDate(a.ms + b, true);
    throw new BaseEvalError(`cannot add a ${typeName(b)} to a date`);
  }
  if (a instanceof BDuration) {
    if (b instanceof BDate) return addDuration(b, a, 1);
    const d = asDuration(b);
    if (d) return new BDuration(a.ms + d.ms, a.months + d.months);
  }
  if (typeof a === 'string' || typeof b === 'string') return capText(toText(a) + toText(b));
  if (a === null || b === null) return null;
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  throw new BaseEvalError(`cannot add a ${typeName(b)} to a ${typeName(a)}`);
}

function subtract(a: Value, b: Value): Value {
  if (a === null || b === null) return null;
  if (a instanceof BDate) {
    if (b instanceof BDate) return a.ms - b.ms;
    const d = asDuration(b);
    if (d) return addDuration(a, d, -1);
    if (typeof b === 'number') return new BDate(a.ms - b, true);
  }
  if (a instanceof BDuration) {
    const d = asDuration(b);
    if (d) return new BDuration(a.ms - d.ms, a.months - d.months);
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  throw new BaseEvalError(`cannot subtract a ${typeName(b)} from a ${typeName(a)}`);
}

function multiplicative(op: '*' | '/' | '%', a: Value, b: Value): Value {
  if (a === null || b === null) return null;
  if (a instanceof BDuration && typeof b === 'number') {
    if (op === '*') return new BDuration(a.ms * b, a.months * b);
    if (op === '/') return b === 0 ? null : new BDuration(a.ms / b, a.months / b);
  }
  if (typeof a === 'number' && typeof b === 'number') {
    if (op === '*') return a * b;
    if (b === 0) return null;
    return op === '/' ? a / b : a % b;
  }
  throw new BaseEvalError(`cannot use ${op} on a ${typeName(a)} and a ${typeName(b)}`);
}

// ---------------------------------------------------------------------------
// regular expressions
// ---------------------------------------------------------------------------

const MAX_REGEX_SOURCE = 200;
const MAX_REGEX_INPUT = 2000;

/** Refuses patterns that can backtrack exponentially: a quantified group that itself contains a quantifier, or a back-reference. */
export function isSafeRegex(source: string): boolean {
  if (source.length > MAX_REGEX_SOURCE) return false;
  if (/\\[1-9]|\\k</.test(source)) return false;
  // Strip escapes and character classes, then look for `( … [*+{] … )[*+{]`.
  const s = source.replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, 'x');
  const stack: boolean[] = [];
  let lastGroupHadQuantifier = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') stack.push(false);
    else if (c === ')') {
      lastGroupHadQuantifier = stack.pop() ?? false;
      const next = s[i + 1];
      if (lastGroupHadQuantifier && (next === '*' || next === '+' || next === '{')) return false;
      if (lastGroupHadQuantifier && stack.length) stack[stack.length - 1] = true;
    } else if (c === '*' || c === '+' || c === '{' || c === '?') {
      if (stack.length && c !== '?') stack[stack.length - 1] = true;
    }
  }
  return true;
}

function makeRegex(source: string, flags: string): RegExp {
  if (!isSafeRegex(source)) throw new BaseEvalError('this regular expression is not allowed (too long, nested quantifiers or back-references)');
  try {
    return new RegExp(source, flags.replace(/[^gimsuy]/g, ''));
  } catch {
    throw new BaseEvalError('invalid regular expression');
  }
}

const regexInput = (s: string) => (s.length > MAX_REGEX_INPUT ? s.slice(0, MAX_REGEX_INPUT) : s);

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

function args(e: Extract<Expr, { type: 'call' }>, scope: Scope): Value[] {
  return e.args.map((a) => evaluate(a, scope));
}

function num(v: Value, what: string): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  throw new BaseEvalError(`${what} must be a number`);
}

function toDate(v: Value): BDate | null {
  if (v === null) return null;
  if (v instanceof BDate) return v;
  if (typeof v === 'number') return new BDate(v, true);
  if (typeof v === 'string') {
    const d = parseDateText(v);
    if (!d) throw new BaseEvalError(`not a date: ${JSON.stringify(v)}`);
    return d;
  }
  throw new BaseEvalError(`not a date: ${typeName(v)}`);
}

function toTargetText(v: Value): string | null {
  if (v === null) return null;
  if (v instanceof BLink) return v.path;
  if (v instanceof BFile) return v.row.path;
  if (typeof v === 'string') return parseWikilinkText(v)?.path ?? v;
  return toText(v);
}

function fileOf(v: Value, scope: Scope): BaseRowData | null {
  if (v instanceof BFile) return v.row;
  const target = toTargetText(v);
  return target === null ? null : scope.env.lookupFile(target);
}

/** `file.hasTag("a")`: the file has tag `a` or a nested `a/…` (case-insensitive, leading `#` ignored). */
export function rowHasTag(row: BaseRowData, tags: Value[]): boolean {
  for (const t of tags) {
    const want = toText(t).trim().replace(/^#+/, '').toLowerCase();
    if (!want) continue;
    if (row.tags.some((have) => have === want || have.startsWith(`${want}/`))) return true;
  }
  return false;
}

/** `file.inFolder("a/b")`: the file is in `a/b` or below it. `""` and `"/"` are the whole space. */
export function rowInFolder(row: BaseRowData, folder: Value): boolean {
  const f = toText(folder).trim().replace(/^\/+|\/+$/g, '');
  if (f === '') return true;
  return row.path.toLowerCase().startsWith(`${f.toLowerCase()}/`);
}

function rowHasLink(row: BaseRowData, target: Value): boolean {
  if (target instanceof BFile && row.linkIds?.includes(target.row.id)) return true;
  const t = toTargetText(target);
  if (t === null || t === '') return false;
  return row.links.some((l) => sameTarget(l, t));
}

function callGlobal(name: string, e: Extract<Expr, { type: 'call' }>, scope: Scope): Value {
  switch (name) {
    case 'if': {
      if (e.args.length < 2) throw new BaseEvalError('if() needs a condition and a value');
      return truthy(evaluate(e.args[0], scope)) ? evaluate(e.args[1], scope) : e.args[2] ? evaluate(e.args[2], scope) : null;
    }
    case 'now':
      return new BDate(scope.env.nowMs, true);
    case 'today': {
      const d = new Date(scope.env.nowMs);
      return new BDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), false);
    }
    case 'date': {
      const [v] = args(e, scope);
      return toDate(v ?? null);
    }
    case 'duration': {
      const [v] = args(e, scope);
      if (v instanceof BDuration) return v;
      const d = typeof v === 'string' ? parseDuration(v) : null;
      if (!d) throw new BaseEvalError(`not a duration: ${JSON.stringify(v)}`);
      return d;
    }
    case 'number': {
      const [v] = args(e, scope);
      if (v === null || v === undefined) return null;
      if (typeof v === 'number') return v;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (v instanceof BDate) return v.ms;
      if (v instanceof BDuration) return v.ms + v.months * 30 * 86_400_000;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      throw new BaseEvalError(`not a number: ${JSON.stringify(toText(v))}`);
    }
    case 'list': {
      const [v] = args(e, scope);
      if (v === undefined || v === null) return [];
      return Array.isArray(v) ? v : [v];
    }
    case 'max':
    case 'min': {
      const nums = args(e, scope).flat().filter((x): x is number => typeof x === 'number');
      if (nums.length === 0) return null;
      return name === 'max' ? Math.max(...nums) : Math.min(...nums);
    }
    case 'link': {
      const [p, display] = args(e, scope);
      if (p === null || p === undefined) return null;
      const target = p instanceof BFile ? p.row.path : (toTargetText(p) ?? '');
      return new BLink(target, display === undefined || display === null ? undefined : toText(display));
    }
    case 'file': {
      const [p] = args(e, scope);
      const row = fileOf(p ?? null, scope);
      return row ? new BFile(row) : null;
    }
    case 'escapeHTML': {
      const [s] = args(e, scope);
      return toText(s ?? null).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    case 'random':
      return (scope.env.random ?? Math.random)();
    case 'taggedWith': {
      const [f, ...tags] = args(e, scope);
      const row = f instanceof BFile ? f.row : scope.row;
      return rowHasTag(row, tags);
    }
    case 'inFolder': {
      const [f, folder] = args(e, scope);
      const row = f instanceof BFile ? f.row : scope.row;
      return rowInFolder(row, folder ?? null);
    }
    case 'linksTo': {
      const [f, target] = args(e, scope);
      const row = f instanceof BFile ? f.row : fileOf(f ?? null, scope);
      return row ? rowHasLink(row, target ?? null) : false;
    }
  }
  throw new BaseUnsupportedError(`${name}()`);
}

/** `list.filter(value > 2)`, `list.map(value + 1)`, `list.reduce(acc + value, 0)`: the argument is evaluated per item. */
function lambda(e: Expr, scope: Scope, locals: Record<string, Value>): Value {
  return evaluate(e, { ...scope, locals: { ...(scope.locals ?? {}), ...locals } });
}

const MAX_LIST = 100_000;

function stats(list: Value[]): number[] {
  return list.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
}

function callMethod(receiver: Ref, name: string, e: Extract<Expr, { type: 'call' }>, scope: Scope): Value {
  // file.hasTag(...) etc. on the row itself.
  if (isRootRef(receiver) && receiver.root === FILE_REF) return fileMethod(scope.row, name, e, scope);
  if (isThisFileRef(receiver) || (isRootRef(receiver) && receiver.root === THIS_REF)) {
    const t = scope.env.thisRow;
    if (!t) return null;
    return fileMethod(t, name, e, scope);
  }
  const v = materialize(receiver, scope);
  if (v instanceof BFile) return fileMethod(v.row, name, e, scope);

  // Any type.
  switch (name) {
    case 'isTruthy':
      return truthy(v);
    case 'isType': {
      const [t] = args(e, scope);
      const want = toText(t ?? null).toLowerCase();
      const have = typeName(v);
      return want === have || (want === 'list' && have === 'list') || (want === 'array' && have === 'list');
    }
    case 'toString':
      return toText(v);
    case 'isEmpty':
      return v instanceof BDate ? false : isEmptyValue(v);
  }
  if (v === null) {
    // A missing property: empty, not an error.
    if (['contains', 'containsAll', 'containsAny', 'startsWith', 'endsWith', 'matches', 'hasTag', 'hasLink', 'hasProperty', 'inFolder', 'linksTo'].includes(name)) return false;
    if (KNOWN_METHODS.has(name)) return null;
    throw new BaseUnsupportedError(`.${name}()`);
  }

  if (typeof v === 'string') return stringMethod(v, name, e, scope);
  if (typeof v === 'number') return numberMethod(v, name, e, scope);
  if (v instanceof BDate) return dateMethod(v, name, e, scope);
  if (Array.isArray(v)) return listMethod(v, name, e, scope);
  if (v instanceof BLink) {
    if (name === 'asFile') {
      const row = scope.env.lookupFile(v.path);
      return row ? new BFile(row) : null;
    }
    if (name === 'linksTo') {
      const row = scope.env.lookupFile(v.path);
      const [target] = args(e, scope);
      return row ? rowHasLink(row, target ?? null) : false;
    }
    // A link used like its text (`author.contains("Ada")`).
    return stringMethod(toText(v), name, e, scope);
  }
  if (v instanceof RegExp) {
    if (name === 'matches') {
      const [s] = args(e, scope);
      v.lastIndex = 0;
      return v.test(regexInput(toText(s ?? null)));
    }
  }
  if (isPlainObject(v)) {
    if (name === 'keys') return Object.keys(v);
    if (name === 'values') return Object.values(v);
  }
  if (typeof v === 'boolean' || v instanceof BDuration) {
    if (KNOWN_METHODS.has(name)) throw new BaseEvalError(`.${name}() does not apply to a ${typeName(v)}`);
  }
  if (KNOWN_METHODS.has(name)) throw new BaseEvalError(`.${name}() does not apply to a ${typeName(v)}`);
  throw new BaseUnsupportedError(`.${name}()`);
}

function fileMethod(row: BaseRowData, name: string, e: Extract<Expr, { type: 'call' }>, scope: Scope): Value {
  switch (name) {
    case 'hasTag':
      return rowHasTag(row, args(e, scope));
    case 'inFolder': {
      const [f] = args(e, scope);
      return rowInFolder(row, f ?? null);
    }
    case 'hasLink': {
      const [t] = args(e, scope);
      return rowHasLink(row, t ?? null);
    }
    case 'hasProperty': {
      const [k] = args(e, scope);
      return Object.prototype.hasOwnProperty.call(row.properties, toText(k ?? null));
    }
    case 'asLink': {
      const [display] = args(e, scope);
      return new BLink(row.path, display === undefined || display === null ? undefined : toText(display));
    }
    case 'isEmpty':
      return false;
    case 'isTruthy':
      return true;
    case 'toString':
      return basenameOf(row.path);
  }
  if (KNOWN_METHODS.has(name)) throw new BaseEvalError(`.${name}() does not apply to a file`);
  throw new BaseUnsupportedError(`.${name}()`);
}

function stringMethod(s: string, name: string, e: Extract<Expr, { type: 'call' }>, scope: Scope): Value {
  const a = () => args(e, scope);
  switch (name) {
    case 'contains': {
      const [x] = a();
      return s.includes(toText(x ?? null));
    }
    case 'containsAll':
      return a().every((x) => s.includes(toText(x)));
    case 'containsAny':
      return a().some((x) => s.includes(toText(x)));
    case 'endsWith': {
      const [x] = a();
      return s.endsWith(toText(x ?? null));
    }
    case 'startsWith': {
      const [x] = a();
      return s.startsWith(toText(x ?? null));
    }
    case 'lower':
      return s.toLowerCase();
    case 'title':
      return s.replace(/\p{L}[\p{L}\p{N}'’]*/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    case 'trim':
      return s.trim();
    case 'reverse':
      return [...s].reverse().join('');
    case 'repeat': {
      const [n] = a();
      const count = Math.max(0, Math.floor(num(n ?? null, 'repeat count')));
      if (s.length * count > MAX_TEXT) throw new BaseEvalError('text too long');
      return s.repeat(count);
    }
    case 'slice': {
      const [start, end] = a();
      return s.slice(num(start ?? 0, 'start'), end === undefined || end === null ? undefined : num(end, 'end'));
    }
    case 'split': {
      const [sep, n] = a();
      const limit = n === undefined || n === null ? undefined : Math.max(0, Math.floor(num(n, 'count')));
      const parts = sep instanceof RegExp ? regexInput(s).split(sep, limit) : s.split(toText(sep ?? null), limit);
      return parts;
    }
    case 'replace': {
      const [pattern, replacement] = a();
      const rep = toText(replacement ?? null);
      if (pattern instanceof RegExp) return regexInput(s).replace(pattern, rep);
      return s.split(toText(pattern ?? null)).join(rep);
    }
  }
  if (KNOWN_METHODS.has(name)) throw new BaseEvalError(`.${name}() does not apply to text`);
  throw new BaseUnsupportedError(`.${name}()`);
}

function numberMethod(n: number, name: string, e: Extract<Expr, { type: 'call' }>, scope: Scope): Value {
  switch (name) {
    case 'abs':
      return Math.abs(n);
    case 'ceil':
      return Math.ceil(n);
    case 'floor':
      return Math.floor(n);
    case 'round': {
      const [d] = args(e, scope);
      const digits = d === undefined || d === null ? 0 : Math.max(0, Math.min(15, Math.floor(num(d, 'digits'))));
      const f = 10 ** digits;
      return Math.round((n + Number.EPSILON) * f) / f;
    }
    case 'toFixed': {
      const [d] = args(e, scope);
      const digits = d === undefined || d === null ? 0 : Math.max(0, Math.min(20, Math.floor(num(d, 'precision'))));
      return n.toFixed(digits);
    }
  }
  if (KNOWN_METHODS.has(name)) throw new BaseEvalError(`.${name}() does not apply to a number`);
  throw new BaseUnsupportedError(`.${name}()`);
}

function dateMethod(d: BDate, name: string, e: Extract<Expr, { type: 'call' }>, scope: Scope): Value {
  switch (name) {
    case 'date': {
      const x = new Date(d.ms);
      return new BDate(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()), false);
    }
    case 'format': {
      const [f] = args(e, scope);
      return formatDate(d, toText(f ?? 'YYYY-MM-DD') || 'YYYY-MM-DD');
    }
    case 'time':
      return formatDate(d, 'HH:mm:ss');
    case 'relative':
      return relativeText(d, scope.env.nowMs);
  }
  if (KNOWN_METHODS.has(name)) throw new BaseEvalError(`.${name}() does not apply to a date`);
  throw new BaseUnsupportedError(`.${name}()`);
}

function listMethod(list: Value[], name: string, e: Extract<Expr, { type: 'call' }>, scope: Scope): Value {
  switch (name) {
    case 'contains': {
      const [x] = args(e, scope);
      return list.some((item) => equals(item, x ?? null));
    }
    case 'containsAll': {
      const xs = args(e, scope);
      return xs.every((x) => list.some((item) => equals(item, x)));
    }
    case 'containsAny': {
      const xs = args(e, scope);
      return xs.some((x) => list.some((item) => equals(item, x)));
    }
    case 'filter': {
      const [arg] = e.args;
      if (!arg) return list;
      return list.filter((value, index) => truthy(lambda(arg, scope, { value, index })));
    }
    case 'map': {
      const [arg] = e.args;
      if (!arg) return list;
      return list.map((value, index) => lambda(arg, scope, { value, index }));
    }
    case 'reduce': {
      const [arg, init] = e.args;
      if (!arg) return null;
      let acc: Value = init ? evaluate(init, scope) : null;
      list.forEach((value, index) => {
        acc = lambda(arg, scope, { value, index, acc });
      });
      return acc;
    }
    case 'flat': {
      const out: Value[] = [];
      const walk = (xs: Value[], depth: number) => {
        for (const x of xs) {
          if (out.length > MAX_LIST) throw new BaseEvalError('list too long');
          if (Array.isArray(x) && depth < 32) walk(x, depth + 1);
          else out.push(x);
        }
      };
      walk(list, 0);
      return out;
    }
    case 'join': {
      const [sep] = args(e, scope);
      return capText(list.map(toText).join(sep === undefined || sep === null ? ',' : toText(sep)));
    }
    case 'reverse':
      return [...list].reverse();
    case 'slice': {
      const [start, end] = args(e, scope);
      return list.slice(num(start ?? 0, 'start'), end === undefined || end === null ? undefined : num(end, 'end'));
    }
    case 'sort':
      return [...list].sort(sortCompare);
    case 'unique': {
      const out: Value[] = [];
      for (const x of list) if (!out.some((y) => equals(x, y))) out.push(x);
      return out;
    }
    case 'sum': {
      const xs = stats(list);
      return xs.length ? xs.reduce((s, x) => s + x, 0) : null;
    }
    case 'mean': {
      const xs = stats(list);
      return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
    }
    case 'median': {
      const xs = stats(list).sort((x, y) => x - y);
      if (!xs.length) return null;
      const mid = Math.floor(xs.length / 2);
      return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
    }
    case 'stddev': {
      const xs = stats(list);
      if (!xs.length) return null;
      const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
      return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
    }
    case 'min':
    case 'max': {
      const xs = stats(list);
      if (!xs.length) return null;
      return name === 'min' ? Math.min(...xs) : Math.max(...xs);
    }
  }
  if (KNOWN_METHODS.has(name)) throw new BaseEvalError(`.${name}() does not apply to a list`);
  throw new BaseUnsupportedError(`.${name}()`);
}

function call(e: Extract<Expr, { type: 'call' }>, scope: Scope): Value {
  if (e.callee.type === 'ident') {
    const name = e.callee.name;
    if (UNSUPPORTED_GLOBALS.has(name)) throw new BaseUnsupportedError(`${name}()`);
    return callGlobal(name, e, scope);
  }
  if (e.callee.type === 'member') {
    const receiver = evalRef(e.callee.object, scope);
    return callMethod(receiver, e.callee.name, e, scope);
  }
  throw new BaseEvalError('this is not a function');
}

// ---------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------

export interface RowEvaluator {
  /** Evaluates an expression text for the row. Throws ExprSyntaxError / BaseEvalError / BaseUnsupportedError / BaseBudgetError. */
  eval(src: string): Value;
  evalExpr(e: Expr): Value;
  /** A property id (`status`, `note.x`, `file.name`, `formula.y`) for the row. */
  property(id: string): Value;
}

/** One evaluator per row: formula values are memoized for the row. */
export function rowEvaluator(row: BaseRowData, env: EvalEnv, locals?: Record<string, Value>): RowEvaluator {
  const scope: Scope = { row, env, formulaMemo: new Map(), formulaStack: new Set(), locals };
  return {
    eval: (src) => evaluate(parseExpr(src), scope),
    evalExpr: (e) => evaluate(e, scope),
    property(id) {
      if (id.startsWith('file.')) {
        const name = id.slice(5);
        return FILE_FIELDS.has(name) ? fileField(row, name, env) : null;
      }
      if (id.startsWith('formula.')) return evalFormula(scope, id.slice(8));
      return noteProperty(scope, id.startsWith('note.') ? id.slice(5) : id);
    },
  };
}

/** A summary formula over `values` (the column's values across the result). */
export function evalSummaryFormula(src: string, values: Value[], env: EvalEnv): Value {
  const dummy: BaseRowData = { id: '', path: '', title: '', kind: '', size: null, mtime: null, ctime: null, properties: {}, tags: [], links: [] };
  return evaluate(parseExpr(src), { row: dummy, env, formulaMemo: new Map(), formulaStack: new Set(), locals: { values } });
}
