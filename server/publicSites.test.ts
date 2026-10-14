/**
 * Public sites (13.10.2026): a space whose visibility is 'public' is readable
 * by anonymous visitors. Driven through app.inject against the real route
 * registrations (registerPublicSiteRoutes + registerFileRoutes), a real PG
 * schema, real files, and — for the collab door — a real http server with
 * real WS clients (same pattern as export/shareScopeAcl.test.ts).
 *
 * Fixture, in the public space (`pub`):
 *   index.md                  the space root (the site's home page)
 *   guide.md                  open; embeds img/shot.png; says "zebrafish"
 *   guide/part.md             open child of guide
 *   guide/hidden.md           RESTRICTED child of guide (page_access row)
 *   secret.md                 RESTRICTED; says "zebrafish"
 *   .agent/rules.md           admin-only assistant rules; says "zebrafish"
 *   _templates/weekly.md      a template; says "zebrafish"
 * and a private space and an instance-visible space with a page each.
 */
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WS from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { PublicPagePayload, PublicSiteInfo, SearchHit, TreeNode, User } from '../shared/contracts.js';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import * as collab from './collab.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { queryOne } from './db/pool.js';
import { HttpError } from './errors.js';
import { registerFileRoutes } from './fileAccess.js';
import * as pageAccess from './pageAccess.js';
import { __resetRateLimitsForTests } from './rateLimit.js';
import { renderIndexHtml } from './pageMeta.js';
import { getPublicSettings, registerPublicSiteRoutes, updatePublicSettings } from './publicSiteRoutes.js';
import { getSpacePublicSettings, invalidatePublicSiteCache, publicSiteUrls, publicSiteForShell, resolvePublicSiteByHost } from './publicSites.js';
import * as storage from './storage.js';
import { restoreTrashItem } from './trash/service.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  registerPublicSiteRoutes(app);
  await app.register(registerFileRoutes); // exactly as server/index.ts registers it
  await app.ready();
  return app;
}

/** Opens an anonymous WS to `pageId`'s room and reports whether the server let it in. */
async function wsAdmits(port: number, pageId: string): Promise<boolean> {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, pageId, doc, {
    WebSocketPolyfill: WS as unknown as typeof globalThis.WebSocket,
    connect: true,
    disableBc: true,
  });
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('neither synced nor closed in time')), 8000);
      provider.on('sync', (synced: boolean) => {
        if (!synced) return;
        clearTimeout(timer);
        resolve(true);
      });
      provider.on('connection-close', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  } finally {
    provider.destroy();
  }
}

/** y-websocket creates its socket as `new WebSocketPolyfill(url)`; this subclass attaches a session cookie to the upgrade request. */
function cookieWs(token: string): typeof globalThis.WebSocket {
  return class extends WS {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers: { Cookie: `folio_session=${token}` } });
    }
  } as unknown as typeof globalThis.WebSocket;
}

// y-protocol top-level message types (server/collab.ts: MESSAGE_SYNC / MESSAGE_AWARENESS).
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
// y-protocol sync sub-types.
const SYNC_STEP_1 = 0;
const SYNC_STEP_2 = 1;

interface SeenFrame {
  /** Top-level varuint type (0 = sync, 1 = awareness). */
  type: number;
  /** Sync sub-type for a sync frame, -1 otherwise. */
  sub: number;
}

/** A raw anonymous collab socket on `pageId`'s room that records every frame it receives. */
interface RawVisitor {
  frames: SeenFrame[];
  send(frame: Uint8Array): void;
  close(): void;
}

function syncStep1Frame(): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, new Y.Doc());
  return encoding.toUint8Array(enc);
}

function awarenessFrame(awareness: awarenessProtocol.Awareness): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_AWARENESS);
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]));
  return encoding.toUint8Array(enc);
}

