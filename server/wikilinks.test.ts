/**
 * Wikilinks (Obsidian vault compatibility, wave 1a), pure — no database:
 * parsing, code masking, the resolution order and the rename/move rewriters.
 * Fixtures are written here; nothing is copied from any third-party vault.
 */
import { describe, expect, it } from 'vitest';
import { buildPagePathIndex, findWikilinks, isAssetLinkPath, maskCode, resolveWikilinkPath, rewriteWikilinks } from './wikilinks.js';
import { rebaseRelativeLinks, rewriteRelativeLinks, type WikiMoveContext } from './links.js';

describe('findWikilinks', () => {
  it('splits path, heading/block tail and alias, and spots embeds', () => {
    const body = 'A [[Note]] B [[Note|alias]] C [[Note#Heading]] D [[Note#^abc123]] E ![[Note]] F ![[pic.png|300]] G [[Note#H|shown]]';
    const refs = findWikilinks(body);
    expect(refs.map((r) => [r.embed, r.path, r.rest])).toEqual([
      [false, 'Note', ''],
      [false, 'Note', '|alias'],
      [false, 'Note', '#Heading'],
      [false, 'Note', '#^abc123'],
      [true, 'Note', ''],
      [true, 'pic.png', '|300'],
      [false, 'Note', '#H|shown'],
    ]);
    for (const r of refs) expect(body.slice(r.start, r.end)).toMatch(/^!?\[\[.*\]\]$/);
  });

  it('keeps the escaped pipe of a table cell with the alias part, and surrounding spaces off the path', () => {
    const [cell, spaced] = findWikilinks('| [[Folder/Note\\|alias]] | [[ Spaced name ]] |');
    expect(cell.path).toBe('Folder/Note');
    expect(cell.rest).toBe('\\|alias');
    expect(spaced.path).toBe('Spaced name');
    expect(spaced.lead + spaced.trail).toBe('  ');
  });

  it('a same-page link has an empty path; [[x]](url) is a markdown link, not a wikilink', () => {
    expect(findWikilinks('[[#Heading]]')[0].path).toBe('');
    expect(findWikilinks('[[x]](https://example.com)')).toEqual([]);
  });

  it('ignores wikilinks inside fenced code and inline code', () => {
    const body = ['Real [[One]]', '```md', 'Fake [[Two]]', '```', '`[[Three]]` and ``a ` [[Four]]`` and [[Five]]', '~~~', '[[Six]]', '~~~'].join('\n');
    expect(findWikilinks(body).map((r) => r.path)).toEqual(['One', 'Five']);
  });
});

describe('maskCode', () => {
  it('keeps the length, blanks only code, keeps newlines', () => {
    const body = 'text `a](b.md)` more\n```\n[x](y.md)\n```\n[ok](z.md)';
    const masked = maskCode(body);
    expect(masked.length).toBe(body.length);
    expect(masked).not.toContain('b.md');
    expect(masked).not.toContain('y.md');
    expect(masked).toContain('[ok](z.md)');
    expect(masked.split('\n').length).toBe(body.split('\n').length);
  });

  it('an unmatched backtick and an unclosed span at a blank line are plain text; an unclosed fence runs to the end', () => {
    expect(maskCode('one ` tick [[A]]\n\ntwo ` [[B]]')).toContain('[[A]]');
    expect(findWikilinks('x\n```\n[[Hidden]]\nno close').length).toBe(0);
  });
});

