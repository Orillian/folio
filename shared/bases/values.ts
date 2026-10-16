/**
 * Values of the Bases expression language and their conversions. Dates are UTC
 * throughout (the index stores a YAML date as an ISO timestamp at midnight UTC,
 * and the server has no reader time zone), so `today()` is today in UTC.
 */

export class BDate {
  constructor(
    readonly ms: number,
    /** false = a date without a time of day (shown as YYYY-MM-DD). */
    readonly time: boolean,
  ) {}
}

export class BDuration {
  constructor(
    readonly ms: number,
    /** Calendar months (years × 12 + months): added with the calendar, not as a fixed number of ms. */
    readonly months = 0,
  ) {}
}

export class BLink {
  constructor(
    /** The target as written, without `[[ ]]`, alias or `#fragment` (a page name, a path or a URL). */
    readonly path: string,
    readonly display?: string,
  ) {}
}

/** The page data a row (or `this`) is built from. */
export interface BaseRowData {
  id: string;
  /** Space-relative path, e.g. `projects/alpha.md`. */
  path: string;
  title: string;
  kind: string;
  size: number | null;
  /** ms since epoch. */
  mtime: number | null;
  ctime: number | null;
  /** The page's properties (front matter / sidecar), JSON as the index stores them. */
  properties: Record<string, unknown>;
  /** Tags as the index stores them (lowercase, no `#`). */
  tags: string[];
  /** Outgoing link targets: resolved page paths, attachment paths, or the target as written. */
  links: string[];
  /** Pages this page links to (ids). */
  linkIds?: string[];
  /** Embed targets (`![[…]]`, images). */
  embeds?: string[];
  /** Pages linking to this page (paths) — loaded only when a base reads file.backlinks. */
  backlinks?: string[];
}

export class BFile {
  constructor(readonly row: BaseRowData) {}
}

export type Value = null | string | number | boolean | BDate | BDuration | BLink | BFile | RegExp | Value[] | ValueObject;
export interface ValueObject {
  [key: string]: Value;
}

export function isPlainObject(v: unknown): v is ValueObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

export function typeName(v: Value | undefined): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (v instanceof BDate) return 'date';
  if (v instanceof BDuration) return 'duration';
  if (v instanceof BLink) return 'link';
  if (v instanceof BFile) return 'file';
  if (v instanceof RegExp) return 'regexp';
  if (Array.isArray(v)) return 'list';
  return 'object';
}

// ---------------------------------------------------------------------------
// from the index's JSON
// ---------------------------------------------------------------------------

const INDEX_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DATE_TEXT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const WIKILINK_VALUE_RE = /^!?\[\[([^\]]+)\]\]$/;

/** `YYYY-MM-DD`, `YYYY-MM-DD HH:mm[:ss]`, an ISO timestamp → a date; else null. */
export function parseDateText(s: string): BDate | null {
  const m = DATE_TEXT_RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se, msPart, zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (h === undefined) return new BDate(Date.UTC(year, month - 1, day), false);
  let ms = Date.UTC(year, month - 1, day, Number(h), Number(mi), se ? Number(se) : 0, msPart ? Number(msPart.padEnd(3, '0')) : 0);
  if (zone && zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    ms -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
  }
  if (Number.isNaN(ms)) return null;
  return new BDate(ms, true);
}

/** `[[Target|Alias]]` → a link; else null. */
export function parseWikilinkText(s: string): BLink | null {
  const m = WIKILINK_VALUE_RE.exec(s.trim());
  if (!m) return null;
  const inner = m[1];
  const bar = inner.indexOf('|');
  const target = (bar === -1 ? inner : inner.slice(0, bar)).trim();
  const alias = bar === -1 ? undefined : inner.slice(bar + 1).trim() || undefined;
  const hash = target.indexOf('#');
  return new BLink(hash === -1 ? target : target.slice(0, hash), alias);
}

/**
 * A property value as the index stores it → a Value. `dateKeys`: properties the
 * space types as date/datetime, whose `YYYY-MM-DD` text is a date. The index's
 * own ISO timestamps (a YAML date) are dates whatever the type.
 */
