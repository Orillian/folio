import { describe, expect, it } from 'vitest';
import { SITE_CSS_MAX_BYTES } from './contracts.js';
import { sanitizeSiteCss } from './siteCss.js';

const opts = { assetUrl: (name: string) => `/api/public/spaces/acme/site-assets/${name}` };

describe('sanitizeSiteCss', () => {
  it('removes @import (also escaped and hidden behind comments) and strips comments', () => {
    const r = sanitizeSiteCss(
      '@import url(https://evil.test/a.css);\n@\\69mport "b.css";\n/* @import x; */ body { color: red }\n@import "tail.css"',
      opts,
    );
    expect(r.css).not.toMatch(/import/i);
    expect(r.css).not.toContain('/*');
    expect(r.css).toContain('body { color: red }');
    expect(r.warnings.some((w) => w.includes('@import'))).toBe(true);
  });

  it('replaces external, protocol-relative, root-relative and escaped url() targets with none', () => {
    const r = sanitizeSiteCss(
      [
        'a { background: url(https://evil.test/p.gif) }',
        'b { background: url("//evil.test/p.gif") }',
        'c { background: url(/api/me) }',
        "d { background: u\\72l('http://10.0.0.1/') }",
        'e { background: image-set("https://evil.test/x.png" 1x, url(http://evil.test/y.png) 2x) }',
        'f { background: src("https://evil.test/z.png") }',
        'g { background: url(../secret.png) }',
      ].join('\n'),
      opts,
    );
    expect(r.css).not.toMatch(/evil|10\.0\.0\.1|\/api\/me|secret/);
    expect(r.css.match(/none/g)?.length).toBe(8);
    expect(r.warnings.some((w) => w.includes('replaced with none'))).toBe(true);
  });

  it('rewrites asset names to the asset route and keeps data: images and fragments', () => {
    const r = sanitizeSiteCss(
      [
        '@font-face { font-family: X; src: url(assets/brand.woff2) format("woff2") }',
        '.logo { background: url("./assets/logo.png") }',
        '.bare { background: url(logo.png) }',
        ".dot { background: url('data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>') }",
        '.mask { mask: url(#m) }',
        '.set { background: image-set("assets/hero.webp" 1x) }',
      ].join('\n'),
      opts,
    );
    expect(r.css).toContain('url("/api/public/spaces/acme/site-assets/brand.woff2")');
    expect(r.css).toContain('url("/api/public/spaces/acme/site-assets/logo.png")');
    expect(r.css.match(/site-assets\/logo\.png/g)?.length).toBe(2);
    expect(r.css).toContain('image-set(url("/api/public/spaces/acme/site-assets/hero.webp") 1x)');
    expect(r.css).toContain('data:image/svg+xml,');
    expect(r.css).toContain('<\\/svg>');
    expect(r.css).toContain('url("#m")');
    expect(r.warnings).toEqual([]);
  });

  it('applies nothing over the size cap', () => {
    const big = `body{color:red}${' '.repeat(SITE_CSS_MAX_BYTES)}`;
    const r = sanitizeSiteCss(big, opts);
    expect(r.css).toBe('');
    expect(r.warnings[0]).toMatch(/larger than 256 KB/);
  });

  it('cannot close a <style> element and drops the rest after an unterminated url', () => {
    const r = sanitizeSiteCss('a{color:red}</style><script>alert(1)</script>\nb { background: url("x', opts);
    expect(r.css).not.toContain('</');
    expect(r.warnings.some((w) => w.includes('unterminated'))).toBe(true);
  });
});
