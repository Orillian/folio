/**
 * Index v2 parser (pure): headings and their anchors, ^block ids, tags with
 * their exclusions, every link syntax with fragment/line/context, nothing from
 * code — and the rename rewriters agree with it on what code is.
 */
import { describe, expect, it } from 'vitest';
import { createSlugDeduper, slugifyHeading } from '../../shared/headingSlug.js';
import { rebaseRelativeLinks, rewriteRelativeLinks } from '../links.js';
import { buildPagePathIndex } from '../wikilinks.js';
import { fragmentInfo, normalizeTag, parsePageMeta } from './parse.js';

describe('index v2 parser', () => {
  it('headings: label, the outline anchor with duplicate suffixes, line and order; slugs match the web outline', () => {
    const { headings } = parsePageMeta('# Title\n\n## Overview\n\ntext\n\n## Overview\n\n### **Bold** *plan* `x` ==Done=={.green}\n\n## Wie funktioniert das für Übungen?\n');
    expect(headings.map((h) => [h.level, h.text, h.slug, h.line, h.position])).toEqual([
      [1, 'Title', 'title', 1, 0],
      [2, 'Overview', 'overview', 3, 1],
      [2, 'Overview', 'overview-2', 7, 2],
      [3, 'Bold plan x Done', 'bold-plan-x-donegreen', 9, 3],
      [2, 'Wie funktioniert das für Übungen?', 'wie-funktioniert-das-für-übungen', 11, 4],
    ]);
    // the same examples web/src/markdown/headings.test.ts pins for the outline
    expect(slugifyHeading('What is this, exactly?!')).toBe('what-is-this-exactly');
    expect(slugifyHeading('Too   many    spaces')).toBe('too-many-spaces');
    const dedupe = createSlugDeduper();
    expect(['Doc', 'Overview', 'Overview'].map(dedupe)).toEqual(['doc', 'overview', 'overview-2']);
  });

  it('block ids end a paragraph or list item, or stand alone under a table; not inside code', () => {
    const body = ['A paragraph ^para-1', '', '- item one ^Item2', '- item two', '', '| a |', '|---|', '| b |', '', '^table-id', '', '```', 'code ^nope', '```', '', 'mid ^x text', '', '![[img.png]]^after-embed', '', 'word^glued'].join('\n');
    expect(parsePageMeta(body).blocks).toEqual([
      { blockId: 'para-1', line: 1 },
      { blockId: 'Item2', line: 3 },
      { blockId: 'table-id', line: 10 },
      { blockId: 'after-embed', line: 18 },
    ]);
  });

  it('tags: #tag and #a/b in prose; not #123, hex colours, x#y, \\#esc, code, links or URLs; front matter tags/labels too', () => {
    const body = [
      'Plan #Project/Alpha and #todo, #123 #fff #a1b2c3 #ffffff are not tags but #cafe and #y1984 are.',
      'Not a#tag, not \\#escaped, not `#code`, not [#linked](x.md), not https://example.com/#anchor.',
      '',
      '    #indented-code',
      '',
      '## Heading with #heading-tag',
    ].join('\n');
    const { tags } = parsePageMeta(body, { tags: ['Fm', '#todo'], labels: 'release, q4 draft', title: 'x' });
    expect(tags.filter((t) => t.source === 'body').map((t) => `${t.tag}@${t.line}`)).toEqual(['project/alpha@1', 'todo@1', 'cafe@1', 'y1984@1', 'heading-tag@6']);
    expect(tags.filter((t) => t.source === 'frontmatter').map((t) => t.tag)).toEqual(['fm', 'todo', 'release', 'q4', 'draft']);
    expect(normalizeTag('#123')).toBeNull();
    expect(normalizeTag('#Beef')).toBe('beef');
    expect(normalizeTag('#e0e0e0')).toBeNull();
  });

  it('links of every syntax with fragment, display text, line and context; autolinks, same-page links and code are skipped', () => {
    const body = [
      '# Links', // 1
      '', // 2
      'See [the doc](../guide/doc.md#Install%20Steps "title") and ![a diagram](img/flow.png).', // 3
      '- [[Note#Part one|alias]], [[Note#^blk]], ![[photo.png|300]], [[Folder/Deep note]]', // 4
      'Ref [use it][r1] and <a href="h.md#^b2">html</a> <img src="pic.svg" alt="pic">', // 5
      '', // 6
      '[r1]: ./ref.md', // 7
      'Auto <https://auto.example/> and https://bare.example, same page [x](#local) [[#Local]], external [e](https://example.com/a#b).', // 8
      '`[c](code.md) [[Code]]`', // 9
      '```', // 10
      '[f](fence.md) [[Fence]]', // 11
      '```', // 12
      '', // 13
      '    [i](indented.md) [[Indented]]', // 14
    ].join('\n');
    const { links } = parsePageMeta(body);
    expect(links.map((l) => [l.syntax, l.linkPath, l.fragment, l.fragmentKind, l.fragmentKey, l.displayText, l.line])).toEqual([
      ['md', '../guide/doc.md', 'Install%20Steps', 'heading', 'install-steps', 'the doc', 3],
      ['image', 'img/flow.png', null, null, null, 'a diagram', 3],
      ['wikilink', 'Note', 'Part one', 'heading', 'part-one', 'alias', 4],
      ['wikilink', 'Note', '^blk', 'block', 'blk', null, 4],
      ['embed', 'photo.png', null, null, null, '300', 4],
      ['wikilink', 'Folder/Deep note', null, null, null, null, 4],
      ['reference', './ref.md', null, null, null, 'use it', 5],
      ['html', 'h.md', '^b2', 'block', 'b2', null, 5],
      ['html', 'pic.svg', null, null, null, 'pic', 5],
      ['md', 'https://example.com/a#b', null, null, null, 'e', 8],
    ]);
    expect(links[0].context).toBe('See [the doc](../guide/doc.md#Install%20Steps "title") and ![a diagram](img/flow.png).');
    expect(parsePageMeta(`[x](y.md) ${'z'.repeat(400)}`).links[0].context).toHaveLength(300);
    expect(fragmentInfo('H1#Sub heading')).toEqual({ fragment: 'H1#Sub heading', kind: 'heading', key: 'sub-heading' });
  });

  it('the rewriters agree with the parser: links in fenced, indented and inline code are never rewritten', () => {
    const body = ['[a](old.md) [[old]]', '`[b](old.md) [[old]]`', '```', '[c](old.md) [[old]]', '```', '', '    [d](old.md) [[old]]', ''].join('\n');
    const wiki = { oldIndex: buildPagePathIndex(['old.md']), newIndex: buildPagePathIndex(['new.md']) };
    const renamed = rewriteRelativeLinks(body, '', 'old.md', 'new.md', wiki);
    expect(renamed.split('\n')[0]).toBe('[a](new.md) [[new]]');
    expect(renamed.split('\n').slice(1)).toEqual(body.split('\n').slice(1));
    const moved = rebaseRelativeLinks(body, '', 'sub', new Map(), new Map(), wiki);
    expect(moved.split('\n')[0]).toBe('[a](../old.md) [[old]]');
    expect(moved.split('\n').slice(1)).toEqual(body.split('\n').slice(1));
    // and the index sees exactly the one link pair outside code
    expect(parsePageMeta(body).links.map((l) => l.linkPath)).toEqual(['old.md', 'old']);
  });

  it('does not index tags or links inside a %%comment%% (hidden in the reading view), but does outside one', () => {
    const body = 'Seen #keep [[Seen]] [s](seen.md) %% hidden #gone [[Unseen]] [u](unseen.md) ![[hidden.png]] %% more #after\n\n%%\nblock #blockgone [[BlockUnseen]]\n%%\n\n`%% in code #incode %%` #codetag\n';
    const meta = parsePageMeta(body);
    expect(meta.tags.map((t) => t.tag)).toEqual(['keep', 'after', 'codetag']);
    expect(meta.links.map((l) => l.linkPath).sort()).toEqual(['Seen', 'seen.md']);
  });
});
