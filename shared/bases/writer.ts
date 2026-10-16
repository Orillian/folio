/**
 * Writes an edited BaseConfig back into a `.base` file, keeping what it did not
 * change. The file is split into top-level blocks (`filters:`, `views:`, …,
 * each with the comment lines above it); a block whose value is unchanged is
 * kept byte for byte, comments included. A changed block is re-written by
 * js-yaml in Obsidian's style (2-space indent, block lists, single quotes when
 * quoting is needed). Inside `views:` the same is done per view: an unchanged
 * view keeps its text, a changed one is re-written. Top-level keys Folio does
 * not know, and unknown keys of a view, are kept (they ride along in the config).
 *
 * What YAML does not let us keep: comments INSIDE a block that changed.
 */
import * as yamlNS from 'js-yaml';
import type { BaseConfig, BaseFilter, BaseView } from './types.js';
import { loadBaseYaml } from './parse.js';

const yaml = ((yamlNS as unknown as { default?: typeof yamlNS }).default ?? yamlNS) as typeof yamlNS;

const DUMP_OPTIONS: yamlNS.DumpOptions = { indent: 2, lineWidth: -1, noRefs: true, schema: yaml.CORE_SCHEMA };

function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      return Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, (x as Record<string, unknown>)[k]]));
    }
    return x;
  });
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** The view as it is written: keys in Obsidian's order first, then the rest as they came. Empty optional keys left out. */
export function viewToYaml(view: BaseView): Record<string, unknown> {
  const out: Record<string, unknown> = { type: view.type, name: view.name };
  const put = (key: string, value: unknown) => {
    if (value === undefined) return;
    if (Array.isArray(value) && value.length === 0 && key !== 'groupOrder') return;
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return;
    out[key] = value;
  };
  put('filters', view.filters);
  put('order', view.order);
  put('sort', view.sort);
  put('groupBy', view.groupBy);
  put('groupOrder', view.groupOrder);
  put('summaries', view.summaries);
  put('limit', view.limit);
  for (const [k, v] of Object.entries(view)) {
    if (!(k in out) && !['type', 'name', 'filters', 'order', 'sort', 'groupBy', 'groupOrder', 'summaries', 'limit'].includes(k)) put(k, v);
  }
  return out;
}

function filterToYaml(f: BaseFilter | undefined): unknown {
  return f;
}

/** The config as the YAML object Folio writes (top-level keys in Obsidian's order, empty sections left out). */
export function configToYaml(config: BaseConfig, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (config.filters !== undefined) out.filters = filterToYaml(config.filters);
  if (Object.keys(config.formulas).length) out.formulas = config.formulas;
  if (Object.keys(config.properties).length) out.properties = config.properties;
  if (Object.keys(config.summaries).length) out.summaries = config.summaries;
  for (const [k, v] of Object.entries(extra)) if (!['filters', 'formulas', 'properties', 'summaries', 'views'].includes(k)) out[k] = v;
  if (config.views.length) out.views = config.views.map(viewToYaml);
  return out;
}

/** A fresh file for a config (no original to preserve). */
export function serializeBaseConfig(config: BaseConfig): string {
  const obj = configToYaml(config);
  if (Object.keys(obj).length === 0) return '';
  return yaml.dump(obj, DUMP_OPTIONS);
}

interface Block {
  /** The top-level key, or null for the preamble (comments before the first key). */
  key: string | null;
  /** Comment / blank lines above the key line. */
  lead: string[];
  /** The key line and its body. */
  body: string[];
}

const TOP_KEY_RE = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"\-?:][^:#]*?))\s*:(?:\s|$)/;

function topKeyOf(line: string): string | null {
  const m = TOP_KEY_RE.exec(line);
  if (!m) return null;
  if (m[1] !== undefined) return m[1].replace(/\\(.)/g, '$1');
  if (m[2] !== undefined) return m[2].replace(/''/g, "'");
  return m[3].trim();
}

