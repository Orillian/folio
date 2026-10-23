/**
 * MCP builders (16.10.2026, owner: "the assistant must be able to build forms, tables, bases…"): create_form,
 * update_form, read_page on a form/table, folio_table_update_column / delete_column / save_view / delete_view and
 * convert_canvas_to_board. Real PG + real files + git, through the SDK's in-memory transport, so the zod input
 * schemas and the outputSchemas are exercised too.
 *
 * What is proven: each tool reaches the web app's own writers (storage.createPage / createFormFromTable /
 * writeFormDoc, tables.addColumn / updateColumn / addView …, convertCanvasPage) and the result is what the UI makes
 * (a form whose fields are columns of its paired table, answerable by submitForm; status columns seeded with the
 * preset); the role, scope and page-ACL gates; the etag 409 of update_form; the validation errors; authorship.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { User } from '../shared/contracts.js';
import { STATUS_PRESET_OPTIONS } from '../shared/tables/index.js';
import * as authStore from './auth/store.js';
import { query } from './db/pool.js';
import { deleteTestSpace, setUpTestSchema } from './db/testSchema.js';
import { submitForm } from './forms/service.js';
import * as gitSync from './gitSync.js';
import { buildFolioMcpServer, type McpActor } from './mcp.js';
import * as pageAccess from './pageAccess.js';
import * as storage from './storage.js';
import * as tables from './tables/service.js';

const execFileAsync = promisify(execFile);

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

async function call(actor: McpActor, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const server = buildFolioMcpServer(actor);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

const text = (r: ToolResult): string => (r.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
function ok<T = Record<string, any>>(r: ToolResult): T {
  expect(r.isError, text(r)).toBeFalsy();
  expect(r.structuredContent).toBeTruthy();
  return r.structuredContent as T;
}
function fails(r: ToolResult, fragment: string): void {
  expect(r.isError, `expected an error containing "${fragment}", got: ${text(r)}`).toBe(true);
  expect(text(r)).toContain(fragment);
}

describe('MCP builders: forms, table columns and views, canvas -> board (real PG + git)', () => {
  let teardownSchema: () => Promise<void>;
  let owner: User;
  let editor: User;
  let viewer: User;
  let outsider: User;
  let slug: string;
  let dir: string;
  const ids: Record<string, string> = {};

  const as = (user: User, scopes: Array<'read' | 'write'> = ['read', 'write']): McpActor => ({ user, scopes, tokenId: `test-${user.id}` });
  const git = async (...args: string[]): Promise<string> => (await execFileAsync('git', args, { cwd: storage.getRepoDir(slug) })).stdout.trim();

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    const stamp = Date.now();
    const mk = (name: string) => authStore.createUser({ email: `mbl-${name}-${stamp}@example.com`, name, passwordHash: 'x', isAdmin: false });
    owner = await mk('Owner');
    editor = await mk('Editor');
    viewer = await mk('Viewer');
    outsider = await mk('Outsider');
    slug = (await storage.createSpace(`MCP Builders ${stamp}`, owner.id)).slug;
    await authStore.setMembership(slug, owner.id, 'admin');
    await authStore.setMembership(slug, editor.id, 'editor');
    await authStore.setMembership(slug, viewer.id, 'viewer');
    dir = storage.getSpaceDir(slug);
    await fs.mkdir(path.join(dir, 'events'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'events/plan.canvas'),
      JSON.stringify({
        nodes: [
          { id: 'g', type: 'group', label: 'Week 1', x: 0, y: 0, width: 600, height: 300 },
          { id: 'a', type: 'text', text: '# Kickoff', x: 40, y: 40, width: 200, height: 80 },
          { id: 'b', type: 'text', text: 'Retro', x: 320, y: 40, width: 200, height: 80 },
        ],
        edges: [{ id: 'e', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left', label: 'then' }],
      }),
    );
    await storage.scanSpace(slug);
    ids.canvas = (await storage.getEntryIdByExactPath(slug, 'events/plan.canvas'))!;
    // An existing table to put forms on, and one the editor may only read.
    ids.requests = (
      await tables.createTable(slug, 'events', 'Requests', [
        { id: 'title', name: 'Title', type: 'text' },
        { id: 'priority', name: 'Priority', type: 'select', options: [{ value: 'low', color: 'green' }, { value: 'high', color: 'red' }] },
        { id: 'qty', name: 'Qty', type: 'number' },
      ])
    ).id;
    ids.locked = (await tables.createTable(slug, '', 'Locked', [{ id: 'name', name: 'Name', type: 'text' }])).id;
    await pageAccess.setAccess(owner, (await storage.getEntry(ids.locked))!, 'restricted', [{ userId: editor.id, role: 'viewer' }]);
    await git('add', '-A');
    await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixtures', '--allow-empty');
  });
  afterAll(async () => {
    await deleteTestSpace(slug);
    await teardownSchema();
  });

  // ---------------------------------------------------------------- forms

  describe('create_form', () => {
    it('creates the form and its paired table as one pair: one column per field, settings applied, status seeded, answerable', async () => {
      const r = ok(
        await call(as(editor), 'create_form', {
          space: slug,
          parentPath: 'events',
          title: 'Offsite feedback',
          description: 'Two minutes.',
          submitButton: 'Send',
          fields: [
            { label: 'Your name', type: 'text', help: 'Optional' },
            { label: 'Rating', type: 'select', options: ['1', '2', { value: '3', color: 'green' }], required: true },
            { label: 'State', type: 'status' },
          ],
        }),
      );
      expect(r.kind).toBe('form');
      expect(r.path).toBe('events/offsite-feedback.form.md');
      expect(r.form).toMatchObject({ title: 'Offsite feedback', description: 'Two minutes.', submitButton: 'Send', public: false });
      expect(r.form.fields).toEqual([
        { columnId: 'your_name', label: 'Your name', help: 'Optional', required: false, kind: 'text' },
        { columnId: 'rating', label: 'Rating', required: true, kind: 'select' },
        { columnId: 'state', label: 'State', required: false, kind: 'status' },
      ]);
      expect(r.columnsAdded).toEqual(['your_name', 'rating', 'state']);
      expect(r.etag).toMatch(/^[0-9a-f]{40}$/);
      // The table is the form's child page, with exactly these columns — the status one seeded like the web app does.
      const table = await tables.getTableSnapshot(r.tableId);
      expect(table.meta.path).toBe('events/offsite-feedback/offsite-feedback.table.md');
      expect(table.columns.map((c) => [c.id, c.name, c.type])).toEqual([
        ['your_name', 'Your name', 'text'],
        ['rating', 'Rating', 'select'],
        ['state', 'State', 'status'],
      ]);
      expect(table.columns[1]!.options!.map((o) => o.value)).toEqual(['1', '2', '3']);
      expect(table.columns[2]!.options).toEqual(STATUS_PRESET_OPTIONS);
      expect(r.form.table).toEqual({ id: r.tableId, path: table.meta.path });

      // read_page shows the same definition and etag; the form takes an answer through the web's own submit path.
      const read = ok(await call(as(viewer), 'read_page', { id: r.id }));
      expect(read.form).toEqual(r.form);
      expect(read.etag).toBe(r.etag);
      const { rowId } = await submitForm((await storage.requireEntry(r.id))!, 'Viewer', { your_name: 'Ann', rating: '3', state: 'DONE' });
      const rows = await tables.queryRows(r.tableId, {});
      expect(rows.rows.find((row) => row.id === rowId)?.values).toMatchObject({ your_name: 'Ann', rating: '3', state: 'DONE', submitter: 'Viewer' });
      ids.feedback = r.id;
      ids.feedbackTable = r.tableId;

      // Committed as the editor, audited with the tool name.
      await gitSync.flushAllPendingSyncs();
      expect(await git('log', '-1', '--format=%an', '--', 'events/offsite-feedback.form.md')).toBe('Editor');
      await vi.waitFor(async () => {
        const audit = await query<{ meta: { tool: string } }>(`SELECT meta FROM audit_log WHERE action = 'page.created' AND target = $1`, [r.id]);
        expect(audit[0]?.meta.tool).toBe('create_form');
      });
    });

    it('without fields: the same starter as "+ -> Form" (one text field)', async () => {
      const r = ok(await call(as(editor), 'create_form', { space: slug, title: 'Blank form' }));
      expect(r.form.fields).toHaveLength(1);
      expect(r.form.fields[0]).toMatchObject({ kind: 'text', required: false });
      expect(r.path).toBe('blank-form.form.md');
    });

    it('on an existing table: the form goes under the table and starts with one field per column; `fields` picks columns and adds new ones', async () => {
      const all = ok(await call(as(editor), 'create_form', { space: slug, title: 'All columns', table: ids.requests }));
      expect(all.path.startsWith('events/requests/')).toBe(true);
      expect(all.form.fields.map((f: { columnId: string }) => f.columnId)).toEqual(['title', 'priority', 'qty']);
      expect(all.tableId).toBe(ids.requests);
      expect(all.columnsAdded).toEqual([]);

      const picked = ok(
        await call(as(editor), 'create_form', {
          space: slug,
          title: 'New request',
          table: ids.requests,
          public: true,
          fields: [
            { columnId: 'priority', label: 'How urgent?', required: true },
            { columnId: 'title', label: 'What do you need?', type: 'text' },
            { label: 'Due', type: 'date' },
          ],
        }),
      );
      expect(picked.form.public).toBe(true);
      expect(picked.form.fields).toEqual([
        { columnId: 'priority', label: 'How urgent?', required: true, kind: 'select' },
        { columnId: 'title', label: 'What do you need?', required: false, kind: 'text' },
        { columnId: 'due', label: 'Due', required: false, kind: 'date' },
      ]);
      expect(picked.columnsAdded).toEqual(['due']);
      expect((await tables.getTableSnapshot(ids.requests)).columns.map((c) => c.id)).toEqual(['title', 'priority', 'qty', 'due']);
      ids.request = picked.id;
    });

    it('validation errors come back before anything is written', async () => {
      const before = (await tables.getTableSnapshot(ids.requests)).columns.length;
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ space: slug, title: 'X', table: ids.requests, fields: [{ columnId: 'nope', label: 'Q' }] }, 'has no column "nope"'],
        [{ space: slug, title: 'X', table: ids.requests, fields: [{ label: 'New', type: 'text' }, { columnId: 'submitted_at', label: 'When' }] }, 'filled in by Folio'],
        [{ space: slug, title: 'X', table: ids.requests, fields: [{ columnId: 'qty', label: 'A' }, { columnId: 'qty', label: 'B' }] }, 'already used'],
        [{ space: slug, title: 'X', table: ids.requests, fields: [{ columnId: 'qty', label: 'A', type: 'text' }] }, 'is of type number'],
        [{ space: slug, title: 'X', table: ids.requests, fields: [{ columnId: 'priority', label: 'A', options: ['x'] }] }, 'belong to the column'],
        [{ space: slug, title: 'X', fields: [{ label: 'A', type: 'text', options: ['x'] }] }, 'select and status fields only'],
        [{ space: slug, title: 'X', fields: [{ columnId: 'title', label: 'A' }] }, 'no table yet'],
        [{ space: slug, title: 'X', table: ids.canvas }, 'not a data table'],
      ];
      for (const [args, fragment] of cases) fails(await call(as(editor), 'create_form', args), fragment);
      expect((await tables.getTableSnapshot(ids.requests)).columns.length).toBe(before);
      expect(await storage.getEntryIdByExactPath(slug, 'x.form.md')).toBeUndefined();
      // The input schema itself: an unknown field type.
      expect((await call(as(editor), 'create_form', { space: slug, title: 'X', fields: [{ label: 'A', type: 'rating' }] })).isError).toBe(true);
    });

    it('roles, scope and page access: a viewer, a read-only token, an outsider and a table the editor may only read are refused', async () => {
      fails(await call(as(viewer), 'create_form', { space: slug, title: 'V' }), 'requires editor+');
      fails(await call(as(editor, ['read']), 'create_form', { space: slug, title: 'R' }), 'write scope');
      fails(await call(as(outsider), 'create_form', { space: slug, title: 'O' }), 'space not found');
      fails(await call(as(editor), 'create_form', { space: slug, title: 'L', table: ids.locked }), "requires editor+ role in this page's space");
      fails(await call(as(outsider), 'create_form', { space: slug, title: 'L', table: ids.locked }), 'space not found');
      fails(await call(as(editor), 'create_form', { space: slug, parentPath: '.agent', title: 'A' }), '.agent is admin-only');
    });
  });

  describe('update_form', () => {
    it('changes settings and the ordered field list like the editor\'s Save: new columns added, a dropped field keeps its column', async () => {
      const before = ok(await call(as(editor), 'read_page', { id: ids.feedback }));
      const r = ok(
        await call(as(editor), 'update_form', {
          id: ids.feedback,
          etag: before.etag,
          description: null,
          public: true,
          fields: [
            { columnId: 'rating', label: 'Overall rating', required: true },
            { columnId: 'your_name', label: 'Name', required: true },
            { label: 'E-mail', type: 'text' },
            { label: 'Topics', type: 'select', multiple: true, options: ['food', 'talks'] },
          ],
        }),
      );
      expect(r.form.description).toBeUndefined();
      expect(r.form.public).toBe(true);
      expect(r.form.title).toBe('Offsite feedback');
      expect(r.form.fields.map((f: { columnId: string; label: string; required: boolean }) => [f.columnId, f.label, f.required])).toEqual([
        ['rating', 'Overall rating', true],
        ['your_name', 'Name', true],
        ['e_mail', 'E-mail', false],
        ['topics', 'Topics', false],
      ]);
      expect(r.columnsAdded).toEqual(['e_mail', 'topics']);
      expect(r.etag).not.toBe(before.etag);
      const columns = (await tables.getTableSnapshot(ids.feedbackTable)).columns;
      // `state` is no longer a field but stays a column (and keeps its answers); the two new fields are new columns.
      expect(columns.map((c) => c.id)).toEqual(expect.arrayContaining(['your_name', 'rating', 'state', 'e_mail', 'topics']));
      expect(columns.find((c) => c.id === 'topics')).toMatchObject({ type: 'select', multiple: true });
      // A kept field keeps what is not given (its hint here); a field given by columnId alone keeps everything but its place.
      expect(r.form.fields[1].help).toBe('Optional');
      const minimal = ok(await call(as(editor), 'update_form', { id: ids.feedback, etag: r.etag, fields: [{ columnId: 'your_name', help: '' }, { columnId: 'rating', required: false }] }));
      expect(minimal.form.fields).toEqual([
        { columnId: 'your_name', label: 'Name', required: true, kind: 'text' },
        { columnId: 'rating', label: 'Overall rating', required: false, kind: 'select' },
      ]);
      fails(await call(as(editor), 'update_form', { id: ids.feedback, fields: [{ type: 'text' }] }), 'a new field needs a label');
    });

    it('settings only: the fields stay as they are', async () => {
      const before = ok(await call(as(editor), 'read_page', { id: ids.feedback }));
      const r = ok(await call(as(editor), 'update_form', { id: ids.feedback, title: 'Offsite feedback 2026', submitButton: null }));
      expect(r.form.title).toBe('Offsite feedback 2026');
      expect(r.form.submitButton).toBeUndefined();
      expect(r.form.fields).toEqual(before.form.fields);
      expect(r.title).toBe('Offsite feedback 2026');
    });

    it('a stale etag is refused with the current one, and nothing is written (no column either)', async () => {
      const columns = (await tables.getTableSnapshot(ids.feedbackTable)).columns.length;
      const current = ok(await call(as(editor), 'read_page', { id: ids.feedback })).etag as string;
      const r = await call(as(editor), 'update_form', { id: ids.feedback, etag: 'deadbeef', fields: [{ label: 'Extra' }] });
      fails(r, `current etag: ${current}`);
      expect((await tables.getTableSnapshot(ids.feedbackTable)).columns.length).toBe(columns);
      expect(ok(await call(as(editor), 'read_page', { id: ids.feedback })).etag).toBe(current);
    });

    it('validation, roles and the paired table\'s own access', async () => {
      fails(await call(as(editor), 'update_form', { id: ids.feedback }), 'nothing to change');
      fails(await call(as(editor), 'update_form', { id: ids.requests, title: 'T' }), 'not a form');
      fails(await call(as(editor), 'update_form', { id: ids.feedback, fields: [{ columnId: 'ghost', label: 'G' }] }), 'has no column "ghost"');
      fails(await call(as(viewer), 'update_form', { id: ids.feedback, title: 'V' }), 'requires editor+');
      fails(await call(as(editor, ['read']), 'update_form', { id: ids.feedback, title: 'R' }), 'write scope');
      fails(await call(as(outsider), 'update_form', { id: ids.feedback, title: 'O' }), 'page not found');
      // A form on the locked table is placed under it and inherits its restriction (stage 7): the editor, who may only
      // view the table, may not edit the form either; the owner may.
      const lockedForm = ok(await call(as(owner), 'create_form', { space: slug, title: 'Locked form', table: ids.locked }));
      fails(await call(as(editor), 'update_form', { id: lockedForm.id, title: 'Locked form, renamed' }), 'requires editor+');
      fails(await call(as(editor), 'update_form', { id: lockedForm.id, fields: [{ columnId: 'name', label: 'Name' }, { label: 'New' }] }), 'requires editor+');
      ok(await call(as(owner), 'update_form', { id: lockedForm.id, title: 'Locked form, renamed' }));
      expect((await tables.getTableSnapshot(ids.locked)).columns.map((c) => c.id)).toEqual(['name']);
    });
  });

  // ---------------------------------------------------------------- tables

  describe('table columns and views', () => {
    let t: string;
    beforeAll(async () => {
      const created = ok(
        await call(as(editor), 'folio_table_create', {
          space: slug,
          parentPath: '',
          title: 'Tasks',
          columns: [
            { name: 'Task', type: 'text' },
            { name: 'Estimate', type: 'number' },
            { name: 'State', type: 'status' },
          ],
        }),
      );
      t = created.id;
      ok(await call(as(editor), 'folio_table_insert', { id: t, rows: [{ task: 'A', estimate: 3, state: 'DONE' }, { task: 'B', estimate: 5, state: 'IN PROG' }] }));
    });

    it('a status column made through MCP gets the status preset, as in the web app', async () => {
      expect((await tables.getTableSnapshot(t)).columns.find((c) => c.id === 'state')?.options).toEqual(STATUS_PRESET_OPTIONS);
      const added = ok(await call(as(editor), 'folio_table_add_column', { id: t, name: 'Phase', type: 'status' }));
      expect(added.options).toEqual(STATUS_PRESET_OPTIONS);
    });

    it('folio_table_update_column: rename, options as labels, a type change with its conversion report', async () => {
      const renamed = ok(await call(as(editor), 'folio_table_update_column', { id: t, columnId: 'task', name: 'Title', description: 'What to do' }));
      expect(renamed.column).toMatchObject({ id: 'task', name: 'Title', type: 'text', description: 'What to do' });
      expect(renamed).toMatchObject({ converted: 0, cleared: 0 });
      const opts = ok(await call(as(editor), 'folio_table_update_column', { id: t, columnId: 'phase', options: ['Draft', { value: 'Final', color: 'green' }] }));
      expect(opts.column.options).toEqual([{ value: 'Draft', color: 'gray' }, { value: 'Final', color: 'green' }]);
      const typed = ok(await call(as(editor), 'folio_table_update_column', { id: t, columnId: 'estimate', type: 'text' }));
      expect(typed.column.type).toBe('text');
      expect(typed.converted).toBe(2);
      const rows = await tables.queryRows(t, {});
      expect(rows.rows.map((r) => r.values.estimate)).toEqual(['3', '5']);
    });

    it('folio_table_update_column / delete_column: errors and roles', async () => {
      fails(await call(as(editor), 'folio_table_update_column', { id: t, columnId: 'task' }), 'nothing to change');
      fails(await call(as(editor), 'folio_table_update_column', { id: t, columnId: 'ghost', name: 'G' }), 'not found');
      fails(await call(as(editor), 'folio_table_update_column', { id: ids.feedback, columnId: 'rating', name: 'G' }), 'not a data table');
      fails(await call(as(viewer), 'folio_table_update_column', { id: t, columnId: 'task', name: 'V' }), 'requires editor+');
      fails(await call(as(editor, ['read']), 'folio_table_delete_column', { id: t, columnId: 'task' }), 'write scope');
      fails(await call(as(editor), 'folio_table_delete_column', { id: ids.locked, columnId: 'name' }), 'requires editor+');
      fails(await call(as(editor), 'folio_table_delete_column', { id: t, columnId: 'ghost' }), 'not found');
      const deleted = ok(await call(as(editor), 'folio_table_delete_column', { id: t, columnId: 'phase' }));
      expect(deleted).toEqual({ deleted: 'phase' });
      expect((await tables.getTableSnapshot(t)).columns.map((c) => c.id)).toEqual(['task', 'estimate', 'state']);
    });

    it('folio_table_save_view: creates a view, changes only what is given, refuses unknown columns and views; delete_view keeps the last one', async () => {
      const created = ok(
        await call(as(editor), 'folio_table_save_view', {
          id: t,
          name: 'Open',
          filter: { op: 'and', rules: [{ column: 'state', operator: 'is_not', value: 'DONE' }] },
          sort: [{ column: 'task', dir: 'desc' }],
          hiddenColumns: ['estimate'],
        }),
      );
      expect(created.created).toBe(true);
      expect(created.view).toMatchObject({ name: 'Open', sort: [{ column: 'task', dir: 'desc' }], columns: { hidden: ['estimate'] }, frozen: 0, rowHeight: 'short' });
      const viewId = created.view.id as string;
      const q = ok(await call(as(viewer), 'folio_table_query', { id: t, view: viewId, format: 'json' }));
      expect(q.rows.map((r: { values: { task: string } }) => r.values.task)).toEqual(['B']);

      const renamed = ok(await call(as(editor), 'folio_table_save_view', { id: t, viewId, name: 'Not done', rowHeight: 'tall' }));
      expect(renamed.created).toBe(false);
      expect(renamed.view).toMatchObject({ id: viewId, name: 'Not done', rowHeight: 'tall', columns: { hidden: ['estimate'] } });
      expect((await tables.getTableSnapshot(t)).views.find((v) => v.id === viewId)?.filter.rules).toHaveLength(1);

      fails(await call(as(editor), 'folio_table_save_view', { id: t }), 'name is required');
      fails(await call(as(editor), 'folio_table_save_view', { id: t, viewId }), 'nothing to change');
      fails(await call(as(editor), 'folio_table_save_view', { id: t, name: 'Bad', sort: [{ column: 'nope', dir: 'asc' }] }), 'has no column nope');
      fails(await call(as(editor), 'folio_table_save_view', { id: t, viewId: 'ghost', name: 'G' }), 'has no view "ghost"');
      fails(await call(as(viewer), 'folio_table_save_view', { id: t, name: 'V' }), 'requires editor+');

      ok(await call(as(editor), 'folio_table_delete_view', { id: t, viewId }));
      const views = (await tables.getTableSnapshot(t)).views;
      expect(views).toHaveLength(1);
      fails(await call(as(editor), 'folio_table_delete_view', { id: t, viewId: views[0]!.id }), 'cannot delete the last view');
      fails(await call(as(editor, ['read']), 'folio_table_delete_view', { id: t, viewId: views[0]!.id }), 'write scope');
    });

    it('read_page on a table answers with its metadata and points at the table tools instead of failing', async () => {
      const r = ok(await call(as(viewer), 'read_page', { id: t }));
      expect(r.kind).toBe('table');
      expect(r.note).toContain('folio_table_schema');
    });
  });

  // ---------------------------------------------------------------- canvas

  describe('convert_canvas_to_board', () => {
    it('makes a new board next to the canvas, leaves the canvas alone, commits as the caller', async () => {
      const canvasBefore = await fs.readFile(path.join(dir, 'events/plan.canvas'), 'utf8');
      const r = ok(await call(as(editor), 'convert_canvas_to_board', { id: ids.canvas, title: 'Plan board' }));
      expect(r.board).toMatchObject({ kind: 'board', title: 'Plan board' });
      expect(r.board.path.startsWith('events/')).toBe(true);
      expect(Array.isArray(r.report.losses)).toBe(true);
      expect(await fs.readFile(path.join(dir, 'events/plan.canvas'), 'utf8')).toBe(canvasBefore);
      const board = ok(await call(as(viewer), 'read_page', { id: r.board.id }));
      expect((board.scene.frames as Array<{ label: string }>).map((f) => f.label)).toContain('Week 1');
      expect(board.scene.arrows).toHaveLength(1);
      expect(await git('log', '-1', '--format=%an')).toBe('Editor');
    });

    it('refuses a page that is not a canvas, a viewer, a read-only token and an outsider', async () => {
      fails(await call(as(editor), 'convert_canvas_to_board', { id: ids.requests }), 'not a canvas');
      fails(await call(as(viewer), 'convert_canvas_to_board', { id: ids.canvas }), 'requires editor+');
      fails(await call(as(editor, ['read']), 'convert_canvas_to_board', { id: ids.canvas }), 'write scope');
      fails(await call(as(outsider), 'convert_canvas_to_board', { id: ids.canvas }), 'page not found');
    });
  });
});
