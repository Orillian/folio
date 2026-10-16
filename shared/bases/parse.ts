/**
 * `.base` YAML → BaseConfig. A file that is not YAML, or whose top level is not
 * a mapping, is an error (shown as a readable error page). Anything inside that
 * does not have the expected shape is skipped with a warning, never fatal: a
 * view without a `type` is a table, without a `name` it is "View N", a filter of
 * an unknown shape is ignored.
 *
 * The CORE schema: no YAML timestamps (a `groupOrder` value `2024-01-01` stays
 * text) — the file's values are what Obsidian wrote, read as written.
 */
import * as yamlNS from 'js-yaml';
import type { BaseConfig, BaseFilter, BaseGroupBy, BaseSort, BaseView } from './types.js';
import { BASE_MAX_BYTES } from './types.js';

// js-yaml is CommonJS; under the bundler and under tsx its namespace may arrive as `default`.
const yaml = ((yamlNS as unknown as { default?: typeof yamlNS }).default ?? yamlNS) as typeof yamlNS;

export interface BaseParseResult {
  config: BaseConfig | null;
  error?: { message: string; line?: number };
  warnings: string[];
}

export function emptyBaseConfig(): BaseConfig {
  return { formulas: {}, properties: {}, summaries: {}, views: [] };
}

/** The YAML as a plain object (or a parse error), the CORE schema. */
export function loadBaseYaml(text: string): { data: unknown } | { error: { message: string; line?: number } } {
  if (text.length > BASE_MAX_BYTES) return { error: { message: `The base file is too large (over ${BASE_MAX_BYTES / 1024} KB).` } };
  try {
    return { data: yaml.load(text, { schema: yaml.CORE_SCHEMA, json: true }) ?? {} };
  } catch (err) {
    const e = err as { reason?: string; message?: string; mark?: { line?: number } };
    const line = typeof e.mark?.line === 'number' ? e.mark.line + 1 : undefined;
    return { error: { message: `The base file is not valid YAML: ${e.reason ?? e.message ?? 'parse error'}`, line } };
  }
}

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A filter as written → BaseFilter, or undefined (with a warning) when its shape is not one. */
export function readFilter(raw: unknown, where: string, warnings: string[]): BaseFilter | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (isMap(raw)) {
    const keys = Object.keys(raw);
    const op = keys.find((k) => k === 'and' || k === 'or' || k === 'not');
    if (!op || keys.length !== 1) {
      warnings.push(`${where}: a filter group needs exactly one of and / or / not — ignored.`);
      return undefined;
    }
    const list = raw[op];
    const items = Array.isArray(list) ? list : list === null || list === undefined ? [] : [list];
    const out: BaseFilter[] = [];
    items.forEach((item, i) => {
      const f = readFilter(item, `${where}.${op}[${i}]`, warnings);
      if (f !== undefined) out.push(f);
    });
    return op === 'and' ? { and: out } : op === 'or' ? { or: out } : { not: out };
  }
  warnings.push(`${where}: not a filter — ignored.`);
  return undefined;
}

function readDirection(raw: unknown): 'ASC' | 'DESC' {
  return typeof raw === 'string' && raw.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
}

function readStringMap(raw: unknown, where: string, warnings: string[]): Record<string, string> {
  if (raw === null || raw === undefined) return {};
  if (!isMap(raw)) {
    warnings.push(`${where}: not a mapping — ignored.`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    else warnings.push(`${where}.${k}: not text — ignored.`);
  }
  return out;
}

function readView(raw: unknown, i: number, warnings: string[]): BaseView | null {
  if (!isMap(raw)) {
    warnings.push(`views[${i}]: not a view — ignored.`);
    return null;
  }
  const view: BaseView = { ...raw, type: typeof raw.type === 'string' && raw.type ? raw.type : 'table', name: '' };
  view.name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : typeof raw.name === 'number' ? String(raw.name) : `View ${i + 1}`;
  const filters = readFilter(raw.filters, `views[${i}].filters`, warnings);
  if (filters === undefined) delete view.filters;
  else view.filters = filters;
  if (raw.order !== undefined) {
    if (Array.isArray(raw.order)) view.order = raw.order.filter((x): x is string => typeof x === 'string' && x !== '');
    else {
      warnings.push(`views[${i}].order: not a list — ignored.`);
      delete view.order;
    }
  }
  if (raw.sort !== undefined) {
    const list = Array.isArray(raw.sort) ? raw.sort : [raw.sort];
    const sort: BaseSort[] = [];
    for (const s of list) {
      if (isMap(s) && typeof s.property === 'string' && s.property) sort.push({ property: s.property, direction: readDirection(s.direction) });
      else if (typeof s === 'string' && s) sort.push({ property: s, direction: 'ASC' });
    }
    view.sort = sort;
  }
  if (raw.groupBy !== undefined) {
    const g = raw.groupBy;
    let groupBy: BaseGroupBy | undefined;
    if (isMap(g) && typeof g.property === 'string' && g.property) groupBy = { property: g.property, direction: readDirection(g.direction) };
    else if (typeof g === 'string' && g) groupBy = { property: g, direction: 'ASC' };
    if (groupBy) view.groupBy = groupBy;
    else {
      if (g !== null) warnings.push(`views[${i}].groupBy: needs a property — ignored.`);
      delete view.groupBy;
    }
  }
  if (raw.groupOrder !== undefined) {
    if (Array.isArray(raw.groupOrder)) {
      view.groupOrder = raw.groupOrder.filter((x): x is string | number | boolean | null => x === null || ['string', 'number', 'boolean'].includes(typeof x));
    } else delete view.groupOrder;
  }
  if (raw.summaries !== undefined) {
    const s = readStringMap(raw.summaries, `views[${i}].summaries`, warnings);
    view.summaries = s;
  }
  if (raw.limit !== undefined) {
    const n = typeof raw.limit === 'number' ? raw.limit : typeof raw.limit === 'string' ? Number(raw.limit) : NaN;
    if (Number.isFinite(n) && n > 0) view.limit = Math.floor(n);
    else delete view.limit;
  }
  if (raw.image !== undefined && typeof raw.image !== 'string') delete view.image;
  return view;
}

export function parseBaseConfig(text: string): BaseParseResult {
  const warnings: string[] = [];
  const loaded = loadBaseYaml(text);
  if ('error' in loaded) return { config: null, error: loaded.error, warnings };
  const data = loaded.data;
  if (!isMap(data)) return { config: null, error: { message: 'The base file must be a YAML mapping (filters, formulas, properties, summaries, views).' }, warnings };
  const config = emptyBaseConfig();
  const filters = readFilter(data.filters, 'filters', warnings);
  if (filters !== undefined) config.filters = filters;
  config.formulas = readStringMap(data.formulas, 'formulas', warnings);
  config.summaries = readStringMap(data.summaries, 'summaries', warnings);
  if (data.properties !== undefined && data.properties !== null) {
    if (isMap(data.properties)) {
      for (const [k, v] of Object.entries(data.properties)) {
        if (isMap(v)) config.properties[k] = { ...v, ...(typeof v.displayName === 'string' ? { displayName: v.displayName } : {}) };
      }
    } else warnings.push('properties: not a mapping — ignored.');
  }
  if (data.views !== undefined && data.views !== null) {
    if (Array.isArray(data.views)) {
      data.views.forEach((v, i) => {
        const view = readView(v, i, warnings);
        if (view) config.views.push(view);
      });
    } else warnings.push('views: not a list — ignored.');
  }
  return { config, warnings };
}