describe('resolveWikilinkPath', () => {
  const index = buildPagePathIndex([
    'Home.md',
    'Guide/Install.md',
    'Guide/Setup/Install.md',
    'Guide/Setup/Details.md',
    'Notes/My Note.md',
    'Other/Details.md',
    'Reports/Q1.pdf',
    'Deep/Down/Here.md',
  ]);

  it('a bare name is name.md anywhere in the space, case-insensitive', () => {
    expect(resolveWikilinkPath(index, '', 'Home')).toBe('Home.md');
    expect(resolveWikilinkPath(index, 'Anything/Else', 'home')).toBe('Home.md');
    expect(resolveWikilinkPath(index, '', 'My Note')).toBe('Notes/My Note.md');
    expect(resolveWikilinkPath(index, '', 'Home.md')).toBe('Home.md');
  });

  it('%20 is literal first, then decoded; unknown names are unresolved', () => {
    expect(resolveWikilinkPath(index, '', 'My%20Note')).toBe('Notes/My Note.md');
    expect(resolveWikilinkPath(index, '', 'Nothing here')).toBeNull();
    expect(resolveWikilinkPath(index, '', '100%')).toBeNull();
  });

  it('a path resolves from the source folder first, then from the space root, then as a trailing path', () => {
    expect(resolveWikilinkPath(index, 'Guide', 'Setup/Install')).toBe('Guide/Setup/Install.md'); // relative to the source
    expect(resolveWikilinkPath(index, 'Elsewhere', 'Guide/Install')).toBe('Guide/Install.md'); // from the root
    expect(resolveWikilinkPath(index, 'Elsewhere', 'Setup/Install')).toBe('Guide/Setup/Install.md'); // trailing path
    expect(resolveWikilinkPath(index, 'Guide/Setup', '../Install')).toBe('Guide/Install.md'); // explicit relative
    expect(resolveWikilinkPath(index, 'Guide/Setup', '../../Home')).toBe('Home.md');
    expect(resolveWikilinkPath(index, '', '../Home')).toBeNull();
  });

  it('an ambiguous bare name takes the page nearest to the source, then the shallowest', () => {
    expect(resolveWikilinkPath(index, 'Guide/Setup', 'Install')).toBe('Guide/Setup/Install.md');
    expect(resolveWikilinkPath(index, 'Guide', 'Install')).toBe('Guide/Install.md');
    expect(resolveWikilinkPath(index, 'Other', 'Details')).toBe('Other/Details.md');
    expect(resolveWikilinkPath(index, 'Deep', 'Details')).toBe('Other/Details.md'); // equally far: fewer folders wins
  });

  it('a file link keeps its extension; asset-looking names are told apart', () => {
    expect(resolveWikilinkPath(index, '', 'Reports/Q1.pdf')).toBe('Reports/Q1.pdf');
    expect(isAssetLinkPath('photo.PNG')).toBe(true);
    expect(isAssetLinkPath('Version 1.2 notes')).toBe(false);
  });
});