/** Splits YAML text into top-level blocks. Comments and blank lines attach to the key that follows them. */
function splitBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const blocks: Block[] = [];
  let pending: string[] = [];
  let current: Block | null = null;
  for (const line of lines) {
    const isComment = /^\s*#/.test(line) || line.trim() === '';
    const atColumn0 = line.length > 0 && !/^\s/.test(line);
    if (atColumn0 && !isComment && line !== '---' && line !== '...') {
      const key = topKeyOf(line);
      if (key !== null) {
        current = { key, lead: pending, body: [line] };
        blocks.push(current);
        pending = [];
        continue;
      }
    }
    if (isComment && (current === null || atColumn0 || line.trim() === '')) {
      // A column-0 comment (or a blank line) may open the next block: hold it until we know.
      pending.push(line);
      continue;
    }
    if (current) {
      current.body.push(...pending, line);
      pending = [];
    } else {
      pending.push(line);
    }
  }
  if (pending.length) {
    if (current) current.body.push(...pending);
    else blocks.push({ key: null, lead: pending, body: [] });
  }
  if (blocks.length && blocks[0].key !== null && blocks[0].lead.length) {
    // Comments at the very top stay at the top even if the first block is rewritten.
    blocks.unshift({ key: null, lead: blocks[0].lead, body: [] });
    blocks[1].lead = [];
  }
  return blocks;
}

function dumpKey(key: string, value: unknown): string[] {
  const text = yaml.dump({ [key]: value }, DUMP_OPTIONS);
  return text.replace(/\n$/, '').split('\n');
}

/** The `views:` block rewritten view by view: an unchanged view keeps its text (comments included). */
function rewriteViews(block: Block, before: unknown, after: Record<string, unknown>[]): string[] | null {
  if (!Array.isArray(before)) return null;
  const body = block.body.slice(1);
  const first = body.findIndex((l) => /^\s*-(\s|$)/.test(l));
  if (first === -1) return null;
  const indent = /^(\s*)-/.exec(body[first])![1];
  const itemStart = new RegExp(`^${indent}-(\\s|$)`);
  const items: string[][] = [];
  let leadIn: string[] = body.slice(0, first);
  let cur: string[] | null = null;
  for (const line of body.slice(first)) {
    if (itemStart.test(line)) {
      cur = [line];
      items.push(cur);
    } else if (cur) cur.push(line);
    else leadIn.push(line);
  }
  if (items.length !== before.length) return null;
  // Trailing comments of one item that belong to the next one stay where they are; good enough.
  const used = new Set<number>();
  const out: string[] = [block.body[0], ...leadIn];
  for (const view of after) {
    const k = before.findIndex((orig, i) => !used.has(i) && same(viewToYaml(orig as BaseView), view));
    if (k !== -1) {
      used.add(k);
      out.push(...items[k]);
      continue;
    }
    const dumped = yaml.dump([view], DUMP_OPTIONS).replace(/\n$/, '').split('\n');
    out.push(...dumped.map((l) => indent + l));
  }
  leadIn = [];
  return out;
}

/**
 * `original` with `next` written into it (see the module comment). An original
 * that is not a YAML mapping is replaced by a fresh file.
 */
export function updateBaseSource(original: string, next: BaseConfig): string {
  const loaded = loadBaseYaml(original);
  if ('error' in loaded || !loaded.data || typeof loaded.data !== 'object' || Array.isArray(loaded.data)) return serializeBaseConfig(next);
  const before = loaded.data as Record<string, unknown>;
  const target = configToYaml(next, before);
  // Views compared through viewToYaml on both sides, so a view the parser normalized (a missing name) is not "changed".
  const beforeNormalized: Record<string, unknown> = { ...before };
  if (Array.isArray(before.views)) beforeNormalized.views = before.views;

  const blocks = splitBlocks(original);
  const out: string[] = [];
  const written = new Set<string>();
  for (const block of blocks) {
    if (block.key === null) {
      out.push(...block.lead, ...block.body);
      continue;
    }
    const key = block.key;
    if (written.has(key)) continue; // a duplicate key: YAML keeps the last; we keep one
    written.add(key);
    if (!(key in target)) continue; // removed (its leading comments go with it)
    const oldValue = before[key];
    const newValue = target[key];
    if (key === 'views' ? sameViews(oldValue, newValue) : same(oldValue, newValue)) {
      out.push(...block.lead, ...block.body);
      continue;
    }
    if (key === 'views') {
      const rewritten = rewriteViews(block, oldValue, newValue as Record<string, unknown>[]);
      if (rewritten) {
        out.push(...block.lead, ...rewritten);
        continue;
      }
    }
    out.push(...block.lead, ...dumpKey(key, newValue));
  }
  for (const [key, value] of Object.entries(target)) {
    if (written.has(key)) continue;
    out.push(...dumpKey(key, value));
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out.length ? `${out.join('\n')}\n` : '';
}

function sameViews(before: unknown, after: unknown): boolean {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return false;
  return before.every((v, i) => same(viewToYaml(v as BaseView), after[i]));
}
