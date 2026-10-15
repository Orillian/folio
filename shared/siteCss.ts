/**
 * Sanitizer of a public site's stylesheet, `.folio/site.css` (14.10.2026,
 * "Space appearance" in shared/contracts.ts). Pure TS, no Node or DOM imports:
 * the server applies it when serving GET /api/public/spaces/:slug/site.css and
 * when reporting `warnings` for the settings page; the web settings page runs
 * the very same function for its live preview warnings, so the two can never
 * disagree.
 *
 * WHY: the stylesheet is authored by whoever can write to the space's
 * repository and is then loaded by every anonymous visitor of the site (in
 * path mode on the instance's own origin). CSS cannot run script, but it can
 * make requests: `@import`, `url()` and `image-set()` are tracking pixels and
 * attribute-selector exfiltration channels. So the only things a site
 * stylesheet may reference are inline `data:` images/fonts and files of the
 * space's own `.folio/assets/` folder (rewritten to the site-assets route).
 *
 * Rules, in order:
 *   1. over SITE_CSS_MAX_BYTES → nothing is applied (empty css + a warning);
 *   2. comments are removed (an unterminated one runs to the end, as in CSS);
 *   3. CSS escapes that spell an ASCII letter (`@\69mport`, `u\72l(`) are
 *      decoded, so the rules below see what the browser will see; hex escapes
 *      that stay get an explicit terminating space;
 *   4. `</` becomes `<\/` in the result (the css can be inlined into a
 *      <style> by a preview; inside a CSS string `\/` still means `/`, so an
 *      inline `data:image/svg+xml,…</svg>` keeps working);
 *   5. every `@import` is removed;
 *   6. `url()`, `src()` and the strings of `image-set()` / `-webkit-image-set()`:
 *      `data:image/*` and `data:font/*` stay as they are, `#fragment` (an SVG
 *      reference inside the page) stays, an asset name (`logo.png`,
 *      `assets/logo.png`, `./assets/logo.png`, matching SITE_ASSET_NAME_RE) is
 *      rewritten to `assetUrl(name)`; anything else — absolute, protocol-relative,
 *      root-relative, other relative paths, other data: types — becomes `none`.
 */
import { SITE_ASSET_NAME_RE, SITE_CSS_MAX_BYTES } from './contracts.js';

export interface SanitizedSiteCss {
  css: string;
  warnings: string[];
}

export interface SanitizeSiteCssOptions {
  /** Public URL of a file in `.folio/assets/` (the name is already validated). */
  assetUrl: (name: string) => string;
}

const MAX_TARGET_WARNINGS = 10;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** A url target that names a file of `.folio/assets/`, or null. */
export function siteAssetNameFromRef(target: string): string | null {
  const m = /^(?:\.\/)?(?:assets\/)?([^/\\?#]+)$/.exec(target.trim());
  if (!m) return null;
  return SITE_ASSET_NAME_RE.test(m[1]) ? m[1] : null;
}

function decodeLetterEscapes(css: string): string {
  return css.replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|([^\r\n\f0-9a-fA-F]))/g, (whole, hex?: string, ch?: string) => {
    if (hex !== undefined) {
      const cp = parseInt(hex, 16);
      if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return String.fromCharCode(cp);
      // Keep it, but terminate it explicitly so a decoded letter right after it cannot extend the hex run.
      return `\\${hex} `;
    }
    return ch !== undefined && /[A-Za-z]/.test(ch) ? ch : whole;
  });
}

function quoteCssString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\f]/g, '')}"`;
}

type TargetVerdict = { kind: 'keep' } | { kind: 'rewrite'; url: string } | { kind: 'block' };

/** Reads a quoted string at `i` (pointing at the quote). Returns the unescaped value and the index after the closing quote, or null when unterminated. */
function readString(css: string, i: number): { value: string; end: number } | null {
  const quote = css[i];
  let value = '';
  let j = i + 1;
  while (j < css.length) {
    const c = css[j];
    if (c === '\\' && j + 1 < css.length) {
      value += css[j + 1];
      j += 2;
      continue;
    }
    if (c === quote) return { value, end: j + 1 };
    if (c === '\n') return null;
    value += c;
    j++;
  }
  return null;
}

function skipWs(css: string, i: number): number {
  while (i < css.length && /[ \t\r\n\f]/.test(css[i])) i++;
  return i;
}

