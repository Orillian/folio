/**
 * Full-text search and Obsidian comments (wave 2): a `%%comment%%` is not
 * content, everything else (wikilink brackets, #tags, formulas) stays
 * searchable, and a page without any of it is indexed byte for byte as before.
 * Real PG: both write paths of the index (the scan and patchEntryContent).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authStore from './auth/store.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { docIndexText } from './indexText.js';
import { searchPages } from './search.js';
import * as storage from './storage.js';

describe('plain text for search: comments are not content (real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let userId: string;
  let slug: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    userId = (await authStore.createUser({ email: `ofm-search-${Date.now()}@example.com`, name: 'Searcher', passwordHash: 'x', isAdmin: false })).id;
    slug = (await storage.createSpace(`Ofm Search ${Date.now()}`, userId)).slug;
    await authStore.setMembership(slug, userId, 'admin');
  });
  afterAll(async () => {
    await deleteTestSpace(slug);
    await teardownSchema();
  });

  const plainText = async (id: string) => (await query<{ plain_text: string | null }>('SELECT plain_text FROM pages_index WHERE id = $1', [id]))[0].plain_text;
  const found = async (q: string, id: string) => (await searchPages(q, { userId, space: slug })).some((h) => h.id === id);

  it('docIndexText: strips comments (also across paragraphs), keeps code, wikilinks, tags and formulas; plain text is returned untouched', () => {
    expect(docIndexText('Visible %%gone%% words')).toBe('Visible  words');
    expect(docIndexText('before\n\n%%\nfirst\n\nsecond\n%%\n\nafter\n')).toBe('before\n\n\n\nafter\n');
    const kept = 'A [[Some Note]] #tag $x^2$ and `%%code%%`\n\n```\n%%fenced%%\n```\n';
    expect(docIndexText(kept)).toBe(kept);
    const plain = '# Plain\n\nJust words, 100% sure.\n\n- a\n- b\n';
    expect(docIndexText(plain)).toBe(plain);
    expect(docIndexText('')).toBe('');
    expect(docIndexText('Done :status[Fine]{color=green} %%x%%')).toBe('Done Fine ');
  });

  it('a scanned page: found by visible words, the tag and the wikilink target, not by the comment', async () => {
    const dir = storage.getSpaceDir(slug);
    await fs.mkdir(path.dirname(path.join(dir, 'commented.md')), { recursive: true });
    await fs.writeFile(path.join(dir, 'commented.md'), '# Commented page\n\nVisible words %%secret words%% and #mytag and [[Some Note]]\n', 'utf8');
    await storage.scanSpace(slug);
    const id = (await storage.getEntryIdByExactPath(slug, 'commented.md'))!;
    expect(await found('visible', id)).toBe(true);
    expect(await found('mytag', id)).toBe(true);
    expect(await found('Some Note', id)).toBe(true);
    expect(await found('secret', id)).toBe(false);
    expect(await plainText(id)).not.toContain('secret');
  });

  it('an edited page (patchEntryContent): the comment leaves the index when it is typed, and returns when it is removed', async () => {
    const meta = await storage.createPage({ space: slug, parentPath: '', title: 'Edited page', kind: 'doc' });
    await storage.writeDocBody(meta.id, '# Edited page\n\nPlain words only.\n');
    expect(await found('plain', meta.id)).toBe(true);
    await storage.writeDocBody(meta.id, '# Edited page\n\nPlain words %%zanzibar note%% only.\n');
    expect(await found('zanzibar', meta.id)).toBe(false);
    expect(await found('plain', meta.id)).toBe(true);
    await storage.writeDocBody(meta.id, '# Edited page\n\nPlain words zanzibar only.\n');
    expect(await found('zanzibar', meta.id)).toBe(true);
  });

  it('a page without any OFM is indexed byte for byte as its body, on both write paths', async () => {
    const body = '# Plain page\n\nSome words, a [link](other.md), 100% sure, `code`, a | pipe.\n\n- one\n- two\n';
    const meta = await storage.createPage({ space: slug, parentPath: '', title: 'Plain page', kind: 'doc' });
    await storage.writeDocBody(meta.id, body);
    expect(await plainText(meta.id)).toBe(body);

    const dir = storage.getSpaceDir(slug);
    await fs.writeFile(path.join(dir, 'plain-scanned.md'), body, 'utf8');
    await storage.scanSpace(slug);
    const scanned = (await storage.getEntryIdByExactPath(slug, 'plain-scanned.md'))!;
    expect(await plainText(scanned)).toBe(await storage.readFreshDocBody(scanned));
    expect(await plainText(scanned)).toBe(body);
  });

  it('a %% inside a fenced block or a code span is code: kept in the text and searchable', async () => {
    const meta = await storage.createPage({ space: slug, parentPath: '', title: 'Code page', kind: 'doc' });
    const body = '# Code page\n\n```text\nliteral %%kept words%% here\n```\n\nand `%%inline kept%%` too\n';
    await storage.writeDocBody(meta.id, body);
    expect(await plainText(meta.id)).toBe(body);
    expect(await found('kept', meta.id)).toBe(true);
  });
});
