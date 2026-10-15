import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpTestSchema } from './db/testSchema.js';
import * as storage from './storage.js';
import * as links from './links.js';
import { query } from './db/pool.js';

describe('links / backlinks (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let spaceSlug: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const space = await storage.createSpace(`Links Test ${Date.now()}`, null);
    spaceSlug = space.slug;
  });

  afterAll(async () => {
    const root = (await storage.listEntries(spaceSlug)).find((e) => e.dirPath === '' && e.isIndex);
    if (root) await storage.deletePage(root.id).catch(() => {});
    await teardownSchema();
  });

  it('a relative markdown link is picked up as a backlink on the target page', async () => {
    const target = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Target Page', kind: 'doc' });
    const source = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Source Page', kind: 'doc' });

    await storage.writeDocBody(source.id, `# Source Page\n\nSee [target](./${target.path}) for details.\n`);

    const backlinks = await links.getBacklinks(target.id);
    expect(backlinks.map((b) => b.id)).toContain(source.id);
  });

  it('external and broken links are classified but never appear as page backlinks', async () => {
    const target = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Another Target', kind: 'doc' });
    const source = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Mixed Links', kind: 'doc' });

    await storage.writeDocBody(
      source.id,
      `# Mixed Links\n\n` + `[external](https://example.com/x) ` + `[broken](./does-not-exist.md) ` + `[good](./${target.path})\n`,
    );

    const backlinks = await links.getBacklinks(target.id);
    expect(backlinks.map((b) => b.id)).toContain(source.id);

    const rows = await query<{ kind: string; target_page_id: string | null }>('SELECT kind, target_page_id FROM links WHERE source_page_id = $1', [
      source.id,
    ]);
    expect(rows.some((r) => r.kind === 'external')).toBe(true);
    expect(rows.some((r) => r.kind === 'broken')).toBe(true);
    expect(rows.some((r) => r.kind === 'page' && r.target_page_id === target.id)).toBe(true);
  });

  it('a percent-encoded or extensionless link to an existing page is a page link, and resolve() opens it', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = storage.getSpaceDir(spaceSlug);
    await fs.mkdir(path.join(dir, 'guide'), { recursive: true });
    await fs.writeFile(path.join(dir, 'guide', 'Getting Started.md'), '# Getting Started\n', 'utf8');
    await fs.writeFile(path.join(dir, 'guide', 'install.md'), '# Install\n', 'utf8');
    await storage.scanSpace(spaceSlug);
    const started = (await storage.getEntryIdByExactPath(spaceSlug, 'guide/Getting Started.md'))!;
    const install = (await storage.getEntryIdByExactPath(spaceSlug, 'guide/install.md'))!;
    expect(started && install).toBeTruthy();

    const source = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Tolerant Links', kind: 'doc' });
    await storage.writeDocBody(source.id, '# Tolerant Links\n\n[a](guide/Getting%20Started.md) [b](./guide/install) [c](guide/missing)\n');
    const rows = await query<{ kind: string; target_page_id: string | null; target_path: string }>(
      'SELECT kind, target_page_id, target_path FROM links WHERE source_page_id = $1 ORDER BY target_path',
      [source.id],
    );
    expect(rows.filter((r) => r.kind === 'page').map((r) => r.target_page_id).sort()).toEqual([started, install].sort());
    // Wave 3: a non-page target that is no file of the space (and no folder) is unresolved, not an asset.
    expect(rows.find((r) => r.target_path === 'guide/missing')?.kind).toBe('broken');
    expect((await links.getBacklinks(started)).map((b) => b.id)).toContain(source.id);

    expect((await storage.resolve(spaceSlug, 'guide/Getting%20Started.md')).id).toBe(started);
    expect((await storage.resolve(spaceSlug, 'guide/Getting%20Started')).id).toBe(started);
    expect((await storage.resolve(spaceSlug, 'guide/install')).id).toBe(install);
    await expect(storage.resolve(spaceSlug, 'guide/missing')).rejects.toThrow();
    // A malformed escape is a miss, not a crash.
    await expect(storage.resolve(spaceSlug, 'guide/100%.md')).rejects.toThrow(/page/);
  });

  it('delete+reinsert: removing the link from the source body removes the backlink', async () => {
    const target = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Volatile Target', kind: 'doc' });
    const source = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Volatile Source', kind: 'doc' });
    await storage.writeDocBody(source.id, `# Volatile Source\n\n[link](./${target.path})\n`);
    expect((await links.getBacklinks(target.id)).map((b) => b.id)).toContain(source.id);

    await storage.writeDocBody(source.id, `# Volatile Source\n\nNo links here anymore.\n`);
    expect((await links.getBacklinks(target.id)).map((b) => b.id)).not.toContain(source.id);
  });

  it('a fresh boot-style scanSpace also (re)indexes links from scratch', async () => {
    const target = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Scan Target', kind: 'doc' });
    const source = await storage.createPage({ space: spaceSlug, parentPath: '', title: 'Scan Source', kind: 'doc' });
    await storage.writeDocBody(source.id, `# Scan Source\n\n[link](./${target.path})\n`);

    // Simulate a boot rescan wiping and rebuilding the derived index from disk alone.
    await query('DELETE FROM links WHERE source_page_id = $1', [source.id]);
    expect((await links.getBacklinks(target.id)).map((b) => b.id)).not.toContain(source.id);

    await storage.scanSpace(spaceSlug);
    expect((await links.getBacklinks(target.id)).map((b) => b.id)).toContain(source.id);
  });
});