export function sanitizeSiteCss(input: string, opts: SanitizeSiteCssOptions): SanitizedSiteCss {
  const warnings: string[] = [];
  if (byteLength(input) > SITE_CSS_MAX_BYTES) {
    warnings.push(`site.css is larger than ${Math.round(SITE_CSS_MAX_BYTES / 1024)} KB, so it is not applied`);
    return { css: '', warnings };
  }

  // NUL becomes U+FFFD, as the CSS tokenizer does (and it is our placeholder marker below).
  let css = input.replace(/\u0000/g, '\uFFFD').replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ');
  css = decodeLetterEscapes(css);

  let imports = 0;
  css = css.replace(/@import\b[^;{}]*(?:;|(?=[{}])|$)/gi, () => {
    imports++;
    return '';
  });
  if (imports > 0) warnings.push(`@import is not allowed (${imports} removed)`);

  const blocked: string[] = [];
  let blockedCount = 0;
  const judge = (raw: string): TargetVerdict => {
    const target = raw.trim();
    if (/^data:(?:image|font)\//i.test(target)) return { kind: 'keep' };
    if (/^#[\w-]+$/.test(target)) return { kind: 'keep' };
    const name = siteAssetNameFromRef(target);
    if (name) return { kind: 'rewrite', url: opts.assetUrl(name) };
    blockedCount++;
    if (blocked.length < MAX_TARGET_WARNINGS) blocked.push(target.length > 80 ? `${target.slice(0, 77)}...` : target);
    return { kind: 'block' };
  };

  // One left-to-right pass over the function tokens that load something.
  const FN_RE = /(-webkit-image-set|image-set|url|src)\(/gi;
  let out = '';
  let pos = 0;
  let unclosed = false;
  for (let m = FN_RE.exec(css); m; m = FN_RE.exec(css)) {
    const start = m.index;
    // `myurl(` / `--src(` are other identifiers, not the function.
    if (start > 0 && /[\w-]/.test(css[start - 1])) continue;
    const fn = m[1].toLowerCase();
    let i = start + m[0].length;
    out += css.slice(pos, start);

    if (fn === 'url' || fn === 'src') {
      i = skipWs(css, i);
      let target: string;
      if (css[i] === '"' || css[i] === "'") {
        const s = readString(css, i);
        if (!s) {
          unclosed = true;
          pos = css.length;
          break;
        }
        target = s.value;
        i = skipWs(css, s.end);
        // src() may carry modifiers after the string; skip to the closing paren.
        while (i < css.length && css[i] !== ')') i++;
      } else {
        const close = css.indexOf(')', i);
        if (close === -1) {
          unclosed = true;
          pos = css.length;
          break;
        }
        target = css.slice(i, close);
        i = close;
      }
      if (css[i] !== ')') {
        unclosed = true;
        pos = css.length;
        break;
      }
      const v = judge(target);
      out += v.kind === 'keep' ? `url(${quoteCssString(target.trim())})` : v.kind === 'rewrite' ? `url(${quoteCssString(v.url)})` : 'none';
      pos = i + 1;
      FN_RE.lastIndex = pos;
      continue;
    }

    // image-set(): its top-level strings are urls; nested url()/src() go through sanitizeNested.
    let depth = 1;
    let j = i;
    let body = '';
    const resolved: string[] = [];
    while (j < css.length && depth > 0) {
      const c = css[j];
      if (c === '"' || c === "'") {
        const s = readString(css, j);
        if (!s) break;
        if (depth === 1) {
          const v = judge(s.value);
          // A placeholder, so sanitizeNested below does not judge the rewritten url a second time.
          resolved.push(v.kind === 'keep' ? `url(${quoteCssString(s.value.trim())})` : v.kind === 'rewrite' ? `url(${quoteCssString(v.url)})` : 'none');
          body += `\u0000${resolved.length - 1}\u0000`;
        } else {
          body += quoteCssString(s.value);
        }
        j = s.end;
        continue;
      }
      if (c === '(') depth++;
      if (c === ')') {
        depth--;
        if (depth === 0) break;
      }
      body += c;
      j++;
    }
    if (depth !== 0) {
      unclosed = true;
      pos = css.length;
      break;
    }
    const inner = sanitizeNested(body, judge).replace(/\u0000(\d+)\u0000/g, (_w, n: string) => resolved[Number(n)] ?? '');
    out += css.slice(start, i) + inner + ')';
    pos = j + 1;
    FN_RE.lastIndex = pos;
  }
  out += css.slice(pos);
  out = out.replace(/<\s*\//g, '<\\/');

  if (blockedCount > 0) {
    const more = blockedCount > blocked.length ? ` and ${blockedCount - blocked.length} more` : '';
    warnings.push(
      `Only data: images and files of .folio/assets/ may be referenced; replaced with none: ${blocked.join(', ')}${more}`,
    );
  }
  if (unclosed) warnings.push('An unterminated url() or string was found; the rest of the file was dropped');

  return { css: out, warnings };
}

/** url()/src() inside an image-set() body (strings there were already handled). */
function sanitizeNested(body: string, judge: (raw: string) => TargetVerdict): string {
  return body.replace(/(^|[^\w-])(url|src)\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi, (_w, pre: string, _fn, dq?: string, sq?: string, bare?: string) => {
    const target = dq ?? sq ?? bare ?? '';
    const v = judge(target);
    return pre + (v.kind === 'keep' ? `url(${quoteCssString(target.trim())})` : v.kind === 'rewrite' ? `url(${quoteCssString(v.url)})` : 'none');
  });
}
