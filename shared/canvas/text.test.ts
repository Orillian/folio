import { describe, expect, it } from 'vitest';
import type { CanvasDocument, CanvasFileTarget } from '../contracts.js';
import { canvasOutline, canvasSearchText } from './text.js';
import { movedCanvasPath, rewriteCanvasStrings } from './rewrite.js';
import { normalizeHex, resolveCanvasColor, tintHex } from './colors.js';

const doc: CanvasDocument = {
  nodes: [
    { id: 'g', type: 'group', x: 0, y: 0, width: 800, height: 400, label: 'Plan', color: '4' },
    { id: 't', type: 'text', text: '# Goals\n- ship #q4', x: 20, y: 20, width: 200, height: 100 },
    { id: 'f', type: 'file', file: 'Notes/Spec.md', subpath: '#Scope', x: 300, y: 20, width: 200, height: 100 },
    { id: 's', type: 'file', file: '', x: 520, y: 20, width: 200, height: 100 },
    { id: 'm', type: 'file', file: 'gone.md', x: 900, y: 20, width: 100, height: 100 },
    { id: 'l', type: 'link', url: 'https://example.com/a', x: 900, y: 200, width: 100, height: 100 },
  ],
  edges: [
    { id: 'e1', fromNode: 't', fromEnd: 'none', toNode: 'f', toEnd: 'arrow', label: 'details', color: '1' },
    { id: 'e2', fromNode: 'f', fromSide: 'bottom', fromEnd: 'arrow', toNode: 's', toEnd: 'arrow' },
  ],
};
const files: Record<string, CanvasFileTarget> = {
  f: { status: 'page', pageId: 'p1', kind: 'doc', title: 'Spec', path: 'Notes/Spec.md' },
  s: { status: 'noAccess' },
  m: { status: 'missing', path: 'gone.md' },
};

describe('canvasSearchText', () => {
  it('holds group labels, text cards, URLs and edge labels — never a file card path', () => {
    const text = canvasSearchText(doc);
    expect(text).toBe('Plan\n\n# Goals\n- ship #q4\n\nhttps://example.com/a\n\ndetails');
    expect(text).not.toContain('Spec');
  });
});

describe('canvasOutline', () => {
  it('nests cards under their group, lists connections, and shows a no-access card without title or path', () => {
    const out = canvasOutline('Roadmap', doc, files);
    expect(out).toBe(
      [
        '# Roadmap',
        '',
        'JSON Canvas (read-only in Folio): 5 card(s), 1 group(s), 2 connection(s). Coordinates in canvas pixels, top-left corner.',
        '',
        '## Cards',
        '',
        '- [group g] "Plan" (at 0,0 · 800×400 · green)',
        '  - [text t] (at 20,20 · 200×100)',
        '    > # Goals',
        '    > - ship #q4',
        '  - [file f] "Spec" — doc page p1, Notes/Spec.md#Scope (at 300,20 · 200×100)',
        '  - [file s] a page that is not available to you (at 520,20 · 200×100)',
        '- [file m] missing: gone.md — nothing at that path now (at 900,20 · 100×100)',
        '- [link l] https://example.com/a (at 900,200 · 100×100)',
        '',
        '## Connections',
        '',
        '- t ("# Goals - ship #q4") -> f ("Spec"): "details" · red',
        '- f ("Spec") <-> s (not available) [bottom to auto]',
        '',
      ].join('\n'),
    );
  });

  it('says so for an empty canvas and lists what was skipped', () => {
    expect(canvasOutline('Empty', { nodes: [], edges: [] }, {}, ['node 1: no id — skipped'])).toContain('(empty canvas)\n\n## Skipped while reading\n\n- node 1: no id — skipped');
  });
});

describe('colours', () => {
  it('maps presets to Obsidian’s palette per scheme and passes hex through', () => {
    expect(resolveCanvasColor('1', 'light')).toBe('#e93147');
    expect(resolveCanvasColor('1', 'dark')).toBe('#fb464c');
    expect(resolveCanvasColor('6', 'light')).toBe('#7852ee');
    expect(resolveCanvasColor('#123abc', 'dark')).toBe('#123abc');
    expect(resolveCanvasColor(undefined, 'light')).toBeUndefined();
    expect(resolveCanvasColor('teal', 'light')).toBeUndefined();
    expect(normalizeHex('#AbC')).toBe('#aabbcc');
    expect(normalizeHex('#11223344')).toBe('#112233');
    expect(tintHex('#000000', 0.5)).toBe('#808080');
    expect(tintHex('#e93147', 0)).toBe('#ffffff');
  });
});

describe('rewriteCanvasStrings', () => {
  const raw = '{\n\t"nodes":[\n\t\t{"id":"a","type":"file","file":"Notes/Old.md","x":0,"y":0,"width":1,"height":1,"extra":{"file":"Notes/Old.md"}},\n\t\t{"id":"b","type":"text","text":"see [x](Notes/Old.md) \\"file\\": \\u00e9","x":0,"y":0,"width":1,"height":1},\n\t\t{"id":"c","type":"group","background":"img/Old.png","x":0,"y":0,"width":1,"height":1}\n\t],\n\t"edges":[]\n}';

  it('replaces only the asked keys’ string values and keeps every other byte', () => {
    const moved = new Map([['Notes/Old.md', 'Notes/New.md']]);
    const out = rewriteCanvasStrings(raw, [{ key: 'file', map: (v) => movedCanvasPath(v, moved) }]);
    // Both "file" values change (the nested unknown one too — a key is a key); the text card's words do not.
    expect(out).toBe(raw.replaceAll('"file":"Notes/Old.md"', '"file":"Notes/New.md"'));
    expect(out).toContain('\\"file\\": \\u00e9');
    expect(JSON.parse(out).nodes[1].text).toBe('see [x](Notes/Old.md) "file": é');
  });

  it('maps text values through their decoded form and writes them back JSON-encoded', () => {
    const out = rewriteCanvasStrings(raw, [{ key: 'text', map: (v) => v.replace('Notes/Old.md', 'Notes/New.md') }]);
    expect(JSON.parse(out).nodes[1].text).toBe('see [x](Notes/New.md) "file": é');
    // Untouched values keep their original escapes; the rewritten one is plain JSON.stringify.
    expect(out).toContain('"file":"Notes/Old.md"');
  });

  it('follows a moved folder and leaves the file alone when nothing matches or it is not JSON', () => {
    const out = rewriteCanvasStrings(raw, [{ key: 'background', map: (v) => movedCanvasPath(v, new Map(), new Map([['img', 'media/img']])) }]);
    expect(JSON.parse(out).nodes[2].background).toBe('media/img/Old.png');
    expect(rewriteCanvasStrings(raw, [{ key: 'file', map: () => null }])).toBe(raw);
    expect(rewriteCanvasStrings('{"nodes": [', [{ key: 'file', map: () => 'x' }])).toBe('{"nodes": [');
    expect(movedCanvasPath('a/b.md', new Map(), new Map([['a', 'z']]))).toBe('z/b.md');
    expect(movedCanvasPath('ab/c.md', new Map(), new Map([['a', 'z']]))).toBeNull();
  });
});
