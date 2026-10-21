/**
 * Artifacts, the pure parts: the manifest codec, bundle paths, the zip import's
 * safety rules, link classification, the token and the bridge injection.
 */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { ArtifactImportError } from './errors.js';
import { classifyArtifactLink, embedUrlFromCode, prepareArtifactBundle, unpackZip } from './import.js';
import { artifactBundleOf, htmlTitle, htmlVisibleText, isArtifactDirName, normalizeBundlePath, parseArtifactManifest, scriptJson, writeArtifactManifest } from './manifest.js';
import { injectBridge } from './serve.js';
import { signArtifactToken, verifyArtifactToken } from './token.js';
import { checkFetchUrl } from './fetchUrl.js';
import { isTempBundleName } from './bundle.js';
import { isAtomicTempName } from '../storage.js';

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ArtifactImportError) return err.code;
    throw err;
  }
  return 'ok';
}

describe('manifest codec', () => {
  it('a bundle without artifact.yaml is html / index.html titled by its folder', () => {
    const m = parseArtifactManifest(null, 'q3-dashboard.artifact');
    expect(m.manifest).toEqual({ folio: 'artifact', version: 1, type: 'html', title: 'q3-dashboard', entry: 'index.html' });
    expect(m.properties).toEqual({});
    expect(m.present).toBe(false);
    expect(m.warnings).toEqual([]);
  });

  it('reads reserved keys and keeps every other top-level key as a property', () => {
    const text = [
      'folio: artifact',
      'version: 1',
      'title: Q3 dashboard',
      'icon: 📊',
      'type: react',
      'entry: app/index.html',
      'source:',
      '  origin: claude',
      '  url: https://claude.ai/public/artifacts/x',
      '  importedAt: 2026-10-21T10:00:00Z',
      '  file: source.jsx',
      'capabilities: [storage, claude, bogus]',
      'status: draft',
      'owner: alice',
      'tags: [kpi]',
      '',
    ].join('\n');
    const m = parseArtifactManifest(text, 'x.artifact');
    expect(m.manifest.title).toBe('Q3 dashboard');
    expect(m.manifest.icon).toBe('📊');
    expect(m.manifest.type).toBe('react');
    expect(m.manifest.entry).toBe('app/index.html');
    expect(m.manifest.source).toEqual({ origin: 'claude', url: 'https://claude.ai/public/artifacts/x', importedAt: '2026-10-21T10:00:00.000Z', file: 'source.jsx' });
    expect(m.manifest.capabilities).toEqual(['storage', 'claude']);
    expect(m.properties).toEqual({ status: 'draft', owner: 'alice', tags: ['kpi'] });
  });

  it('an unsafe entry, an unknown type and a non-mapping are warnings, never errors', () => {
    const bad = parseArtifactManifest('type: video\nentry: ../../etc/passwd\n', 'x.artifact');
    expect(bad.manifest.type).toBe('html');
    expect(bad.manifest.entry).toBe('index.html');
    expect(bad.warnings.length).toBe(2);
    const list = parseArtifactManifest('- a\n- b\n', 'y.artifact');
    expect(list.parseable).toBe(false);
    expect(list.manifest.title).toBe('y');
  });

  it('embed needs an https url', () => {
    const ok = parseArtifactManifest('type: embed\nembed:\n  url: https://claude.site/embed/abc\n  height: 640\n', 'e.artifact');
    expect(ok.manifest.embed).toEqual({ url: 'https://claude.site/embed/abc', height: 640 });
    expect(ok.manifest.entry).toBeUndefined();
    const bad = parseArtifactManifest('type: embed\nembed:\n  url: javascript:alert(1)\n', 'e.artifact');
    expect(bad.manifest.embed).toBeUndefined();
  });

  it('writes a fresh manifest, then edits it in place keeping comments and untouched keys', () => {
    const fresh = writeArtifactManifest(null, { folio: 'artifact', version: 1, title: 'Plan', type: 'html', entry: 'index.html' }, { status: 'draft' });
    const reparsed = parseArtifactManifest(fresh, 'plan.artifact');
    expect(reparsed.manifest.title).toBe('Plan');
    expect(reparsed.properties).toEqual({ status: 'draft' });

    const hand = '# made by hand\nfolio: artifact\nversion: 1\ntitle: Old  # the old name\ntype: html\nowner: bob # keep me\n';
    const next = writeArtifactManifest(hand, { ...parseArtifactManifest(hand, 'x.artifact').manifest, title: 'New' });
    expect(next).toContain('# made by hand');
    expect(next).toContain('owner: bob # keep me');
    expect(parseArtifactManifest(next, 'x.artifact').manifest.title).toBe('New');
    // Properties replaced only when given.
    const props = writeArtifactManifest(next, parseArtifactManifest(next, 'x.artifact').manifest, { status: 'done' });
    expect(parseArtifactManifest(props, 'x.artifact').properties).toEqual({ status: 'done' });
  });

  it('bundle paths: traversal, absolute, reserved and dot paths are refused', () => {
    expect(normalizeBundlePath('./assets//x.png')).toBe('assets/x.png');
    for (const p of ['', '/etc/passwd', '../x', 'a/../../x', 'C:/x', 'a\\b', 'artifact.yaml', '__folio/bridge.js', '.env', 'a/.git/config', 'x\u0000y']) {
      expect(normalizeBundlePath(p), p).toBeNull();
    }
    expect(isArtifactDirName('Q3.ARTIFACT')).toBe(true);
    // A crashed bundle write's temp siblings: recognised by the scan, and shaped so git's temp exclusion skips them.
    for (const t of ['.q3.artifact.123.abcdef012345.tmp', '.q3.artifact.123.abcdef012345o.tmp']) {
      expect(isTempBundleName(t), t).toBe(true);
      expect(isAtomicTempName(t), t).toBe(true);
    }
    expect(isTempBundleName('q3.artifact')).toBe(false);
    expect(isArtifactDirName('.artifact')).toBe(false);
    expect(artifactBundleOf('a/q3.artifact/assets/x.png')).toBe('a/q3.artifact');
    expect(artifactBundleOf('a/q3.artifact')).toBeUndefined();
  });

  it('visible text skips scripts, styles and tags; <title> is read', () => {
    const html = '<html><head><title>Sales &amp; KPIs</title><style>.a{}</style><script>var secret=1</script></head><body><h1>Revenue</h1><p>Up 12&#37;</p><!-- hidden --></body></html>';
    expect(htmlVisibleText(html)).toBe('Sales & KPIs Revenue Up 12%');
    expect(htmlTitle(html)).toBe('Sales & KPIs');
    expect(htmlVisibleText('x'.repeat(500), 100)).toHaveLength(100);
  });

  it('scriptJson cannot close a script element', () => {
    expect(scriptJson('</script><script>alert(1)</script>')).not.toContain('</script>');
  });
});