describe('rewriteWikilinks through rewriteRelativeLinks / rebaseRelativeLinks', () => {
  function world(before: string[], moves: Array<[string, string]>) {
    const files = new Map(moves);
    const after = before.map((p) => files.get(p) ?? p);
    const ctx: WikiMoveContext = { oldIndex: buildPagePathIndex(before), newIndex: buildPagePathIndex(after) };
    return { ctx, files };
  }

  it('a renamed target: [[old]] becomes [[new]] and keeps the alias, heading, block and embed marks', () => {
    const { ctx } = world(['docs/old-name.md', 'docs/other.md'], [['docs/old-name.md', 'docs/new-slug.md']]);
    const body = 'a [[old-name]] b [[old-name|alias]] c [[old-name#Part]] d [[old-name#^blk|x]] e ![[old-name]] f [[other]]\n';
    const out = rewriteRelativeLinks(body, 'docs', 'docs/old-name.md', 'docs/new-slug.md', ctx);
    expect(out).toBe('a [[new-slug]] b [[new-slug|alias]] c [[new-slug#Part]] d [[new-slug#^blk|x]] e ![[new-slug]] f [[other]]\n');
  });

  it('keeps the extension habit, the folder part and the percent-encoding of the link as written', () => {
    const { ctx } = world(['Notes/My Note.md', 'Home.md'], [['Notes/My Note.md', 'Notes/Renamed Note.md']]);
    const body = '[[My Note.md]] [[Notes/My Note]] [[My%20Note]] [[../Notes/My Note|a]]\n';
    const out = rewriteRelativeLinks(body, 'Home-dir', 'Notes/My Note.md', 'Notes/Renamed Note.md', ctx);
    expect(out).toBe('[[Renamed Note.md]] [[Notes/Renamed Note]] [[Renamed%20Note]] [[../Notes/Renamed Note|a]]\n');
  });

  it('leaves unrelated wikilinks, unresolved ones, links in code and every other byte alone; same reference when nothing changes', () => {
    const { ctx } = world(['a/target.md', 'a/other.md'], [['a/target.md', 'a/moved.md']]);
    const body = '  odd   spacing [[other]] [[ghost]] `[[target]]`\n\n```\n[[target]]\n```\n\r\n[md](other.md)\n';
    expect(rewriteRelativeLinks(body, 'a', 'a/target.md', 'a/moved.md', ctx)).toBe(body);
    expect(Object.is(rewriteRelativeLinks(body, 'a', 'a/target.md', 'a/moved.md', ctx), body)).toBe(true);
    const withLink = `${body}[[target]] and [md](target.md)\n`;
    expect(rewriteRelativeLinks(withLink, 'a', 'a/target.md', 'a/moved.md', ctx)).toBe(`${body}[[moved]] and [md](moved.md)\n`);
  });

  it('a rename that makes the bare name ambiguous falls back to a path that still resolves to the target', () => {
    const { ctx } = world(['x/old.md', 'a/new.md'], [['x/old.md', 'x/new.md']]);
    // from "z" the bare [[new]] now matches a/new.md and x/new.md equally (a/ sorts first): the link must say which one
    expect(rewriteRelativeLinks('[[old]]\n', 'z', 'x/old.md', 'x/new.md', ctx)).toBe('[[x/new]]\n');
  });

  it('a renamed directory carries wikilinks into it: [[dir/page]] and a bare name that stays unique', () => {
    const before = ['old-dir/index.md', 'old-dir/page.md'];
    const { ctx } = world(before, [
      ['old-dir/index.md', 'new-dir/index.md'],
      ['old-dir/page.md', 'new-dir/page.md'],
    ]);
    let body = '[[old-dir/page]] [[page]] [[old-dir/page#H|t]]\n';
    body = rewriteRelativeLinks(body, '', 'old-dir/index.md', 'new-dir/index.md', ctx);
    body = rewriteRelativeLinks(body, '', 'old-dir/page.md', 'new-dir/page.md', ctx);
    expect(body).toBe('[[new-dir/page]] [[page]] [[new-dir/page#H|t]]\n');
  });

  it('a moved target: bare names stay, path-style links follow', () => {
    const { ctx, files } = world(['a/page.md', 'a/src.md', 'b/keep.md'], [['a/page.md', 'c/d/page.md']]);
    const body = '[[page]] [[a/page]] [[./page]] [[keep]]\n';
    const out = rebaseRelativeLinks(body, 'a', 'a', files, new Map(), ctx);
    expect(out).toBe('[[page]] [[c/d/page]] [[../c/d/page]] [[keep]]\n');
  });

  it('a moved source: explicit relative links follow it, root-style and bare ones need nothing', () => {
    const { ctx, files } = world(['a/src.md', 'a/near.md', 'top/page.md', 'a/sub/leaf.md'], [['a/src.md', 'a/deeper/more/src.md']]);
    const body = '[[../top/page]] [[top/page]] [[page]] [[./sub/leaf]] [[near]]\n';
    const out = rebaseRelativeLinks(body, 'a', 'a/deeper/more', files, new Map(), ctx);
    expect(out).toBe('[[../../../top/page]] [[top/page]] [[page]] [[../../sub/leaf]] [[near]]\n');
  });

  it('wikilinks are untouched when no context is given (markdown links still move)', () => {
    const files = new Map([['a/t.md', 'b/t.md']]);
    expect(rebaseRelativeLinks('[[t]] [m](t.md)\n', 'a', 'a', files)).toBe('[[t]] [m](../b/t.md)\n');
    expect(rewriteRelativeLinks('[[t]] [m](t.md)\n', 'a', 'a/t.md', 'a/u.md')).toBe('[[t]] [m](u.md)\n');
  });

  it('markdown links inside code are no longer rewritten', () => {
    const files = new Map([['a/t.md', 'b/t.md']]);
    const body = '`[m](t.md)`\n\n```\n[m](t.md)\n```\n[m](t.md)\n';
    expect(rebaseRelativeLinks(body, 'a', 'a', files)).toBe('`[m](t.md)`\n\n```\n[m](t.md)\n```\n[m](../b/t.md)\n');
  });

  it('rewriteWikilinks on its own: same reference when no wikilink exists', () => {
    const index = buildPagePathIndex(['a.md']);
    const body = 'plain [md](a.md)\n';
    expect(rewriteWikilinks(body, { oldDir: '', newDir: '', oldIndex: index, newIndex: index, mapTarget: (p) => p })).toBe(body);
  });
});