describe('rewriteRelativeLinks (round 22 slug-rename link rewriter, pure — no DB)', () => {
  it('rewrites a same-directory link to a renamed leaf page', () => {
    const body = 'See [target](old-name.md) for details.\n';
    const out = links.rewriteRelativeLinks(body, 'docs', 'docs/old-name.md', 'docs/new-slug.md');
    expect(out).toBe('See [target](new-slug.md) for details.\n');
  });

  it('rewrites a cross-directory link (adds/removes the right number of "..")', () => {
    const body = '[target](../../docs/old-name.md)\n'; // from "guides/deep": up twice to root, then down into docs/
    const out = links.rewriteRelativeLinks(body, 'guides/deep', 'docs/old-name.md', 'docs/new-slug.md');
    expect(out).toBe('[target](../../docs/new-slug.md)\n');
  });

  it('leaves external, root-relative, and non-matching links untouched, and returns the SAME string reference when nothing changed', () => {
    const body = '[ext](https://example.com/old-name.md) [root](/old-name.md) [other](sibling.md)\n';
    const out = links.rewriteRelativeLinks(body, 'docs', 'docs/old-name.md', 'docs/new-slug.md');
    expect(out).toBe(body);
    expect(out).toBe(body); // same content
    expect(Object.is(out, body)).toBe(true); // AND the same reference — a cheap no-op-write guard for callers
  });

  it('preserves an optional "title" suffix and any #fragment/?query', () => {
    const body = '[t](old-name.md "A Title") [f](old-name.md#section) [q](old-name.md?x=1)\n';
    const out = links.rewriteRelativeLinks(body, 'docs', 'docs/old-name.md', 'docs/new-slug.md');
    expect(out).toBe('[t](new-slug.md "A Title") [f](new-slug.md#section) [q](new-slug.md?x=1)\n');
  });

  it('rewrites BOTH an explicit "dir/index.md" link and an implicit bare-directory link to a renamed directory-index, preserving each one\'s own style', () => {
    const body = '[explicit](old-name/index.md) [implicit](old-name) [implicit-slash](old-name/)\n';
    const out = links.rewriteRelativeLinks(body, '', 'old-name/index.md', 'new-slug/index.md');
    expect(out).toBe('[explicit](new-slug/index.md) [implicit](new-slug) [implicit-slash](new-slug/)\n');
  });

  it('an implicit bare-directory link is NOT rewritten when the target\'s index is README.md, not index.md (matches classify()\'s own asymmetric resolution — such a link was never indexed as a backlink in the first place)', () => {
    const body = '[implicit](old-name)\n';
    const out = links.rewriteRelativeLinks(body, '', 'old-name/README.md', 'new-slug/README.md');
    expect(out).toBe(body); // untouched: classify() never resolves a bare "old-name" to a README.md-indexed page either
  });
});