async function openRawVisitor(port: number, pageId: string): Promise<RawVisitor> {
  const ws = new WS(`ws://127.0.0.1:${port}/collab/${pageId}`);
  ws.binaryType = 'nodebuffer';
  const frames: SeenFrame[] = [];
  ws.on('message', (data: Buffer) => {
    const dec = decoding.createDecoder(new Uint8Array(data));
    const type = decoding.readVarUint(dec);
    frames.push({ type, sub: type === MSG_SYNC ? decoding.readVarUint(dec) : -1 });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('visitor socket did not open in time')), 8000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  ws.send(syncStep1Frame()); // what a real client announces first (a read-only viewer may send this)
  return { frames, send: (frame) => ws.send(frame), close: () => ws.close() };
}

async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function flatten(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

describe('public sites (real PG)', () => {
  const savedEnv = { url: process.env.PUBLIC_URL, sites: process.env.PUBLIC_SITES_DOMAIN };
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let server: http.Server;
  let port: number;

  let spaceAdmin: User;
  let editor: User;
  let instanceAdmin: User;
  let pub: string;
  let other: string; // a second public space
  let priv: string;
  let inst: string;
  let pubDir: string;

  let guide: storage.PageIndexEntry;
  let part: storage.PageIndexEntry;
  let hidden: storage.PageIndexEntry;
  let secret: storage.PageIndexEntry;
  let agentRules: storage.PageIndexEntry;
  let template: storage.PageIndexEntry;
  let privPage: storage.PageIndexEntry;
  let instPage: storage.PageIndexEntry;

  async function doc(space: string, parentPath: string, title: string, body: string): Promise<storage.PageIndexEntry> {
    const meta = await storage.createPage({ space, parentPath, title, kind: 'doc' });
    await storage.writeDocBody(meta.id, `# ${title}\n\n${body}\n`);
    return storage.requireEntry(meta.id);
  }

  function get(url: string, headers: Record<string, string> = {}) {
    return app.inject({ method: 'GET', url, headers });
  }

  beforeAll(async () => {
    process.env.PUBLIC_URL = 'https://folio.example.com';
    process.env.PUBLIC_SITES_DOMAIN = 'sites.example.com';
    teardownSchema = await setUpTestSchema();
    collab.initCollab();
    server = http.createServer();
    collab.attachToServer(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;

    const stamp = Date.now();
    spaceAdmin = await authStore.createUser({ email: `pub-admin-${stamp}@example.com`, name: 'Space Admin', passwordHash: 'x', isAdmin: false });
    editor = await authStore.createUser({ email: `pub-editor-${stamp}@example.com`, name: 'Editor', passwordHash: 'x', isAdmin: false });
    instanceAdmin = await authStore.createUser({ email: `pub-root-${stamp}@example.com`, name: 'Root', passwordHash: 'x', isAdmin: true });

    pub = (await storage.createSpace(`Pub Docs ${stamp}`, spaceAdmin.id)).slug;
    other = (await storage.createSpace(`Pub Other ${stamp}`, spaceAdmin.id)).slug;
    priv = (await storage.createSpace(`Priv Docs ${stamp}`, spaceAdmin.id)).slug;
    inst = (await storage.createSpace(`Inst Docs ${stamp}`, spaceAdmin.id)).slug;
    for (const space of [pub, other, priv, inst]) {
      await authStore.setMembership(space, spaceAdmin.id, 'admin');
      await authStore.setMembership(space, editor.id, 'editor');
    }
    pubDir = storage.getSpaceDir(pub);

    guide = await doc(pub, '', 'Guide', 'The zebrafish guide.\n\n![shot](img/shot.png)');
    part = await doc(pub, 'guide', 'Part', 'Part text.');
    hidden = await doc(pub, 'guide', 'Hidden', 'Hidden child text.');
    secret = await doc(pub, '', 'Secret', 'Secret zebrafish text.');
    agentRules = await doc(pub, '.agent', 'Rules', 'Agent zebrafish rules.');
    template = await doc(pub, '_templates', 'Weekly', 'Template zebrafish.');
    privPage = await doc(priv, '', 'Private Page', '![shot](img/shot.png)');
    instPage = await doc(inst, '', 'Instance Page', 'Instance text.');

    await fs.mkdir(path.join(pubDir, 'img'), { recursive: true });
    await fs.writeFile(path.join(pubDir, 'img/shot.png'), 'SHOT');
    await fs.mkdir(path.join(pubDir, 'misc'), { recursive: true });
    await fs.writeFile(path.join(pubDir, 'misc/unreferenced.txt'), 'NOBODY-LINKS-HERE');
    await fs.mkdir(path.join(storage.getSpaceDir(priv), 'img'), { recursive: true });
    await fs.writeFile(path.join(storage.getSpaceDir(priv), 'img/shot.png'), 'PRIVATE-SHOT');

    await pageAccess.setAccess(spaceAdmin, secret, 'restricted', []);
    await pageAccess.setAccess(spaceAdmin, hidden, 'restricted', []);

    await authStore.setSpaceVisibility(pub, 'public');
    await authStore.setSpaceVisibility(other, 'public');
    await authStore.setSpaceVisibility(inst, 'instance');

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    for (const space of [pub, other, priv, inst]) await deleteTestSpace(space).catch(() => {});
    await teardownSchema();
    if (savedEnv.url === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = savedEnv.url;
    if (savedEnv.sites === undefined) delete process.env.PUBLIC_SITES_DOMAIN;
    else process.env.PUBLIC_SITES_DOMAIN = savedEnv.sites;
  });

  it('only a public space answers anonymously; a public space is also an implicit viewer space for signed-in users', async () => {
    expect((await get(`/api/public/spaces/${priv}`)).statusCode).toBe(404);
    expect((await get(`/api/public/spaces/${inst}`)).statusCode).toBe(404);
    expect((await get('/api/public/spaces/no-such-space')).statusCode).toBe(404);
    for (const tail of ['/tree', `/pages/${privPage.id}`, `/pages/${instPage.id}`, '/search?q=text', '/resolve?path=index.md']) {
      expect((await get(`/api/public/spaces/${priv}${tail}`)).statusCode, `private ${tail}`).toBe(404);
      expect((await get(`/api/public/spaces/${inst}${tail}`)).statusCode, `instance ${tail}`).toBe(404);
    }

    const res = await get(`/api/public/spaces/${pub}`);
    expect(res.statusCode).toBe(200);
    const info = res.json<PublicSiteInfo>();
    expect(info).toMatchObject({ space: pub, mode: 'path', allowDownload: false, allowAssistant: false, instanceUrl: 'https://folio.example.com' });
    expect(info.homePageId).toBe((await storage.resolve(pub, '')).id);
    expect(res.headers['x-robots-tag']).toBeUndefined(); // a public site is meant to be indexed

    // public ⊇ instance: a user with no membership reads it as a viewer
    const stranger = await authStore.createUser({ email: `pub-stranger-${Date.now()}@example.com`, name: 'Stranger', passwordHash: 'x', isAdmin: false });
    expect(await session.effectiveRole(stranger, pub)).toBe('viewer');
    expect(await session.effectiveRole(stranger, priv)).toBeUndefined();
  });

  it('tree, page, resolve and search leave out restricted pages, .agent/** and _templates/', async () => {
    const tree = (await get(`/api/public/spaces/${pub}/tree`)).json<{ tree: TreeNode[] }>().tree;
    const ids = new Set(flatten(tree).map((n) => n.id));
    const paths = flatten(tree).map((n) => n.path);
    for (const open of [guide.id, part.id]) expect(ids.has(open), open).toBe(true);
    for (const closed of [secret.id, hidden.id, agentRules.id, template.id]) expect(ids.has(closed), closed).toBe(false);
    expect(paths.some((p) => p.startsWith('.agent') || p.startsWith('_templates'))).toBe(false);

    const ok = await get(`/api/public/spaces/${pub}/pages/${guide.id}`);
    expect(ok.statusCode).toBe(200);
    const payload = ok.json<PublicPagePayload>();
    expect(payload.page.markdown).toContain('zebrafish guide');
    expect(payload.spaceName).toContain('Pub Docs');
    for (const closed of [secret, hidden, agentRules, template, privPage, instPage]) {
      expect((await get(`/api/public/spaces/${pub}/pages/${closed.id}`)).statusCode, closed.relPath).toBe(404);
    }
    expect((await get(`/api/public/spaces/${pub}/pages/dir:guide`)).statusCode).toBe(404);

    expect((await get(`/api/public/spaces/${pub}/resolve?path=guide.md`)).json<{ id: string }>().id).toBe(guide.id);
    for (const closed of ['secret.md', '.agent/rules.md', '_templates/weekly.md']) {
      expect((await get(`/api/public/spaces/${pub}/resolve?path=${encodeURIComponent(closed)}`)).statusCode, closed).toBe(404);
    }

    const hits = (await get(`/api/public/spaces/${pub}/search?q=zebrafish`)).json<{ hits: SearchHit[] }>().hits;
    expect(hits.map((h) => h.id)).toEqual([guide.id]);
    expect((await get(`/api/public/spaces/${pub}/search?q=%20%20`)).json<{ hits: SearchHit[] }>().hits).toEqual([]);
    expect((await get(`/api/public/spaces/${pub}/search?q=${'x'.repeat(500)}`)).statusCode).toBe(200);
    expect((await get(`/api/public/spaces/${other}/search?q=zebrafish`)).json<{ hits: SearchHit[] }>().hits).toEqual([]); // this space only
  });

  it('GET /files/<space>/... without a session: a public space\'s public pages and what they reference; 401 for a private space', async () => {
    const shot = await get(`/files/${pub}/img/shot.png`);
    expect(shot.statusCode).toBe(200);
    expect(shot.body).toBe('SHOT');
    expect((await get(`/files/${pub}/${guide.relPath}`)).statusCode).toBe(200); // a public page's own file
    for (const closed of ['misc/unreferenced.txt', secret.relPath, hidden.relPath, template.relPath]) {
      expect((await get(`/files/${pub}/${closed}`)).statusCode, closed).toBe(403);
    }
    expect((await get(`/files/${pub}/.agent/rules.md`)).statusCode).toBe(404); // dot segments are never served
    expect((await get(`/files/${priv}/img/shot.png`)).statusCode).toBe(401);
    expect((await get(`/files/${inst}/${instPage.relPath}`)).statusCode).toBe(401);
  });

  it('export is 404 until the space allows downloads; then a public page exports and a restricted child never does', async () => {
    const url = `/api/public/spaces/${pub}/pages/${guide.id}/export.md`;
    expect((await get(url)).statusCode).toBe(404);

    await updatePublicSettings(spaceAdmin, pub, { subdomain: null, domain: null, allowDownload: true, allowAssistant: false }, 'https://folio.example.com');
    const single = await get(url);
    expect(single.statusCode).toBe(200);
    expect(single.headers['content-type']).toContain('text/markdown');
    expect(single.body).toContain('zebrafish guide');

    const withChildren = await get(`${url}?children=1`);
    expect(withChildren.body).toContain('Part text.');
    expect(withChildren.body).not.toContain('Hidden child text.');

    // docx costs CPU: limited per IP (PUBLIC_EXPORT_PER_MINUTE), 429 with Retry-After when over
    const savedLimit = process.env.PUBLIC_EXPORT_PER_MINUTE;
    process.env.PUBLIC_EXPORT_PER_MINUTE = '2';
    __resetRateLimitsForTests();
    try {
      const docx = `/api/public/spaces/${pub}/pages/${guide.id}/export.docx`;
      expect((await get(docx)).statusCode).toBe(200);
      expect((await get(docx)).statusCode).toBe(200);
      const limited = await get(docx);
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      if (savedLimit === undefined) delete process.env.PUBLIC_EXPORT_PER_MINUTE;
      else process.env.PUBLIC_EXPORT_PER_MINUTE = savedLimit;
      __resetRateLimitsForTests();
    }

    expect((await get(`/api/public/spaces/${pub}/pages/${secret.id}/export.md`)).statusCode).toBe(404);
    expect((await get(`/api/public/spaces/${pub}/pages/${agentRules.id}/export.md`)).statusCode).toBe(404);
    expect((await get(`/api/public/spaces/${priv}/pages/${privPage.id}/export.md`)).statusCode).toBe(404);
    expect((await get(`/api/public/spaces/${other}/pages/${guide.id}/export.md`)).statusCode).toBe(404); // other space's slug, this page
  });

  it('the collab socket admits an anonymous visitor to a public page and refuses restricted pages and private spaces', async () => {
    expect(await wsAdmits(port, guide.id)).toBe(true);
    for (const closed of [secret.id, hidden.id, agentRules.id, template.id, privPage.id, instPage.id]) {
      expect(await wsAdmits(port, closed), closed).toBe(false);
    }
  });

  it('a public visitor is silent inbound: its awareness update never reaches a signed-in editor in the same room', async () => {
    const token = (await authStore.createSession(editor.id)).token;
    const connect = () =>
      new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, guide.id, new Y.Doc(), {
        WebSocketPolyfill: cookieWs(token),
        connect: true,
        disableBc: true,
      });
    const editorA = connect();
    const editorB = connect(); // positive control: awareness between signed-in peers does flow
    const visitorAwareness = new awarenessProtocol.Awareness(new Y.Doc());
    let visitor: RawVisitor | undefined;
    try {
      await until(() => editorA.synced && editorB.synced, 'both editors synced');
      visitor = await openRawVisitor(port, guide.id);
      await until(() => visitor!.frames.some((f) => f.type === MSG_SYNC && f.sub === SYNC_STEP_2), 'visitor got sync step 2');

      editorA.awareness.setLocalState({ user: { name: 'Editor A' } });
      await until(
        () => (editorB.awareness.getStates().get(editorA.awareness.clientID) as { user?: { name?: string } } | undefined)?.user?.name === 'Editor A',
        'editor B sees editor A (control)',
      );

      // The visitor announces itself the way a full client would...
      visitorAwareness.setLocalState({ user: { name: 'Visitor' } });
      visitor.send(awarenessFrame(visitorAwareness));
      // ...then asks for sync again: the step-2 reply proves the server has already consumed (and dropped) the awareness frame ahead of it.
      const step2Before = visitor.frames.filter((f) => f.type === MSG_SYNC && f.sub === SYNC_STEP_2).length;
      visitor.send(syncStep1Frame());
      await until(() => visitor!.frames.filter((f) => f.type === MSG_SYNC && f.sub === SYNC_STEP_2).length > step2Before, 'server answered the visitor after the awareness frame');
      await sleep(300); // time for a (wrongly) forwarded awareness update to reach the editors

      expect(editorA.awareness.getStates().has(visitorAwareness.clientID)).toBe(false);
      expect(editorB.awareness.getStates().has(visitorAwareness.clientID)).toBe(false);
    } finally {
      visitor?.close();
      visitorAwareness.destroy();
      editorA.destroy();
      editorB.destroy();
    }
  });

  it('a public visitor is silent outbound: editors\' awareness is never sent to it, while sync frames still are', async () => {
    const token = (await authStore.createSession(editor.id)).token;
    const connect = () =>
      new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, guide.id, new Y.Doc(), {
        WebSocketPolyfill: cookieWs(token),
        connect: true,
        disableBc: true,
      });
    const editorA = connect();
    const editorB = connect(); // positive control: the room really does broadcast awareness
    let visitor: RawVisitor | undefined;
    try {
      // Editor A is already present, with a state, BEFORE the visitor joins: the server's
      // on-connect awareness snapshot is the first thing a visitor would otherwise get.
      editorA.awareness.setLocalState({ user: { name: 'Editor A', color: '#ff0000' } });
      await until(
        () => (editorB.awareness.getStates().get(editorA.awareness.clientID) as { user?: { name?: string } } | undefined)?.user?.name === 'Editor A',
        'editor B sees editor A (control)',
      );
      visitor = await openRawVisitor(port, guide.id);
      await until(() => visitor!.frames.some((f) => f.type === MSG_SYNC && f.sub === SYNC_STEP_2), 'visitor got sync step 2');

      // A live update after the visitor is in the room.
      editorA.awareness.setLocalState({ user: { name: 'Editor A (moved)', color: '#00ff00' } });
      await until(
        () => (editorB.awareness.getStates().get(editorA.awareness.clientID) as { user?: { name?: string } } | undefined)?.user?.name === 'Editor A (moved)',
        'editor B sees the live awareness update (control)',
      );
      await sleep(300); // time for a (wrongly) forwarded awareness frame to reach the visitor

      expect(visitor.frames.filter((f) => f.type === MSG_AWARENESS)).toEqual([]);
      // The document itself is public and still flows: the server's own step 1 and its step 2 answer to the visitor's.
      expect(visitor.frames.some((f) => f.type === MSG_SYNC && f.sub === SYNC_STEP_1)).toBe(true);
      expect(visitor.frames.some((f) => f.type === MSG_SYNC && f.sub === SYNC_STEP_2)).toBe(true);
    } finally {
      visitor?.close();
      editorA.destroy();
      editorB.destroy();
    }
  });

  it('resolvePublicSiteByHost: subdomain, custom domain, main host, unknown and unpublished hosts', async () => {
    await updatePublicSettings(spaceAdmin, pub, { subdomain: 'docs', domain: 'wiki.customer.org', allowDownload: true, allowAssistant: false }, 'https://folio.example.com');
    expect((await resolvePublicSiteByHost('docs.sites.example.com'))?.slug).toBe(pub);
    expect((await resolvePublicSiteByHost('Docs.Sites.Example.com:443'))?.slug).toBe(pub); // case and port are ignored
    expect((await resolvePublicSiteByHost('wiki.customer.org'))?.slug).toBe(pub);
    expect(await resolvePublicSiteByHost('folio.example.com')).toBeUndefined(); // the main host is never a site
    expect(await resolvePublicSiteByHost('nope.sites.example.com')).toBeUndefined();
    expect(await resolvePublicSiteByHost('a.docs.sites.example.com')).toBeUndefined(); // exactly one label
    expect(await resolvePublicSiteByHost('other.customer.org')).toBeUndefined();
    expect(await resolvePublicSiteByHost(undefined)).toBeUndefined();

    // the GET /api/public/site route resolves by Host and serves the site at '/'
    const byHost = await get('/api/public/site', { host: 'docs.sites.example.com' });
    expect(byHost.statusCode).toBe(200);
    expect(byHost.json<PublicSiteInfo>()).toMatchObject({ space: pub, mode: 'host' });
    expect((await get('/api/public/site', { host: 'folio.example.com' })).statusCode).toBe(404);

    // the HTML shell names the site and marks it for the SPA
    const shell = await publicSiteForShell('wiki.customer.org', '/');
    const html = renderIndexHtml('<html><head><title>Folio</title></head><body></body></html>', 'https://wiki.customer.org', '/', shell);
    expect(html).toContain('<meta name="folio-public-site" content="' + pub + '" />');
    expect(html).toMatch(/<title>Pub Docs \d+<\/title>/);
    expect(renderIndexHtml('<html><head><title>Folio</title></head></html>', 'https://folio.example.com', '/')).not.toContain('folio-public-site');

    expect(publicSiteUrls(pub, { subdomain: 'docs', domain: 'wiki.customer.org' }, '')).toEqual({
      path: `https://folio.example.com/public/${pub}`,
      subdomain: 'https://docs.sites.example.com',
      domain: 'https://wiki.customer.org',
    });

    // un-publishing stops the host from resolving (settings are kept)
    await authStore.setSpaceVisibility(pub, 'instance');
    invalidatePublicSiteCache();
    expect(await resolvePublicSiteByHost('docs.sites.example.com')).toBeUndefined();
    expect((await get(`/api/public/spaces/${pub}`)).statusCode).toBe(404);
    await authStore.setSpaceVisibility(pub, 'public');
    invalidatePublicSiteCache();
    expect((await resolvePublicSiteByHost('docs.sites.example.com'))?.slug).toBe(pub);
  });

  it('PUT public-settings: an editor is refused, a space admin and an instance admin are not; duplicates and reserved hosts are rejected', async () => {
    const origin = 'https://folio.example.com';
    const body = { subdomain: 'other-docs', domain: 'docs.other.org', allowDownload: false, allowAssistant: true };

    await expect(updatePublicSettings(editor, other, body, origin)).rejects.toMatchObject({ status: 403 });
    await expect(getPublicSettings(editor, other, origin)).rejects.toMatchObject({ status: 403 });
    await expect(updatePublicSettings(spaceAdmin, 'no-such-space', body, origin)).rejects.toMatchObject({ status: 404 });

    const saved = await updatePublicSettings(spaceAdmin, other, body, origin);
    expect(saved).toMatchObject({
      visibility: 'public',
      settings: body,
      urls: { path: `https://folio.example.com/public/${other}`, subdomain: 'https://other-docs.sites.example.com', domain: 'https://docs.other.org' },
      sitesDomain: 'sites.example.com',
      mainHost: 'folio.example.com',
    });
    expect((await getPublicSettings(instanceAdmin, other, origin)).settings).toEqual(body);

    // `pub` already holds subdomain "docs" and domain "wiki.customer.org" (previous test)
    await expect(updatePublicSettings(instanceAdmin, other, { ...body, subdomain: 'docs' }, origin)).rejects.toMatchObject({ status: 409, message: 'subdomain is already taken' });
    await expect(updatePublicSettings(instanceAdmin, other, { ...body, domain: 'wiki.customer.org' }, origin)).rejects.toMatchObject({ status: 409, message: 'domain is already in use' });
    await expect(updatePublicSettings(spaceAdmin, other, { ...body, domain: 'folio.example.com' }, origin)).rejects.toMatchObject({ status: 400 });
    await expect(updatePublicSettings(spaceAdmin, other, { ...body, domain: 'sites.example.com' }, origin)).rejects.toMatchObject({ status: 400 });
    await expect(updatePublicSettings(spaceAdmin, other, { ...body, domain: 'x.sites.example.com' }, origin)).rejects.toMatchObject({ status: 400 });
    expect((await getPublicSettings(spaceAdmin, other, origin)).settings).toEqual(body); // failed saves changed nothing
  });

  it('delete -> restore of a published space keeps its visibility and publish settings; a domain taken meanwhile is left empty', async () => {
    const origin = 'https://folio.example.com';
    const slug = (await storage.createSpace(`Pub Trash ${Date.now()}`, spaceAdmin.id)).slug;
    await authStore.setMembership(slug, instanceAdmin.id, 'admin');
    await authStore.setSpaceVisibility(slug, 'public');
    const settings = { subdomain: 'trashed', domain: 'trashed.customer.org', allowDownload: true, allowAssistant: true };
    await updatePublicSettings(instanceAdmin, slug, settings, origin);

    await storage.deleteSpace(slug, instanceAdmin.id);
    const row = await queryOne<{ id: string }>("SELECT id FROM trash_items WHERE kind = 'space' AND space_slug = $1", [slug]);
    // another space claims the custom domain while this one sits in the trash
    await updatePublicSettings(spaceAdmin, other, { subdomain: null, domain: 'trashed.customer.org', allowDownload: false, allowAssistant: false }, origin);

    await restoreTrashItem(instanceAdmin, row!.id);
    const restored = await getSpacePublicSettings(slug);
    expect(restored?.visibility).toBe('public');
    expect(restored?.settings).toEqual({ ...settings, domain: null });
    await deleteTestSpace(slug);
  });
});
