/**
 * list_templates / create_page_from_template / save_page_as_template / create_template (real fs + real PG,
 * in-memory MCP transport): the same gates as the web routes — space role, write scope, `_templates/` is
 * never a destination of create_page — and the copies (subpages, placeholders, no template description).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setUpTestSchema, deleteTestSpace } from './db/testSchema.js';
import * as storage from './storage.js';
import * as authStore from './auth/store.js';
import { buildFolioMcpServer, type McpActor } from './mcp.js';
import type { User } from '../shared/contracts.js';

async function call(actor: McpActor, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: Record<string, any> }> {
  const server = buildFolioMcpServer(actor);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* an error message */
    }
    return { isError: result.isError === true, text, json };
  } finally {
    await client.close();
  }
}

describe('MCP template tools', () => {
  let teardownSchema: () => Promise<void>;
  let editor: User;
  let viewer: User;
  let space: string;

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    editor = await authStore.createUser({ email: `tpl-editor-${stamp}@test.local`, name: 'Tina Editor', passwordHash: 'x', isAdmin: false });
    viewer = await authStore.createUser({ email: `tpl-viewer-${stamp}@test.local`, name: 'Vic Viewer', passwordHash: 'x', isAdmin: false });
    space = (await storage.createSpace(`MCP Templates ${stamp}`, null)).slug;
    await authStore.setMembership(space, editor.id, 'editor');
    await authStore.setMembership(space, viewer.id, 'viewer');
  });
  afterAll(async () => {
    await deleteTestSpace(space);
    await teardownSchema();
  });

  const asEditor = (): McpActor => ({ user: editor, scopes: ['read', 'write'], tokenId: 'tpl-editor' });
  const asViewer = (): McpActor => ({ user: viewer, scopes: ['read', 'write'], tokenId: 'tpl-viewer' });
  const asReadOnlyEditor = (): McpActor => ({ user: editor, scopes: ['read'], tokenId: 'tpl-editor-ro' });

  it('save_page_as_template copies a page with its subpages; list_templates shows it with its description; create_page refuses _templates', async () => {
    const parent = (await call(asEditor(), 'create_page', { space, parentPath: '', title: 'Meeting', markdown: '# Meeting\n\nOn {{date}} by {{author}}: {{title}}\n' })).json;
    await call(asEditor(), 'create_page', { space, parentPath: 'meeting', title: 'Agenda', markdown: '# Agenda\n\nItems for {{title}}\n' });

    const saved = await call(asEditor(), 'save_page_as_template', { id: parent.id, description: 'Weekly meeting notes' });
    expect(saved.isError).toBe(false);
    expect(saved.json.path).toMatch(/^_templates\//);
    expect(saved.json.url).toContain(saved.json.id);
    expect(await storage.getEntry(parent.id)).toBeTruthy(); // the original stays

    const listed = await call(asEditor(), 'list_templates', { space });
    expect(listed.json).toEqual([expect.objectContaining({ id: saved.json.id, title: 'Meeting', kind: 'doc', description: 'Weekly meeting notes' })]);
    // templates stay out of the ordinary tree
    expect(JSON.stringify((await call(asEditor(), 'list_tree', { space })).json)).not.toContain(saved.json.id);

    const refused = await call(asEditor(), 'create_page', { space, parentPath: '_templates', title: 'Sneaky' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('templates folder');
    expect((await call(asEditor(), 'save_page_as_template', { id: saved.json.id })).text).toContain('already a template');
  });

  it('create_page_from_template copies the template and its subpages, fills the placeholders and drops the description', async () => {
    const [tpl] = (await call(asEditor(), 'list_templates', { space })).json as unknown as Array<{ id: string }>;
    const made = await call(asEditor(), 'create_page_from_template', { templateId: tpl.id, space, parentPath: '', title: 'Sprint sync' });
    expect(made.isError).toBe(false);
    expect(made.json.title).toBe('Sprint sync');
    expect(made.json.path).not.toMatch(/^_templates\//);
    const body = await storage.readFreshDocBody(made.json.id);
    expect(body).toContain('by Tina Editor: Sprint sync');
    expect(body).not.toContain('{{');
    const agendas = (await storage.listEntries(space)).filter((e) => e.title === 'Agenda' && !storage.isUnderTemplates(e.relPath));
    expect(agendas.length).toBeGreaterThanOrEqual(2); // the original's Agenda and the copy's
    expect(JSON.stringify((await call(asEditor(), 'read_page', { id: made.json.id })).json)).not.toContain('template-description');

    expect((await call(asEditor(), 'create_page_from_template', { templateId: tpl.id, space, parentPath: '_templates' })).text).toContain('templates folder');
    expect((await call(asEditor(), 'create_page_from_template', { templateId: made.json.id, space, parentPath: '' })).text).toContain('not a template');
  });

  it('create_template writes a blank template with markdown into _templates', async () => {
    const made = await call(asEditor(), 'create_template', { space, title: 'Decision', description: 'ADR', markdown: 'Decided on {{date}}.\n' });
    expect(made.isError).toBe(false);
    expect(made.json.path).toMatch(/^_templates\//);
    const body = await storage.readFreshDocBody(made.json.id);
    expect(body.startsWith('# Decision')).toBe(true);
    expect(body).toContain('Decided on {{date}}.');
    const listed = (await call(asEditor(), 'list_templates', { space })).json as unknown as Array<{ title: string; description?: string }>;
    expect(listed.find((t) => t.title === 'Decision')?.description).toBe('ADR');
  });

  it('a viewer or a read-only token can list but not write templates', async () => {
    const [tpl] = (await call(asViewer(), 'list_templates', { space })).json as unknown as Array<{ id: string }>;
    expect(tpl).toBeTruthy();
    const page = (await call(asEditor(), 'create_page', { space, parentPath: '', title: 'Plain' })).json;
    const writes: Array<[string, Record<string, unknown>]> = [
      ['create_page_from_template', { templateId: tpl.id, space, parentPath: '' }],
      ['save_page_as_template', { id: page.id }],
      ['create_template', { space, title: 'Nope' }],
    ];
    for (const [name, args] of writes) {
      const asViewerRes = await call(asViewer(), name, args);
      expect(asViewerRes.isError, `${name} as viewer`).toBe(true);
      expect(asViewerRes.text).toContain('requires editor');
      const readOnly = await call(asReadOnlyEditor(), name, args);
      expect(readOnly.isError, `${name} read-only token`).toBe(true);
      expect(readOnly.text).toContain('write scope');
    }
    expect((await storage.listTemplates(space)).map((t) => t.title)).not.toContain('Nope');
  });

  it('list_templates is unavailable on a public site', async () => {
    const out = await call({ user: viewer, scopes: ['read'], tokenId: 'tpl-public', publicSpace: space }, 'list_templates', { space });
    expect(out.isError).toBe(true);
  });
});
