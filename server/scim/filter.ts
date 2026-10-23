/**
 * The SCIM filter subset identity providers actually send (RFC 7644 §3.4.2.2): equality terms joined by `and`.
 *
 *   userName eq "ada@example.com"                      (Okta, Entra, OneLogin, JumpCloud)
 *   externalId eq "a1b2"                               (Entra, Keycloak plugins)
 *   emails[type eq "work"].value eq "ada@example.com"  (Okta)   -> emails.value
 *   emails.value eq "ada@example.com"
 *   displayName eq "Engineering"                       (groups)
 *   id eq "…" and members[value eq "…"]                (Entra's membership check) -> members.value
 *
 * Attribute names are case-insensitive; values are compared case-insensitively for userName / emails (caseExact
 * false in RFC 7643) and exactly for ids. Anything else is a 400 `invalidFilter`, never a silent "match all".
 */
import { scimBadRequest } from './errors.js';

export interface FilterTerm {
  /** Canonical, lower-case: 'username', 'externalid', 'id', 'emails.value', 'displayname', 'members.value', 'active'. */
  attr: string;
  value: string | boolean;
}

const SUPPORTED = new Set(['username', 'externalid', 'id', 'emails.value', 'displayname', 'members.value', 'active']);

/** Splits on the keyword `and` outside quotes and brackets. `or` / `not` / grouping are refused. */
function splitAnd(filter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = '';
  for (let i = 0; i < filter.length; i++) {
    const c = filter[i];
    if (c === '"' && filter[i - 1] !== '\\') inQuote = !inQuote;
    if (!inQuote) {
      if (c === '[') depth++;
      if (c === ']') depth--;
      if (c === '(' || c === ')') throw scimBadRequest('grouping with parentheses is not supported in filters', 'invalidFilter');
      if (depth === 0 && /\s/.test(c)) {
        const rest = filter.slice(i + 1);
        const keyword = /^(and|or)\s/i.exec(rest);
        if (keyword) {
          if (keyword[1].toLowerCase() === 'or') throw scimBadRequest('"or" is not supported in filters', 'invalidFilter');
          parts.push(current);
          current = '';
          i += keyword[0].length;
          continue;
        }
      }
    }
    current += c;
  }
  if (inQuote || depth !== 0) throw scimBadRequest('unbalanced quotes or brackets in filter', 'invalidFilter');
  parts.push(current);
  return parts.map((p) => p.trim());
}

function unquote(raw: string): string | boolean {
  const trimmed = raw.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(trimmed)) return JSON.parse(trimmed) as string;
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  throw scimBadRequest(`unsupported filter value: ${trimmed}`, 'invalidFilter');
}

function parseTerm(term: string): FilterTerm {
  // emails[type eq "work"].value eq "x" -> emails.value; members[value eq "x"] -> members.value eq "x"
  const bracket = /^([A-Za-z][\w.:-]*)\[\s*(\w+)\s+eq\s+("(?:[^"\\]|\\.)*"|\S+)\s*\](?:\.(\w+))?(?:\s+eq\s+(.+))?$/i.exec(term);
  if (bracket) {
    const [, attr, innerAttr, innerValue, sub, outerValue] = bracket;
    if (outerValue !== undefined && sub) return check(`${attr}.${sub}`, unquote(outerValue));
    if (outerValue === undefined && !sub) return check(`${attr}.${innerAttr}`, unquote(innerValue));
    throw scimBadRequest(`unsupported filter: ${term}`, 'invalidFilter');
  }
  const simple = /^([A-Za-z][\w.:-]*)\s+(\w+)\s+(.+)$/.exec(term);
  if (!simple) throw scimBadRequest(`unsupported filter: ${term}`, 'invalidFilter');
  const [, attr, op, value] = simple;
  if (op.toLowerCase() !== 'eq') throw scimBadRequest(`only the "eq" operator is supported in filters (got "${op}")`, 'invalidFilter');
  return check(attr, unquote(value));
}

function check(rawAttr: string, value: string | boolean): FilterTerm {
  // A fully qualified core attribute (urn:ietf:params:scim:schemas:core:2.0:User:userName) is the plain one.
  const attr = rawAttr.replace(/^urn:ietf:params:scim:schemas:core:2\.0:(User|Group):/i, '').toLowerCase();
  if (!SUPPORTED.has(attr)) throw scimBadRequest(`filtering on "${rawAttr}" is not supported`, 'invalidFilter');
  if (attr === 'active' ? typeof value !== 'boolean' : typeof value !== 'string') throw scimBadRequest(`bad value for "${rawAttr}" in filter`, 'invalidFilter');
  return { attr, value };
}

/** Undefined / blank -> no terms (match all). */
export function parseScimFilter(filter: string | undefined): FilterTerm[] {
  if (filter === undefined || filter.trim() === '') return [];
  if (filter.length > 1000) throw scimBadRequest('filter too long', 'invalidFilter');
  return splitAnd(filter.trim()).map(parseTerm);
}