describe('zip import safety', () => {
  async function zipOf(files: Record<string, string>, opts: (zip: JSZip) => void = () => {}): Promise<Buffer> {
    const zip = new JSZip();
    for (const [p, c] of Object.entries(files)) zip.file(p, c);
    opts(zip);
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  it('unpacks a bundle and strips a single top-level folder', async () => {
    const files = await unpackZip(await zipOf({ 'dash/index.html': '<h1>x</h1>', 'dash/assets/a.css': 'a{}', 'dash/artifact.yaml': 'title: Dash\n' }));
    expect([...files.keys()].sort()).toEqual(['artifact.yaml', 'assets/a.css', 'index.html']);
  });

  it('refuses traversal and absolute paths (as the archive wrote them, not as JSZip sanitizes them)', async () => {
    for (const bad of ['a/../../escape.txt', '../x', '/etc/cron.d/x']) {
      const zip = new JSZip();
      zip.file('index.html', 'x');
      zip.file(bad, 'pwned');
      expect(await code(unpackZip(await zip.generateAsync({ type: 'nodebuffer' }))), bad).toBe('badZip');
    }
  });

  it('refuses a raw zip entry named ../x (built by hand)', async () => {
    // A minimal stored zip with one entry "../x" — JSZip itself would never write this name.
    const name = Buffer.from('../x');
    const data = Buffer.from('hi');
    const crc = (await import('node:zlib')).crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(10, 6);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const centralOffset = local.length + name.length + data.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(centralOffset, 16);
    const zip = Buffer.concat([local, name, data, central, name, end]);
    expect(await code(unpackZip(zip))).toBe('badZip');
  });

  it('refuses symlinks', async () => {
    const zip = new JSZip();
    zip.file('index.html', 'x');
    zip.file('link', '/etc/passwd', { unixPermissions: 0o120777 });
    expect(await code(unpackZip(await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' })))).toBe('badZip');
  });

  it('refuses more than 500 files', async () => {
    const files: Record<string, string> = { 'index.html': 'x' };
    for (let i = 0; i < 501; i++) files[`f/${i}.txt`] = 'x';
    expect(await code(unpackZip(await zipOf(files)))).toBe('tooManyFiles');
  });

  it('drops __MACOSX and dot files', async () => {
    const files = await unpackZip(await zipOf({ 'index.html': 'x', '__MACOSX/._index.html': 'junk', '.DS_Store': 'junk' }));
    expect([...files.keys()]).toEqual(['index.html']);
  });

  it('a zip without anything to render is noEntry', async () => {
    const buf = await zipOf({ 'readme.txt': 'x', 'b.txt': 'y' });
    expect(await code(prepareArtifactBundle({ parentPath: '' }, { filename: 'a.zip', bytes: buf }))).toBe('noEntry');
  });
});

describe('import', () => {
  it('html in the body becomes index.html, titled by <title>', async () => {
    const p = await prepareArtifactBundle({ parentPath: '', html: '<html><head><title>Hello</title></head><body>hi</body></html>' });
    expect([...p.files.keys()]).toEqual(['index.html']);
    expect(p.derivedTitle).toBe('Hello');
    expect(p.manifest.type).toBe('html');
    expect(p.manifest.entry).toBe('index.html');
  });

  it('a React artifact keeps its source and takes type react', async () => {
    const p = await prepareArtifactBundle({ parentPath: '', html: '<div id=root></div>', sourceCode: 'export default () => <b/>' });
    expect(p.manifest.type).toBe('react');
    expect(p.manifest.source?.file).toBe('source.jsx');
    expect(p.files.get('source.jsx')?.toString()).toContain('export default');
  });

  it('svg / markdown / mermaid text is wrapped into a page, the text kept as source', async () => {
    const md = await prepareArtifactBundle({ parentPath: '', type: 'markdown', text: '# Title\n\n</script><b>x</b>' });
    const page = md.files.get('index.html')!.toString();
    expect(page).toContain('cdn.jsdelivr.net/npm/marked');
    expect(page).not.toMatch(/<\/script><b>/);
    expect(md.manifest.source?.file).toBe('source.md');
    expect(page).toContain('language-mermaid');
    expect(page).toContain('cdn.jsdelivr.net/npm/mermaid');
    const mm = await prepareArtifactBundle({ parentPath: '', type: 'mermaid', text: 'graph TD; A-->B' });
    expect(mm.files.get('index.html')!.toString()).toContain('mermaid');
    const svg = await prepareArtifactBundle({ parentPath: '' }, { filename: 'logo.svg', bytes: Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>') });
    expect(svg.manifest.type).toBe('svg');
    expect(svg.files.get('index.html')!.toString()).toContain('<circle r="4"/>');
    expect(svg.derivedTitle).toBe('logo');
  });

  it('a zip / html upload is titled by the entry <title>, then the file name', async () => {
    const withTitle = await new JSZip().file('index.html', '<html><head><title> Zip demo </title></head><body>x</body></html>').generateAsync({ type: 'nodebuffer' });
    expect((await prepareArtifactBundle({ parentPath: '' }, { filename: 'demo.zip', bytes: withTitle })).derivedTitle).toBe('Zip demo');
    const noTitle = await new JSZip().file('index.html', '<p>x</p>').generateAsync({ type: 'nodebuffer' });
    expect((await prepareArtifactBundle({ parentPath: '' }, { filename: 'demo.zip', bytes: noTitle })).derivedTitle).toBe('demo');
    const byManifest = await new JSZip().file('index.html', '<title>Zip demo</title>').file('artifact.yaml', 'folio: artifact\nversion: 1\ntitle: Named\n').generateAsync({ type: 'nodebuffer' });
    expect((await prepareArtifactBundle({ parentPath: '' }, { filename: 'demo.zip', bytes: byManifest })).derivedTitle).toBe('Named');
    expect((await prepareArtifactBundle({ parentPath: '' }, { filename: 'page.html', bytes: Buffer.from('<title>Hi</title>x') })).derivedTitle).toBe('Hi');
    expect((await prepareArtifactBundle({ parentPath: '' }, { filename: 'page.html', bytes: Buffer.from('<p>x</p>') })).derivedTitle).toBe('page');
  });

  it('files with unsafe paths are refused', async () => {
    expect(await code(prepareArtifactBundle({ parentPath: '', html: 'x', files: [{ path: '../x.js', content: '', encoding: 'utf8' }] }))).toBe('badPath');
    expect(await code(prepareArtifactBundle({ parentPath: '', html: 'x', files: [{ path: 'artifact.yaml', content: '', encoding: 'utf8' }] }))).toBe('badPath');
  });

  it('claude.ai and cursor links ask for MCP; claudeusercontent and embed code make an embed', async () => {
    expect(await code(prepareArtifactBundle({ parentPath: '', url: 'https://claude.ai/public/artifacts/abc' }))).toBe('useMcp');
    expect(await code(prepareArtifactBundle({ parentPath: '', url: 'https://claude.site/artifacts/abc' }))).toBe('useMcp');
    expect(await code(prepareArtifactBundle({ parentPath: '', url: 'https://cursor.com/canvas/abc' }))).toBe('useMcp');
    expect(classifyArtifactLink('https://abc.claudeusercontent.com/embed/x')).toEqual({ kind: 'embed', url: 'https://abc.claudeusercontent.com/embed/x' });
    const e = await prepareArtifactBundle({ parentPath: '', embedCode: '<iframe src="https://claude.site/public/artifacts/x/embed" height="600" frameborder="0"></iframe>' });
    expect(e.manifest.type).toBe('embed');
    expect(e.manifest.embed).toEqual({ url: 'https://claude.site/public/artifacts/x/embed', height: 600 });
    expect(e.files.size).toBe(0);
    expect(() => embedUrlFromCode('<iframe src="http://x/">')).toThrow();
  });

  it('the download guard refuses private and odd targets before any connection', () => {
    for (const u of ['http://127.0.0.1/x', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://localhost:4870/', 'file:///etc/passwd', 'ftp://x/', 'https://user:pw@example.com/']) {
      expect(() => checkFetchUrl(u), u).toThrow(ArtifactImportError);
    }
    expect(checkFetchUrl('https://example.com/a.html').hostname).toBe('example.com');
  });
});

describe('token', () => {
  it('signs and verifies; tampering and expiry are refused', () => {
    const now = Date.now();
    const t = signArtifactToken('page-1', 'user-1', now);
    expect(verifyArtifactToken(t, now)).toMatchObject({ pageId: 'page-1', userId: 'user-1' });
    const anon = signArtifactToken('page-1', null, now);
    expect(verifyArtifactToken(anon, now)?.userId).toBeNull();
    const [body, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ p: 'page-2', u: 'user-1', e: Math.floor(now / 1000) + 100 })).toString('base64url');
    expect(verifyArtifactToken(`${forged}.${mac}`, now)).toBeNull();
    expect(verifyArtifactToken(`${body}.${mac.slice(0, -2)}xx`, now)).toBeNull();
    expect(verifyArtifactToken(t, now + 13 * 60 * 60 * 1000)).toBeNull();
    expect(verifyArtifactToken('garbage', now)).toBeNull();
    expect(verifyArtifactToken(undefined, now)).toBeNull();
  });
});

describe('bridge injection (inline)', () => {
  const code = 'window.__B=1;';
  const tag = `<script>${code}</script>`;
  it('goes right after <meta charset> inside <head>, else first in <head>', () => {
    expect(injectBridge('<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body></body></html>', code)).toBe(
      `<!doctype html><html><head><meta charset="utf-8">${tag}<title>t</title></head><body></body></html>`,
    );
    expect(injectBridge('<html><head><title>t</title><META CHARSET=utf-8></head></html>', code)).toContain(`<META CHARSET=utf-8>${tag}</head>`);
    expect(injectBridge('<HTML><HEAD lang=x><title>t</title></HEAD></HTML>', code)).toContain(`<HEAD lang=x>${tag}<title>`);
    // a charset <meta> in the body is not the head's
    expect(injectBridge('<html><head></head><body><meta charset="x"></body></html>', code)).toBe(`<html><head>${tag}</head><body><meta charset="x"></body></html>`);
  });
  it('makes a <head> when there is none (and never matches <header>)', () => {
    expect(injectBridge('<html><body><header>x</header></body></html>', code)).toBe(`<html><head>${tag}</head><body><header>x</header></body></html>`);
    expect(injectBridge('<!DOCTYPE html><p>x</p>', code)).toBe(`<!DOCTYPE html><head>${tag}</head><p>x</p>`);
    expect(injectBridge('<p>x</p>', code)).toBe(`<head>${tag}</head><p>x</p>`);
  });
  it('cannot be closed early by the code itself', () => {
    const out = injectBridge('<head></head>', 'var a="</script><b>";//<!--');
    expect(out.match(/<\/script>/gi)).toHaveLength(1);
    expect(out).not.toContain('<!--');
  });
});

describe('bridge script (jsdom, no host frame: in-memory fallback)', () => {
  it('provides window.storage, a localStorage polyfill preloaded from ls: keys, and a rejecting window.claude.complete', async () => {
    const { JSDOM } = await import('jsdom');
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const src = fsMod.readFileSync(pathMod.join(import.meta.dirname, 'bridge.js'), 'utf8');
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', url: 'https://example.test/' });
    const win = dom.window as unknown as { eval(code: string): unknown; localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void; length: number }; storage: any; claude: any; close(): void };
    win.eval(`window.__FOLIO_ARTIFACT_PRELOAD__ = ${scriptJson({ personal: { 'ls:theme': 'dark', other: 'x' }, shared: {} })};\n${src}`);
    expect(win.localStorage.getItem('theme')).toBe('dark');
    expect(win.localStorage.getItem('other')).toBeNull();
    win.localStorage.setItem('n', '2');
    expect(win.localStorage.length).toBe(2);
    expect(await win.storage.set('k', 'v')).toEqual({ key: 'k', value: 'v', shared: false });
    expect(await win.storage.get('k')).toEqual({ key: 'k', value: 'v', shared: false });
    expect(await win.storage.get('k', true)).toBeNull();
    expect((await win.storage.list('ls:')).keys).toEqual(['ls:n', 'ls:theme']);
    expect(await win.storage.delete('k')).toEqual({ key: 'k', deleted: true, shared: false });
    await expect(win.claude.complete('hi')).rejects.toThrow(/not available in Folio/);
    win.close();
  });
});
