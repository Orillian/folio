/**
 * The visual filter editor's model: a filter statement ↔ { property, operator,
 * value }. A statement the editor cannot draw (any other expression) stays a
 * "raw" node, edited as text — never rewritten by the editor. Groups are
 * Obsidian's and / or / not ("all / any / none of the following are true").
 */
import { parseExpr, propertyRef, quoteString, type Expr } from './expr.js';
import type { BaseFilter } from './types.js';

export const FILTER_OPS = [
  'is',
  'isNot',
  'gt',
  'lt',
  'gte',
  'lte',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'isEmpty',
  'isNotEmpty',
  'hasTag',
  'notHasTag',
  'inFolder',
  'notInFolder',
  'hasLink',
  'hasProperty',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Operators that take no value. */
export const VALUELESS_OPS: ReadonlySet<FilterOp> = new Set(['isEmpty', 'isNotEmpty', 'hasProperty']);
/** Operators about the file, not a property (the property field is fixed). */
export const FILE_OPS: ReadonlySet<FilterOp> = new Set(['hasTag', 'notHasTag', 'inFolder', 'notInFolder', 'hasLink']);

export type FilterValueType = 'text' | 'number' | 'date' | 'bool';

export interface FilterRule {
  /** A property id (`status`, `file.ext`, `formula.x`); for hasProperty the property's name; ignored by the FILE_OPS. */
  property: string;
  op: FilterOp;
  value: string;
  valueType: FilterValueType;
}

export type FilterNode =
  | { kind: 'rule'; rule: FilterRule }
  | { kind: 'raw'; text: string }
  | { kind: 'group'; op: 'and' | 'or' | 'not'; items: FilterNode[] };

function propertyIdOf(e: Expr): string | null {
  if (e.type === 'ident') return ['file', 'note', 'formula', 'this', 'true', 'false', 'null'].includes(e.name) ? null : e.name;
  if (e.type === 'member' && e.object.type === 'ident') {
    if (e.object.name === 'note') return `note.${e.name}`;
    if (e.object.name === 'file') return `file.${e.name}`;
    if (e.object.name === 'formula') return `formula.${e.name}`;
  }
  if (e.type === 'index' && e.object.type === 'ident' && e.index.type === 'lit' && typeof e.index.value === 'string') {
    if (e.object.name === 'note') return `note.${e.index.value}`;
    if (e.object.name === 'file') return `file.${e.index.value}`;
    if (e.object.name === 'formula') return `formula.${e.index.value}`;
  }
  return null;
}

function literalOf(e: Expr): { value: string; valueType: FilterValueType } | null {
  if (e.type === 'lit') {
    if (typeof e.value === 'string') return { value: e.value, valueType: 'text' };
    if (typeof e.value === 'number') return { value: String(e.value), valueType: 'number' };
    if (typeof e.value === 'boolean') return { value: String(e.value), valueType: 'bool' };
    return null;
  }
  if (e.type === 'call' && e.callee.type === 'ident' && e.callee.name === 'date' && e.args.length === 1 && e.args[0].type === 'lit' && typeof e.args[0].value === 'string') {
    return { value: e.args[0].value, valueType: 'date' };
  }
  return null;
}

const COMPARE_OPS: Record<string, FilterOp> = { '==': 'is', '!=': 'isNot', '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte' };

function ruleOf(e: Expr, negated: boolean): FilterRule | null {
  if (e.type === 'unary' && e.op === '!') return negated ? null : ruleOf(e.arg, true);
  if (e.type === 'call' && e.callee.type === 'member') {
    const method = e.callee.name;
    const target = e.callee.object;
    const isFile = target.type === 'ident' && target.name === 'file';
    const arg = e.args.length === 1 ? literalOf(e.args[0]) : null;
    if (isFile) {
      if (method === 'hasTag' && arg && e.args.length === 1) return { property: 'file.tags', op: negated ? 'notHasTag' : 'hasTag', value: arg.value, valueType: 'text' };
      if (method === 'inFolder' && arg) return { property: 'file.folder', op: negated ? 'notInFolder' : 'inFolder', value: arg.value, valueType: 'text' };
      if (method === 'hasLink' && arg && !negated) return { property: 'file.links', op: 'hasLink', value: arg.value, valueType: 'text' };
      if (method === 'hasProperty' && arg && !negated) return { property: arg.value, op: 'hasProperty', value: '', valueType: 'text' };
      return null;
    }
    const prop = propertyIdOf(target);
    if (!prop) return null;
    if (method === 'isEmpty' && e.args.length === 0) return { property: prop, op: negated ? 'isNotEmpty' : 'isEmpty', value: '', valueType: 'text' };
    if (method === 'contains' && arg) return { property: prop, op: negated ? 'notContains' : 'contains', ...arg };
    if (!negated && method === 'startsWith' && arg) return { property: prop, op: 'startsWith', ...arg };
    if (!negated && method === 'endsWith' && arg) return { property: prop, op: 'endsWith', ...arg };
    return null;
  }
  if (!negated && e.type === 'binary' && COMPARE_OPS[e.op]) {
    const prop = propertyIdOf(e.left);
    const lit = literalOf(e.right);
    if (prop && lit) return { property: prop, op: COMPARE_OPS[e.op], ...lit };
  }
  return null;
}

/** A statement → a rule the editor can draw, or a raw node. */
export function parseStatement(src: string): FilterNode {
  try {
    const rule = ruleOf(parseExpr(src), false);
    return rule ? { kind: 'rule', rule } : { kind: 'raw', text: src };
  } catch {
    return { kind: 'raw', text: src };
  }
}

function valueText(rule: FilterRule): string {
  switch (rule.valueType) {
    case 'number': {
      const n = Number(rule.value);
      return rule.value.trim() !== '' && Number.isFinite(n) ? String(n) : quoteString(rule.value);
    }
    case 'bool':
      return rule.value === 'true' ? 'true' : 'false';
    case 'date':
      return `date(${quoteString(rule.value)})`;
    default:
      return quoteString(rule.value);
  }
}

/** A rule → its statement text (Obsidian syntax). */
export function printRule(rule: FilterRule): string {
  const ref = propertyRef(rule.property || 'file.name');
  const v = valueText(rule);
  switch (rule.op) {
    case 'is':
      return `${ref} == ${v}`;
    case 'isNot':
      return `${ref} != ${v}`;
    case 'gt':
      return `${ref} > ${v}`;
    case 'lt':
      return `${ref} < ${v}`;
    case 'gte':
      return `${ref} >= ${v}`;
    case 'lte':
      return `${ref} <= ${v}`;
    case 'contains':
      return `${ref}.contains(${v})`;
    case 'notContains':
      return `!${ref}.contains(${v})`;
    case 'startsWith':
      return `${ref}.startsWith(${v})`;
    case 'endsWith':
      return `${ref}.endsWith(${v})`;
    case 'isEmpty':
      return `${ref}.isEmpty()`;
    case 'isNotEmpty':
      return `!${ref}.isEmpty()`;
    case 'hasTag':
      return `file.hasTag(${quoteString(rule.value.replace(/^#+/, ''))})`;
    case 'notHasTag':
      return `!file.hasTag(${quoteString(rule.value.replace(/^#+/, ''))})`;
    case 'inFolder':
      return `file.inFolder(${quoteString(rule.value)})`;
    case 'notInFolder':
      return `!file.inFolder(${quoteString(rule.value)})`;
    case 'hasLink':
      return `file.hasLink(${quoteString(rule.value)})`;
    case 'hasProperty':
      return `file.hasProperty(${quoteString(rule.property)})`;
  }
}

/** A filter as written → the editor's tree (a lone statement becomes an `and` group of one). */
export function toFilterNode(f: BaseFilter | undefined): FilterNode {
  if (f === undefined) return { kind: 'group', op: 'and', items: [] };
  if (typeof f === 'string') return { kind: 'group', op: 'and', items: [parseStatement(f)] };
  return groupOf(f);
}

function groupOf(f: Exclude<BaseFilter, string>): FilterNode & { kind: 'group' } {
  const op = 'and' in f ? 'and' : 'or' in f ? 'or' : 'not';
  const list = (f as Record<string, BaseFilter[]>)[op] ?? [];
  return { kind: 'group', op, items: list.map((x) => (typeof x === 'string' ? parseStatement(x) : groupOf(x))) };
}

/** The editor's tree → a filter to write; an empty root group → undefined (no `filters:` key). Empty statements are dropped. */
export function fromFilterNode(node: FilterNode, root = true): BaseFilter | undefined {
  if (node.kind === 'rule') return printRule(node.rule);
  if (node.kind === 'raw') return node.text.trim() === '' ? undefined : node.text.trim();
  const items = node.items.map((x) => fromFilterNode(x, false)).filter((x): x is BaseFilter => x !== undefined);
  if (items.length === 0 && root) return undefined;
  if (items.length === 0) return undefined;
  return node.op === 'and' ? { and: items } : node.op === 'or' ? { or: items } : { not: items };
}