export function fromJson(raw: unknown, isDateKey = false): Value {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    if (INDEX_TIMESTAMP_RE.test(raw)) {
      const d = parseDateText(raw);
      if (d) return d.ms % 86_400_000 === 0 ? new BDate(d.ms, false) : d;
    }
    if (isDateKey) {
      const d = parseDateText(raw);
      if (d) return d;
    }
    const link = parseWikilinkText(raw);
    if (link) return link;
    return raw;
  }
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'boolean') return raw;
  if (Array.isArray(raw)) return raw.map((x) => fromJson(x, isDateKey));
  if (typeof raw === 'object') {
    const out: ValueObject = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = fromJson(v, false);
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// durations
// ---------------------------------------------------------------------------

const UNIT_MS: Record<string, number> = { w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
const DURATION_PART_RE = /([+-]?\d+(?:\.\d+)?)\s*(ms|milliseconds?|y|years?|M|months?|w|weeks?|d|days?|h|hours?|m|minutes?|s|seconds?)(?![A-Za-z])/g;

function unitOf(raw: string): string {
  if (raw === 'M' || /^months?$/.test(raw)) return 'M';
  if (raw === 'ms' || /^milliseconds?$/.test(raw)) return 'ms';
  if (raw === 'm' || /^minutes?$/.test(raw)) return 'm';
  return raw[0].toLowerCase();
}

/** `"1d"`, `"2 weeks"`, `"1M 4h"`, `"-3h"` → a duration; else null. */
export function parseDuration(s: string): BDuration | null {
  const text = s.trim();
  if (!text) return null;
  let ms = 0;
  let months = 0;
  let consumed = '';
  DURATION_PART_RE.lastIndex = 0;
  for (let m = DURATION_PART_RE.exec(text); m; m = DURATION_PART_RE.exec(text)) {
    consumed += m[0];
    const n = Number(m[1]);
    const unit = unitOf(m[2]);
    if (unit === 'y') months += n * 12;
    else if (unit === 'M') months += n;
    else ms += n * UNIT_MS[unit];
  }
  if (consumed.replace(/\s+/g, '') !== text.replace(/\s+/g, '')) return null;
  return new BDuration(ms, months);
}

export function addDuration(date: BDate, dur: BDuration, sign: 1 | -1): BDate {
  let ms = date.ms;
  if (dur.months !== 0) {
    const d = new Date(ms);
    const whole = Math.trunc(dur.months);
    d.setUTCMonth(d.getUTCMonth() + sign * whole);
    ms = d.getTime();
    const frac = dur.months - whole;
    if (frac) ms += sign * frac * 30 * 86_400_000;
  }
  ms += sign * dur.ms;
  const time = date.time || ms % 86_400_000 !== 0;
  return new BDate(ms, time);
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

const pad = (n: number, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0');

export function dateIso(d: BDate): string {
  const x = new Date(d.ms);
  if (Number.isNaN(x.getTime())) return '';
  const day = `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
  if (!d.time) return day;
  return `${day}T${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}:${pad(x.getUTCSeconds())}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** Moment.js-style formatting (the common tokens; `[text]` is literal). UTC. */
export function formatDate(d: BDate, fmt: string): string {
  const x = new Date(d.ms);
  if (Number.isNaN(x.getTime())) return '';
  const Y = x.getUTCFullYear();
  const M = x.getUTCMonth();
  const D = x.getUTCDate();
  const H = x.getUTCHours();
  const mi = x.getUTCMinutes();
  const s = x.getUTCSeconds();
  const ms = x.getUTCMilliseconds();
  const wd = x.getUTCDay();
  const h12 = H % 12 === 0 ? 12 : H % 12;
  const tokens: Record<string, () => string> = {
    YYYY: () => String(Y),
    YY: () => pad(Y % 100),
    MMMM: () => MONTHS[M],
    MMM: () => MONTHS[M].slice(0, 3),
    MM: () => pad(M + 1),
    M: () => String(M + 1),
    DDDD: () => pad(Math.floor((Date.UTC(Y, M, D) - Date.UTC(Y, 0, 1)) / 86_400_000) + 1, 3),
    Do: () => ordinal(D),
    DD: () => pad(D),
    D: () => String(D),
    dddd: () => WEEKDAYS[wd],
    ddd: () => WEEKDAYS[wd].slice(0, 3),
    dd: () => WEEKDAYS[wd].slice(0, 2),
    d: () => String(wd),
    HH: () => pad(H),
    H: () => String(H),
    hh: () => pad(h12),
    h: () => String(h12),
    mm: () => pad(mi),
    m: () => String(mi),
    ss: () => pad(s),
    s: () => String(s),
    SSS: () => pad(ms, 3),
    A: () => (H < 12 ? 'AM' : 'PM'),
    a: () => (H < 12 ? 'am' : 'pm'),
    X: () => String(Math.floor(d.ms / 1000)),
    x: () => String(d.ms),
    Z: () => '+00:00',
  };
  const re = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DDDD|Do|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|SSS|A|a|X|x|Z/g;
  return fmt.replace(re, (match, literal: string | undefined) => (literal !== undefined ? literal : (tokens[match]?.() ?? match)));
}

export function relativeText(d: BDate, nowMs: number): string {
  const diff = d.ms - nowMs;
  const abs = Math.abs(diff);
  const units: Array<[number, string]> = [
    [365 * 86_400_000, 'year'],
    [30 * 86_400_000, 'month'],
    [7 * 86_400_000, 'week'],
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
  ];
  for (const [size, name] of units) {
    if (abs >= size) {
      const n = Math.round(abs / size);
      const label = `${n} ${name}${n === 1 ? '' : 's'}`;
      return diff < 0 ? `${label} ago` : `in ${label}`;
    }
  }
  return 'just now';
}

export function durationText(d: BDuration): string {
  const parts: string[] = [];
  if (d.months) parts.push(`${d.months}M`);
  let rest = Math.abs(d.ms);
  const sign = d.ms < 0 ? '-' : '';
  for (const [unit, size] of [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1000],
  ] as const) {
    const n = Math.floor(rest / size);
    if (n) parts.push(`${sign}${n}${unit}`);
    rest -= n * size;
  }
  if (rest) parts.push(`${sign}${rest}ms`);
  return parts.join(' ') || '0s';
}

/** The text of a value (string concatenation, `toString()`, `join`, group labels). */
export function toText(v: Value | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(15)));
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof BDate) return dateIso(v).replace('T', ' ');
  if (v instanceof BDuration) return durationText(v);
  if (v instanceof BLink) return v.display ?? v.path;
  if (v instanceof BFile) return basenameOf(v.row.path);
  if (v instanceof RegExp) return String(v);
  if (Array.isArray(v)) return v.map(toText).join(', ');
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

export function basenameOf(p: string): string {
  const name = p.slice(p.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (name.toLowerCase().endsWith('.excalidraw.svg')) return name.slice(0, -'.excalidraw.svg'.length);
  if (name.toLowerCase().endsWith('.table.md')) return name.slice(0, -'.table.md'.length);
  if (name.toLowerCase().endsWith('.form.md')) return name.slice(0, -'.form.md'.length);
  return dot > 0 ? name.slice(0, dot) : name;
}

// ---------------------------------------------------------------------------
// truthiness, equality, ordering
// ---------------------------------------------------------------------------

export function truthy(v: Value | undefined): boolean {
  if (v === null || v === undefined || v === false || v === '' || v === 0) return false;
  if (typeof v === 'number') return !Number.isNaN(v);
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  return true;
}

export function isEmptyValue(v: Value | undefined): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  if (typeof v === 'number') return Number.isNaN(v);
  return false;
}

/** A link target, compared loosely: lowercase, no `.md`, no fragment, no `./`. */
export function linkKey(target: string): string {
  let t = target.trim();
  const hash = t.indexOf('#');
  if (hash > 0) t = t.slice(0, hash);
  t = t.replace(/^\.\//, '').replace(/^\/+/, '');
  if (t.toLowerCase().endsWith('.md')) t = t.slice(0, -3);
  return t.toLowerCase();
}

/** Two link targets mean the same page: the same path, or the same name when one of them is only a name. */
export function sameTarget(a: string, b: string): boolean {
  const ka = linkKey(a);
  const kb = linkKey(b);
  if (ka === kb) return true;
  if (!ka.includes('/') || !kb.includes('/')) return ka.slice(ka.lastIndexOf('/') + 1) === kb.slice(kb.lastIndexOf('/') + 1);
  return false;
}

function targetOf(v: Value): string | null {
  if (v instanceof BLink) return v.path;
  if (v instanceof BFile) return v.row.path;
  if (typeof v === 'string') return parseWikilinkText(v)?.path ?? v;
  return null;
}

export function equals(a: Value | undefined, b: Value | undefined): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  if (x instanceof BFile && y instanceof BFile) return x.row.id === y.row.id;
  if (x instanceof BLink || y instanceof BLink || x instanceof BFile || y instanceof BFile) {
    const ta = targetOf(x);
    const tb = targetOf(y);
    return ta !== null && tb !== null && sameTarget(ta, tb);
  }
  if (x instanceof BDate || y instanceof BDate) {
    const da = x instanceof BDate ? x : typeof x === 'string' ? parseDateText(x) : null;
    const db = y instanceof BDate ? y : typeof y === 'string' ? parseDateText(y) : null;
    return da !== null && db !== null && da.ms === db.ms;
  }
  if (x instanceof BDuration && y instanceof BDuration) return x.ms === y.ms && x.months === y.months;
  if (x instanceof RegExp && y instanceof RegExp) return String(x) === String(y);
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((item, i) => equals(item, y[i]));
  if (isPlainObject(x) && isPlainObject(y)) {
    const kx = Object.keys(x);
    const ky = Object.keys(y);
    return kx.length === ky.length && kx.every((k) => equals(x[k], y[k]));
  }
  return x === y;
}

/** a < b → negative, a > b → positive, equal → 0; null when the two cannot be ordered. */
export function compare(a: Value | undefined, b: Value | undefined): number | null {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return null;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  if (x instanceof BDate || y instanceof BDate) {
    const da = x instanceof BDate ? x.ms : typeof x === 'string' ? (parseDateText(x)?.ms ?? null) : typeof x === 'number' ? x : null;
    const db = y instanceof BDate ? y.ms : typeof y === 'string' ? (parseDateText(y)?.ms ?? null) : typeof y === 'number' ? y : null;
    return da === null || db === null ? null : da - db;
  }
  if (x instanceof BDuration && y instanceof BDuration) return x.ms + x.months * 30 * 86_400_000 - (y.ms + y.months * 30 * 86_400_000);
  if (typeof x === 'string' && typeof y === 'string') return x < y ? -1 : x > y ? 1 : 0;
  if (typeof x === 'number' && typeof y === 'string' && y.trim() !== '' && Number.isFinite(Number(y))) return x - Number(y);
  if (typeof x === 'string' && typeof y === 'number' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x) - y;
  if (typeof x === 'boolean' && typeof y === 'boolean') return Number(x) - Number(y);
  if ((x instanceof BLink || x instanceof BFile) && (y instanceof BLink || y instanceof BFile || typeof y === 'string')) {
    const tx = toText(x).toLowerCase();
    const ty = toText(y).toLowerCase();
    return tx < ty ? -1 : tx > ty ? 1 : 0;
  }
  return null;
}

const SORT_RANK: Record<string, number> = { number: 0, date: 1, duration: 2, string: 3, link: 3, file: 3, boolean: 4, list: 5, object: 6, regexp: 7 };

/** Total order for sorting rows: empty values last, then by type, then by value (strings case-insensitively, numerically aware). */
export function sortCompare(a: Value | undefined, b: Value | undefined): number {
  const ea = isEmptyValue(a ?? null);
  const eb = isEmptyValue(b ?? null);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const ta = typeName(a ?? null);
  const tb = typeName(b ?? null);
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  if (SORT_RANK[ta] === SORT_RANK[tb]) {
    if (Array.isArray(a) && Array.isArray(b)) return toText(a).localeCompare(toText(b), undefined, { numeric: true, sensitivity: 'base' });
    const c = compare(a, b);
    if (c !== null) return c < 0 ? -1 : c > 0 ? 1 : 0;
    return toText(a ?? null).localeCompare(toText(b ?? null), undefined, { numeric: true, sensitivity: 'base' });
  }
  return (SORT_RANK[ta] ?? 9) - (SORT_RANK[tb] ?? 9);
}