describe('rebaseRelativeLinks (move link rewriter, pure — no DB)', () => {
  const none = new Map<string, string>();

  it('re-relativizes links and images of a doc that moved deeper', () => {
    const body = '![img](../assets/a.png) [sib](sibling.md) [up](../top.md)\n';
    // docs/page.md -> docs/archive/old/page.md; targets stay put
    const out = links.rebaseRelativeLinks(body, 'docs', 'docs/archive/old', none);
    expect(out).toBe('![img](../../../assets/a.png) [sib](../../sibling.md) [up](../../../top.md)\n');
  });

  it('re-relativizes links of a doc that moved shallower, collapsing ../ chains', () => {
    const body = '[a](../../x/y.md) ![i](../../assets/p.png) [s](same.md)\n';
    // a/b/page.md -> page.md
    const out = links.rebaseRelativeLinks(body, 'a/b', '', none);
    expect(out).toBe('[a](x/y.md) ![i](assets/p.png) [s](a/b/same.md)\n');
  });

  it('keeps links between two co-moved pages verbatim', () => {
    const files = new Map([
      ['a/one.md', 'z/one.md'],
      ['a/two.md', 'z/two.md'],
    ]);
    const body = '[two](./two.md) [two2](two.md#h "T")\n';
    expect(links.rebaseRelativeLinks(body, 'a', 'z', files)).toBe(body);
  });

  it('maps a link to a moved target and rewrites it from the new dir', () => {
    const files = new Map([['a/target.md', 'b/c/target.md']]);
    const body = '[t](target.md) [t2](../a/target.md)\n';
    // the source stays in "a"
    expect(links.rebaseRelativeLinks(body, 'a', 'a', files)).toBe('[t](../b/c/target.md) [t2](../b/c/target.md)\n');
  });

  it('composes: a doc that moved AND links to another moved page and an unmoved one', () => {
    const files = new Map([
      ['a/src.md', 'b/src.md'],
      ['a/other.md', 'b/other.md'],
    ]);
    const body = '[o](other.md) [u](../unmoved.md)\n';
    expect(links.rebaseRelativeLinks(body, 'a', 'b', files)).toBe(body);
    // the moved page links to a page that moved elsewhere
    const files2 = new Map([['a/other.md', 'c/other.md']]);
    expect(links.rebaseRelativeLinks('[o](other.md)\n', 'a', 'b', files2)).toBe('[o](../c/other.md)\n');
  });

  it('handles moved directories: explicit index, implicit dir link, trailing slash, and non-page files inside', () => {
    const dirs = new Map([['notes', 'archive/notes']]);
    const files = new Map([['notes/index.md', 'archive/notes/index.md']]);
    const body = '[e](notes/index.md) [i](notes) [s](notes/) ![p](notes/pic.png)\n';
    expect(links.rebaseRelativeLinks(body, '', '', files, dirs)).toBe(
      '[e](archive/notes/index.md) [i](archive/notes) [s](archive/notes/) ![p](archive/notes/pic.png)\n',
    );
  });

  it('a doc inside a moved directory keeps links to its neighbours, but links leaving the directory are re-aimed', () => {
    const dirs = new Map([['notes', 'archive/notes']]);
    const body = '![p](pic.png) [out](../elsewhere.md) [kid](child/page.md)\n';
    expect(links.rebaseRelativeLinks(body, 'notes', 'archive/notes', none, dirs)).toBe('![p](pic.png) [out](../../elsewhere.md) [kid](child/page.md)\n');
  });

  it('preserves ?query, #hash and "title" when re-aiming', () => {
    const body = '[a](x.md#sec "Title") [b](x.md?q=1) [c](x.md?q=1#h)\n';
    const out = links.rebaseRelativeLinks(body, 'a', 'a/b', none);
    expect(out).toBe('[a](../x.md#sec "Title") [b](../x.md?q=1) [c](../x.md?q=1#h)\n');
  });

  it('leaves external, root-relative, mailto and pure-anchor hrefs alone', () => {
    const body = '[a](https://e.com/x.md) [b](/abs/x.md) [c](mailto:a@b.c) [d](#top) ![e](data:image/png;base64,AA)\n';
    const out = links.rebaseRelativeLinks(body, 'a', 'x/y/z', none);
    expect(out).toBe(body);
  });

  it('returns the same reference when nothing changes (unmoved doc, unmoved targets)', () => {
    const body = '[a](x.md) ![i](../p.png)\n';
    expect(links.rebaseRelativeLinks(body, 'd', 'd', none)).toBe(body);
    expect(links.rebaseRelativeLinks(body, 'd', 'd', new Map([['q/other.md', 'r/other.md']]))).toBe(body);
  });

  it('leaves a link that already escaped the space (broken before the move) untouched', () => {
    const body = '[a](../../outside.md)\n';
    expect(links.rebaseRelativeLinks(body, 'a', 'b/c', none)).toBe(body);
  });
});
