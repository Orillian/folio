/**
 * The card core's access matrix against a real PG schema and real space repositories: who gets a
 * full card, a limited one, or the title-less "no access" card, for pages, restricted pages,
 * `.agent/**`, the space home, share links and public sites.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '../../../shared/contracts.js';
import * as authStore from '../../auth/store.js';
import { deleteTestSpace, setUpTestSchema } from '../../db/testSchema.js';
import { query } from '../../db/pool.js';
import * as pageAccess from '../../pageAccess.js';
import { invalidatePublicSiteCache } from '../../publicSites.js';
import * as shares from '../../shares.js';
import * as storage from '../../storage.js';
import { buildChatCard, classifyFolioUrl, plainExcerpt, type ChatCard } from './card.js';

const BASE = 'https://folio.example.com';

let teardown: () => Promise<void>;
let prevPublicUrl: string | undefined;
let space: string;
let pubSpace: string;
let owner: User;
let editor: User;
let viewer: User;
let granted: User;
let outsider: User;
let instanceAdmin: User;
const ids: Record<string, string> = {};

async function write(slug: string, rel: string, content: string): Promise<void> {
  const abs = path.join(storage.getRepoDir(slug), rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}
async function idOf(slug: string, rel: string): Promise<string> {
  const id = await storage.getEntryIdByExactPath(slug, rel);
  if (!id) throw new Error(`not indexed: ${rel}`);
  return id;
}
const pageUrl = (slug: string, id: string) => `${BASE}/s/${slug}/p/${id}`;
const card = (url: string, who: User | null) => buildChatCard(url, who, BASE);
const ok = (c: unknown): ChatCard => {
  expect((c as ChatCard).status).toBe('ok');
  return c as ChatCard;
};

beforeAll(async () => {
  teardown = await setUpTestSchema();
  prevPublicUrl = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = BASE;
  const stamp = Date.now();
  const mk = (name: string, isAdmin = false) => authStore.createUser({ email: `chat-${name}-${stamp}@test.local`, name, passwordHash: 'x', isAdmin });
  owner = await mk('Owner');
  editor = await mk('Editor');
  viewer = await mk('Viewer');
  granted = await mk('Granted');
  outsider = await mk('Outsider');
  instanceAdmin = await mk('Root', true);

  const info = await storage.createSpace(`Chat Cards ${stamp}`, owner.id);
  space = info.slug;
  await authStore.setMembership(space, owner.id, 'admin');
  await authStore.setMembership(space, editor.id, 'editor');
  await authStore.setMembership(space, viewer.id, 'viewer');
  await authStore.setMembership(space, granted.id, 'viewer');

  await write(space, 'handbook/index.md', '# Handbook\n\nHow we work.\n');
  await write(
    space,
    'handbook/guide.md',
    '# Guide\n\nIntro text about **deployments**, see [[Other|the other page]].\n\n## Install\n\nSteps.\n\n## Configure\n\n### Advanced\n\nMore. #ops #deploy\n',
  );
  await write(space, 'handbook/secret.md', '# Secret plan\n\nThe launch date is March.\n\n## Budget\n');
  await write(space, 'vault/index.md', '# Vault Hidden Title\n\nPrivate.\n');
  await write(space, 'vault/note.md', '# Open note\n\nVisible to the space.\n');
  await write(space, '.agent/rules.md', '# Agent rules\n\nBe brief.\n');
  await storage.scanSpace(space);
  ids.guide = await idOf(space, 'handbook/guide.md');
  ids.secret = await idOf(space, 'handbook/secret.md');
  ids.vault = await idOf(space, 'vault/index.md');
  ids.note = await idOf(space, 'vault/note.md');
  ids.agent = await idOf(space, '.agent/rules.md');
  await pageAccess.setAccess(owner, await storage.requireEntry(ids.secret), 'restricted', [{ userId: granted.id, role: 'viewer' }]);
  await pageAccess.setAccess(owner, await storage.requireEntry(ids.vault), 'restricted', []);
  const table = await storage.createPage({
    space,
    parentPath: '',
    title: 'Roadmap',
    kind: 'table',
    columns: [
      { id: 'goal', name: 'Goal', type: 'text' },
      { id: 'owner', name: 'Owner', type: 'text' },
    ],
  });
  ids.table = table.id;

  const pub = await storage.createSpace(`Chat Public ${stamp}`, owner.id);
  pubSpace = pub.slug;
  await authStore.setMembership(pubSpace, owner.id, 'admin');
  await write(pubSpace, 'docs/intro.md', '# Public intro\n\nHello world.\n');
  await write(pubSpace, 'docs/private.md', '# Not for the public\n\nInternal.\n');
  await storage.scanSpace(pubSpace);
  ids.pubIntro = await idOf(pubSpace, 'docs/intro.md');
  ids.pubPrivate = await idOf(pubSpace, 'docs/private.md');
  await pageAccess.setAccess(owner, await storage.requireEntry(ids.pubPrivate), 'restricted', []);
  await authStore.setSpaceVisibility(pubSpace, 'public');
  await query(`UPDATE spaces SET public_domain = 'docs.example.org' WHERE slug = $1`, [pubSpace]);
  invalidatePublicSiteCache();
});

afterAll(async () => {
  await deleteTestSpace(space);
  await deleteTestSpace(pubSpace);
  if (prevPublicUrl === undefined) delete process.env.PUBLIC_URL;
  else process.env.PUBLIC_URL = prevPublicUrl;
  await teardown();
});

describe('classifyFolioUrl', () => {
  it('recognizes the instance routes and nothing else', async () => {
    expect(await classifyFolioUrl(`${BASE}/s/abc/p/123`, BASE)).toEqual({ type: 'page', space: 'abc', pageId: '123' });
    expect(await classifyFolioUrl(`${BASE}/s/abc`, BASE)).toEqual({ type: 'space', space: 'abc' });
    expect(await classifyFolioUrl(`${BASE}/s/abc/d/some/folder`, BASE)).toEqual({ type: 'space', space: 'abc' });
    expect(await classifyFolioUrl(`${BASE}/share/tok`, BASE)).toEqual({ type: 'share', token: 'tok' });
    expect(await classifyFolioUrl(`${BASE}/share/tok/p/9`, BASE)).toEqual({ type: 'share', token: 'tok', pageId: '9' });
    expect(await classifyFolioUrl(`${BASE}/share/tok.md`, BASE)).toBeUndefined();
    expect(await classifyFolioUrl(`https://elsewhere.example.net/s/abc/p/1`, BASE)).toBeUndefined();
    expect(await classifyFolioUrl(`ftp://folio.example.com/s/abc`, BASE)).toBeUndefined();
    expect(await classifyFolioUrl(`${BASE}/admin/access`, BASE)).toBeUndefined();
    expect(await classifyFolioUrl('not a url', BASE)).toBeUndefined();
    expect((await classifyFolioUrl(`${BASE}/public/${pubSpace}`, BASE))?.type).toBe('public');
    expect(await classifyFolioUrl(`${BASE}/public/no-such-site`, BASE)).toBeUndefined();
    expect((await classifyFolioUrl(`https://docs.example.org/p/${ids.pubIntro}`, BASE))?.type).toBe('public');
  });
});

describe('member cards', () => {
  it('gives editors and viewers the full card: breadcrumb, excerpt, headings, tags', async () => {
    for (const who of [owner, editor, viewer]) {
      const c = ok(await card(pageUrl(space, ids.guide), who));
      expect(c.title).toBe('Guide');
      expect(c.kind).toBe('doc');
      expect(c.access).toBe('member');
      expect(c.breadcrumb).toEqual([expect.stringContaining('Chat Cards'), 'Handbook']);
      expect(c.excerpt).toMatch(/^Intro text about deployments, see the other page\./);
      expect(c.excerpt).not.toContain('# Guide');
      expect(c.headings).toEqual(['Install', 'Configure', 'Advanced']);
      expect(c.tags).toEqual(['deploy', 'ops']); // by line, then by name
      expect(c.limited).toBeUndefined();
      expect(c.url).toBe(pageUrl(space, ids.guide));
    }
  });

  it('gives a non-member, an unknown id and an instance admin who is not a member the same title-less card', async () => {
    for (const [who, id] of [
      [outsider, ids.guide],
      [instanceAdmin, ids.guide],
      [viewer, 'does-not-exist'],
    ] as const) {
      const c = await card(pageUrl(space, id), who);
      expect(c).toEqual({ status: 'noaccess', url: pageUrl(space, id) });
    }
  });

  it('asks an unconnected chat user to sign in, without looking the page up', async () => {
    expect(await card(pageUrl(space, ids.guide), null)).toEqual({ status: 'signin', url: pageUrl(space, ids.guide) });
  });

  it('a restricted page: no access without a grant; the granted and the owner get title only', async () => {
    const denied = await card(pageUrl(space, ids.secret), viewer);
    expect(denied?.status).toBe('noaccess');
    expect(JSON.stringify(denied)).not.toContain('Secret');
    for (const who of [granted, owner]) {
      const c = ok(await card(pageUrl(space, ids.secret), who));
      expect(c.title).toBe('Secret plan');
      expect(c.limited).toBe(true);
      expect(c.excerpt).toBeUndefined();
      expect(c.headings).toBeUndefined();
      expect(c.tags).toBeUndefined();
      expect(JSON.stringify(c)).not.toContain('March');
    }
  });

  it('never names a restricted parent in the breadcrumb', async () => {
    for (const who of [viewer, owner]) {
      const c = ok(await card(pageUrl(space, ids.note), who));
      expect(c.title).toBe('Open note');
      expect(c.breadcrumb[1]).toBe('…');
      expect(JSON.stringify(c)).not.toContain('Vault Hidden Title');
    }
  });

  it('.agent pages: not for editors or viewers; a space admin gets title only', async () => {
    for (const who of [editor, viewer]) expect((await card(pageUrl(space, ids.agent), who))?.status).toBe('noaccess');
    const c = ok(await card(pageUrl(space, ids.agent), owner));
    expect(c.limited).toBe(true);
    expect(JSON.stringify(c)).not.toContain('Be brief');
  });

  it('a table shows its row count and columns', async () => {
    const c = ok(await card(pageUrl(space, ids.table), viewer));
    expect(c.kind).toBe('table');
    expect(c.table).toEqual({ rows: 0, columns: ['Goal', 'Owner'] });
  });

  it('the space home: members only', async () => {
    const c = ok(await card(`${BASE}/s/${space}`, viewer));
    expect(c.kind).toBe('space');
    expect(c.title).toContain('Chat Cards');
    expect((await card(`${BASE}/s/${space}`, outsider))?.status).toBe('noaccess');
    expect((await card(`${BASE}/s/no-such-space`, viewer))?.status).toBe('noaccess');
  });

  it('a disabled user is treated as not connected', async () => {
    expect((await card(pageUrl(space, ids.guide), { ...viewer, disabled: true }))?.status).toBe('signin');
  });
});

describe('share links and public sites (no Folio user needed)', () => {
  it('a share link gives its own page to anyone; revoked or unknown tokens give nothing', async () => {
    const link = await shares.createShareLink(ids.guide, owner.id, 'view', BASE);
    const token = link.url.split('/share/')[1];
    const c = ok(await card(`${BASE}/share/${token}`, null));
    expect(c.access).toBe('share');
    expect(c.title).toBe('Guide');
    expect(c.headings).toEqual(['Install', 'Configure', 'Advanced']);
    expect(c.updatedBy).toBeUndefined();
    // a page outside the link
    expect((await card(`${BASE}/share/${token}/p/${ids.secret}`, null))?.status).toBe('noaccess');
    await shares.revokeShare(link.id);
    expect((await card(`${BASE}/share/${token}`, null))?.status).toBe('noaccess');
    expect((await card(`${BASE}/share/0123456789abcdef`, null))?.status).toBe('noaccess');
  });

  it('a subtree link does not reach a restricted child', async () => {
    const parentId = await idOf(space, 'handbook/index.md');
    const link = await shares.createShareLink(parentId, owner.id, 'view', BASE, true);
    const token = link.url.split('/share/')[1];
    expect(ok(await card(`${BASE}/share/${token}/p/${ids.guide}`, null)).title).toBe('Guide');
    const denied = await card(`${BASE}/share/${token}/p/${ids.secret}`, null);
    expect(denied?.status).toBe('noaccess');
    expect(JSON.stringify(denied)).not.toContain('Secret');
  });

  it('a public site shows its public pages, by path and on its own domain, and nothing restricted', async () => {
    const byPath = ok(await card(`${BASE}/public/${pubSpace}/p/${ids.pubIntro}`, null));
    expect(byPath.access).toBe('public');
    expect(byPath.title).toBe('Public intro');
    expect(byPath.breadcrumb[0]).toContain('Chat Public');
    expect(ok(await card(`https://docs.example.org/p/${ids.pubIntro}`, null)).title).toBe('Public intro');
    const hidden = await card(`${BASE}/public/${pubSpace}/p/${ids.pubPrivate}`, null);
    expect(hidden?.status).toBe('noaccess');
    expect(JSON.stringify(hidden)).not.toContain('Not for the public');
    // a page of ANOTHER space through this site's address
    expect((await card(`${BASE}/public/${pubSpace}/p/${ids.guide}`, null))?.status).toBe('noaccess');
  });
});

describe('plainExcerpt', () => {
  it('drops the title H1, front matter, directives, embeds and markup, and cuts on a word', () => {
    const body = '---\nid: x\n---\n# Title\n\n::pagetree\n\n![[pic.png]]\n\nSome *text* with `code` and <b>html</b>.\n';
    expect(plainExcerpt(body, 'Title')).toBe('Some text with code and html .');
    const long = plainExcerpt(`# T\n\n${'word '.repeat(200)}`, 'T', 50);
    expect(long.length).toBeLessThanOrEqual(51);
    expect(long.endsWith('…')).toBe(true);
  });
});
