/**
 * Custom page templates: GET /api/spaces/:space/templates[/tree],
 * POST /api/pages/from-template, POST /api/pages/:id/make-template and the
 * starter templates of a new space. Real PG (isolated schema), real files,
 * the real routes through Fastify's inject — same harness as duplicatePage.test.ts.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import * as fastifyCookieModule from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authStore from './auth/store.js';
import * as session from './auth/session.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import { HttpError } from './errors.js';
import { registerRoutes } from './routes.js';
import * as storage from './storage.js';
import { starterTemplates } from './starterTemplates.js';
import { todayDateStamp } from './templateVars.js';
import { readPageProperties } from './properties.js';

async function propsOf(id: string): Promise<{ properties: Record<string, unknown> }> {
  return readPageProperties(await storage.requireEntry(id), true);
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
  await app.register(fastifyCookieModule.default);
  await app.register(async (protectedScope) => {
    protectedScope.addHook('onRequest', session.requireSession);
    registerRoutes(protectedScope);
  });
  await app.ready();
  return app;
}

describe('page templates (real PG + real files, fastify inject)', () => {
  let teardownSchema: () => Promise<void>;
  let app: FastifyInstance;
  let editorCookie: string;
  let viewerCookie: string;
  let space: string;

  const post = (url: string, payload: unknown, cookie = editorCookie) => app.inject({ method: 'POST', url, payload: payload as object, headers: { cookie } });
  const get = (url: string, cookie = editorCookie) => app.inject({ method: 'GET', url, headers: { cookie } });

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const editor = await authStore.createUser({ email: `tpl-editor-${Date.now()}@test.local`, name: 'Ann Editor', passwordHash: 'x', isAdmin: false });
    const viewer = await authStore.createUser({ email: `tpl-viewer-${Date.now()}@test.local`, name: 'Viewer', passwordHash: 'x', isAdmin: false });
    editorCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(editor.id)).token}`;
    viewerCookie = `${session.SESSION_COOKIE_NAME}=${(await authStore.createSession(viewer.id)).token}`;
    space = (await storage.createSpace(`Templates Route ${Date.now()}`, editor.id)).slug;
    await authStore.setMembership(space, editor.id, 'editor');
    await authStore.setMembership(space, viewer.id, 'viewer');
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await deleteTestSpace(space);
    await teardownSchema();
  });

  it('lists only top-level templates (children are not templates) and nests them in /templates/tree', async () => {
    const parent = await storage.createPage({ space, parentPath: '_templates', title: 'Sprint', kind: 'doc' }, { docBody: '# Sprint\n\nGoal\n' });
    await storage.createPage({ space, parentPath: '_templates/sprint', title: 'Retro', kind: 'doc' });
    await storage.createPage({ space, parentPath: '_templates', title: 'Tracker', kind: 'table' });

    const list = (await get(`/api/spaces/${space}/templates`)).json() as { templates: Array<{ id: string; title: string; kind: string }> };
    expect(list.templates.map((t) => t.title).sort()).toEqual(['Sprint', 'Tracker']);
    expect(list.templates.find((t) => t.title === 'Tracker')!.kind).toBe('table');

    const tree = (await get(`/api/spaces/${space}/templates/tree`)).json() as { tree: Array<{ id: string; title: string; children: Array<{ title: string }> }> };
    expect(tree.tree.find((n) => n.id === parent.id)!.children.map((c) => c.title)).toEqual(['Retro']);

    // Not in the normal tree.
    const main = (await get(`/api/spaces/${space}/tree`)).json() as { tree: Array<{ children: Array<{ path: string }> }> };
    expect(main.tree[0].children.some((c) => c.path.startsWith('_templates'))).toBe(false);
  });

  it('from-template: copies a doc with children and a table, fills placeholders, renames the root', async () => {
    const templates = (await storage.listTemplates(space)).filter((t) => t.title === 'Sprint' || t.title === 'Tracker');
    const doc = templates.find((t) => t.title === 'Sprint')!;
    const table = templates.find((t) => t.title === 'Tracker')!;
    await storage.writeDocBody(doc.id, '# Sprint\n\n{{date}} by {{author}}: {{ title }} {{unknown}}\n');
    const child = (await storage.getTemplatesTree(space)).find((n) => n.id === doc.id)!.children[0];
    await storage.writeDocBody(child.id, '# Retro\n\nfor {{title}}\n');

    const res = await post('/api/pages/from-template', { templateId: doc.id, space, parentPath: 'work', title: 'Sprint 42' });
    expect(res.statusCode).toBe(201);
    const meta = res.json() as { id: string; title: string; path: string };
    expect(meta.title).toBe('Sprint 42');
    expect(meta.path.startsWith('work/sprint-42')).toBe(true);

    const body = await storage.readFreshDocBody(meta.id);
    expect(body).toContain(`${todayDateStamp()} by Ann Editor: Sprint 42 {{unknown}}`);
    const kids = await storage.getSubtree(await storage.requireEntry(meta.id), 2);
    expect(kids.map((k) => k.title)).toEqual(['Retro']);
    expect(kids[0].id).not.toBe(child.id);
    expect(await storage.readFreshDocBody(kids[0].id)).toContain('for Sprint 42');
    // Template untouched.
    expect(await storage.readFreshDocBody(doc.id)).toContain('{{date}}');

    const t = await post('/api/pages/from-template', { templateId: table.id, space, parentPath: 'work' });
    expect(t.statusCode).toBe(201);
    expect(t.json()).toMatchObject({ kind: 'table', title: 'Tracker' });
  });

  it('from-template: refuses a non-template, a destination inside _templates, a viewer, a foreign space', async () => {
    const plain = await storage.createPage({ space, parentPath: '', title: 'Plain', kind: 'doc' });
    const tpl = (await storage.listTemplates(space))[0];
    expect((await post('/api/pages/from-template', { templateId: plain.id, space, parentPath: '' })).statusCode).toBe(400);
    expect((await post('/api/pages/from-template', { templateId: tpl.id, space, parentPath: '_templates' })).statusCode).toBe(400);
    expect((await post('/api/pages/from-template', { templateId: tpl.id, space, parentPath: '' }, viewerCookie)).statusCode).toBe(403);
    expect((await post('/api/pages/from-template', { templateId: tpl.id, space: 'nope', parentPath: '' })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await post('/api/pages/from-template', { templateId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', space, parentPath: '' })).statusCode).toBe(404);
  });

  it('make-template: copies the page (with or without children) into _templates, title kept', async () => {
    const parent = await storage.createPage({ space, parentPath: 'docs', title: 'Runbook', kind: 'doc' });
    await storage.createPage({ space, parentPath: 'docs/runbook', title: 'Step', kind: 'doc' });

    const withKids = await post(`/api/pages/${parent.id}/make-template`, {});
    expect(withKids.statusCode).toBe(201);
    const meta = withKids.json() as { id: string; title: string; path: string };
    expect(meta.title).toBe('Runbook');
    expect(meta.path.startsWith('_templates/')).toBe(true);
    expect((await storage.getTemplatesTree(space)).find((n) => n.id === meta.id)!.children.map((n) => n.title)).toEqual(['Step']);
    expect((await storage.listTemplates(space)).some((t) => t.id === meta.id)).toBe(true);

    const bare = await post(`/api/pages/${parent.id}/make-template`, { includeChildren: false });
    expect(bare.statusCode).toBe(201);
    const bareId = (bare.json() as { id: string }).id;
    expect((await storage.getTemplatesTree(space)).find((n) => n.id === bareId)!.children).toEqual([]);

    // The source stays where it was.
    expect((await storage.requireEntry(parent.id)).relPath.startsWith('docs/')).toBe(true);
  });

  it('make-template with a title and a description: retitled, property set, listed; from-template strips the property', async () => {
    const source = await storage.createPage({ space, parentPath: 'docs', title: 'Checklist', kind: 'doc' });
    await storage.createPage({ space, parentPath: 'docs/checklist', title: 'Item', kind: 'doc' });

    const res = await post(`/api/pages/${source.id}/make-template`, { title: '  Release checklist ', description: ' Steps before a release.\nSecond line. ' });
    expect(res.statusCode).toBe(201);
    const meta = res.json() as { id: string; title: string; path: string };
    expect(meta.title).toBe('Release checklist');
    expect(meta.path.startsWith('_templates/release-checklist')).toBe(true);
    expect((await storage.requireEntry(source.id)).title).toBe('Checklist');

    const props = await propsOf(meta.id);
    expect(props.properties['template-description']).toBe('Steps before a release.\nSecond line.');
    const listed = (await storage.listTemplates(space)).find((t) => t.id === meta.id)!;
    expect(listed.description).toBe('Steps before a release.\nSecond line.');
    const viaRoute = (await get(`/api/spaces/${space}/templates`)).json() as { templates: Array<{ id: string; description?: string }> };
    expect(viaRoute.templates.find((t) => t.id === meta.id)!.description).toBe('Steps before a release.\nSecond line.');
    // A template without a description carries none.
    expect((await storage.listTemplates(space)).find((t) => t.title === 'Sprint')!.description).toBeUndefined();

    // The page made from it has no `template-description`; the template keeps it.
    const created = await post('/api/pages/from-template', { templateId: meta.id, space, parentPath: 'work' });
    expect(created.statusCode).toBe(201);
    const copyId = (created.json() as { id: string }).id;
    const copyProps = await propsOf(copyId);
    expect(copyProps.properties).not.toHaveProperty('template-description');
    const again = await propsOf(meta.id);
    expect(again.properties['template-description']).toBe('Steps before a release.\nSecond line.');

    // Validation: an empty title and an over-long description are refused.
    expect((await post(`/api/pages/${source.id}/make-template`, { title: '   ' })).statusCode).toBe(400);
    expect((await post(`/api/pages/${source.id}/make-template`, { description: 'x'.repeat(1001) })).statusCode).toBe(400);
  });

  it('POST /templates: a blank document template with a name and a description, one call', async () => {
    const res = await post(`/api/spaces/${space}/templates`, { title: 'Weekly review', description: 'Look back at the week' });
    expect(res.statusCode).toBe(201);
    const meta = res.json() as { id: string; title: string; kind: string; path: string };
    expect(meta).toMatchObject({ title: 'Weekly review', kind: 'doc' });
    expect(meta.path.startsWith('_templates/')).toBe(true);
    expect((await storage.listTemplates(space)).find((t) => t.id === meta.id)!.description).toBe('Look back at the week');

    const bare = await post(`/api/spaces/${space}/templates`, { title: 'Bare one' });
    expect(bare.statusCode).toBe(201);
    expect((await storage.listTemplates(space)).find((t) => t.id === (bare.json() as { id: string }).id)!.description).toBeUndefined();
    expect((await post(`/api/spaces/${space}/templates`, { title: '' })).statusCode).toBe(400);
    expect((await post(`/api/spaces/${space}/templates`, { title: 'Nope' }, viewerCookie)).statusCode).toBe(403);
  });

  it('make-template: refuses the space root, a page already in _templates, a viewer, a missing page', async () => {
    const root = (await storage.listEntries(space)).find((e) => e.isIndex && e.dirPath === '')!;
    expect((await post(`/api/pages/${root.id}/make-template`, {})).statusCode).toBe(400);
    const tpl = (await storage.listTemplates(space))[0];
    expect((await post(`/api/pages/${tpl.id}/make-template`, {})).statusCode).toBe(400);
    const page = await storage.createPage({ space, parentPath: '', title: 'Mine', kind: 'doc' });
    expect((await post(`/api/pages/${page.id}/make-template`, {}, viewerCookie)).statusCode).toBe(403);
    expect((await post('/api/pages/01ARZ3NDEKTSV4RRFFQ69G5FAV/make-template', {})).statusCode).toBe(404);
  });
});

describe('starter templates (real PG + real files)', () => {
  let teardownSchema: () => Promise<void>;
  const slugs: string[] = [];

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
  });
  afterAll(async () => {
    for (const s of slugs) await deleteTestSpace(s);
    await teardownSchema();
  });

  it('a space created with starterTemplates has three templates; one without has none', async () => {
    const withStarters = await storage.createSpace(`Starters ${Date.now()}`, null, { starterTemplates: true, language: 'uk' });
    slugs.push(withStarters.slug);
    const templates = await storage.listTemplates(withStarters.slug);
    // Titles come from the Ukrainian bundle: the H1 of each starter text there.
    const expected = starterTemplates('uk').map((t) => /^# (.+)$/m.exec(t.markdown)![1]);
    expect(templates.map((t) => t.title).sort()).toEqual(expected.sort());
    expect(expected).not.toContain('Meeting notes');
    expect(templates.every((t) => t.icon)).toBe(true);

    const bare = await storage.createSpace(`Bare ${Date.now()}`, null);
    slugs.push(bare.slug);
    expect(await storage.listTemplates(bare.slug)).toEqual([]);
    const en = await storage.createSpace(`Starters En ${Date.now()}`, null, { starterTemplates: true });
    slugs.push(en.slug);
    expect((await storage.listTemplates(en.slug)).map((t) => t.title).sort()).toEqual(['Decision record', 'How-to', 'Meeting notes']);
  });
});
