/**
 * The owner's report (16.10.2026, screenshot): Folio AI in Agent mode, on a form page, answered that it "cannot
 * build a form through the agent — the tools only do documents, boards and tables". This drives a whole assistant
 * run (runCursorAssistant: the real workspace, prompt and in-process MCP tools) with the Cursor SDK replaced by a
 * scripted model that does what a model would: reads the forms skill, builds a form with three fields through the
 * tools the run offers, reads it back. Real PostgreSQL and real files.
 *
 * In Ask mode the same script finds no create_form to call — the tool is not offered at all.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SDKCustomTool } from '@cursor/sdk';
import type { User } from '../../shared/contracts.js';

/** What the scripted "model" did in the last run. */
const script = vi.hoisted(() => ({
  prompt: '',
  offered: [] as string[],
  calls: [] as Array<{ name: string; args: unknown; text: string; isError: boolean }>,
  steps: [] as Array<(results: Array<{ text: string }>) => { name: string; args: Record<string, unknown> } | null>,
}));

const sdkMock = vi.hoisted(() => {
  const agent = {
    reload: async () => {},
    close: async () => {},
    send: async (prompt: string, options: { local?: { customTools?: Record<string, SDKCustomTool> } }) => {
      script.prompt = prompt;
      const tools = options.local?.customTools ?? {};
      script.offered = Object.keys(tools);
      script.calls = [];
      for (const step of script.steps) {
        const next = step(script.calls);
        if (!next) break;
        const tool = tools[next.name];
        if (!tool) {
          script.calls.push({ name: next.name, args: next.args, text: `no such tool: ${next.name}`, isError: true });
          break;
        }
        const out = (await tool.execute(next.args as never, {} as never)) as unknown;
        const text = typeof out === 'string' ? out : ((out as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');
        script.calls.push({ name: next.name, args: next.args, text, isError: typeof out !== 'string' && !!(out as { isError?: boolean }).isError });
      }
      const last = script.calls.at(-1);
      return {
        supports: () => false,
        wait: async () => ({ status: 'finished', result: last && !last.isError ? 'Form created.' : 'I could not create the form.' }),
        cancel: async () => {},
      };
    },
  };
  return { resume: vi.fn(async () => agent), create: vi.fn(async () => agent), configure: vi.fn() };
});

vi.mock('@cursor/sdk', () => ({
  Cursor: { configure: sdkMock.configure },
  JsonlLocalAgentStore: class {},
  Agent: { resume: sdkMock.resume, create: sdkMock.create },
}));
vi.mock('./cursorCliConfig.js', () => ({ ensureAssistantCursorPermissions: vi.fn() }));

const realNodeVersions = process.versions;
{
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '22.13.0' }, configurable: true });
  }
}

const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-assistant-ws-'));
const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-assistant-state-'));
process.env.CURSOR_AGENT_WORKSPACE_ROOT = workspaceRoot;
process.env.CURSOR_AGENT_STATE_DIR = stateDir;

const { setUpTestSchema, deleteTestSpace } = await import('../db/testSchema.js');
const authStore = await import('../auth/store.js');
const storage = await import('../storage.js');
const tables = await import('../tables/service.js');
const { runCursorAssistant } = await import('./cursorRuntime.js');
const assistantStore = await import('./store.js');

describe('the assistant builds a form through its tools (runCursorAssistant, scripted model, real PG)', () => {
  let teardownSchema: () => Promise<void>;
  let maria: User;
  let slug: string;
  let pageId: string;
  const stamp = Date.now();

  beforeAll(async () => {
    teardownSchema = await setUpTestSchema();
    maria = await authStore.createUser({ email: `form-builder-${stamp}@test.local`, name: 'Maria', passwordHash: 'x', isAdmin: false });
    slug = (await storage.createSpace(`Forms ${stamp}`, maria.id)).slug;
    await authStore.setMembership(slug, maria.id, 'editor');
    pageId = (await storage.createPage({ space: slug, parentPath: '', title: 'Events', kind: 'doc' }, { docBody: '# Events\n\nOffsite in November.\n' })).id;
  });

  afterAll(async () => {
    await deleteTestSpace(slug).catch(() => {});
    await teardownSchema();
    Object.defineProperty(process, 'versions', { value: realNodeVersions, configurable: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  const formArgs = () => ({
    space: slug,
    parentPath: 'events',
    title: 'Offsite sign-up',
    fields: [
      { label: 'Name', type: 'text', required: true },
      { label: 'Diet', type: 'select', options: ['none', 'vegetarian', 'vegan'] },
      { label: 'Arrival', type: 'date', help: 'The day you arrive' },
    ],
  });

  async function run(mode: 'ask' | 'agent'): Promise<string> {
    const conversation = await assistantStore.insertConversation({ userId: maria.id, title: 'forms', cursorAgentId: `agent-${mode}-${stamp}`, model: 'composer-2' });
    return runCursorAssistant({
      runId: `run-${mode}`,
      apiKey: 'k',
      user: maria,
      conversation,
      message: 'Make a sign-up form for the offsite: name (required), diet, arrival date.',
      currentPath: null,
      space: slug,
      pageId,
      runMode: mode,
    });
  }

  it('Agent: read_skill(folio-forms) -> create_form with three fields -> read_page; the form and its table exist with those fields', async () => {
    script.steps = [
      () => ({ name: 'read_skill', args: { name: 'folio-forms' } }),
      () => ({ name: 'create_form', args: formArgs() }),
      (calls) => ({ name: 'read_page', args: { id: JSON.parse(calls[1]!.text).id } }),
    ];
    expect(await run('agent')).toBe('Form created.');

    // The run told the model about the skill and offered the builder tools.
    expect(script.prompt).toContain('folio-forms');
    expect(script.prompt).toContain('AGENT');
    for (const name of ['create_form', 'update_form', 'save_base', 'folio_table_save_view', 'set_page_properties']) expect(script.offered).toContain(name);
    expect(script.calls.map((c) => [c.name, c.isError])).toEqual([
      ['read_skill', false],
      ['create_form', false],
      ['read_page', false],
    ]);
    expect(script.calls[0]!.text).toContain('update_form');

    const created = JSON.parse(script.calls[1]!.text) as { id: string; space: string; tableId: string; form: { fields: Array<{ columnId: string; label: string; required: boolean; kind: string; help?: string }> } };
    expect(created.space).toBe(slug);
    expect(created.form.fields).toEqual([
      { columnId: 'name', label: 'Name', required: true, kind: 'text' },
      { columnId: 'diet', label: 'Diet', required: false, kind: 'select' },
      { columnId: 'arrival', label: 'Arrival', help: 'The day you arrive', required: false, kind: 'date' },
    ]);
    const read = JSON.parse(script.calls[2]!.text) as { kind: string; form: unknown };
    expect(read.kind).toBe('form');
    expect(read.form).toEqual((created as unknown as { form: unknown }).form);

    const entry = await storage.requireEntry(created.id);
    expect(entry.kind).toBe('form');
    expect(entry.relPath).toBe('events/offsite-sign-up.form.md');
    const table = await tables.getTableSnapshot(created.tableId);
    expect(table.columns.map((c) => c.id)).toEqual(['name', 'diet', 'arrival']);
    expect(table.columns[1]!.options!.map((o) => o.value)).toEqual(['none', 'vegetarian', 'vegan']);
  });

  it('Ask: the same request finds no create_form to call, and nothing is written', async () => {
    script.steps = [() => ({ name: 'create_form', args: { ...formArgs(), title: 'Ask attempt' } })];
    expect(await run('ask')).toBe('I could not create the form.');
    expect(script.prompt).toContain('ASK');
    expect(script.offered).not.toContain('create_form');
    expect(script.offered).toContain('read_page');
    expect(script.calls).toEqual([expect.objectContaining({ name: 'create_form', isError: true, text: 'no such tool: create_form' })]);
    expect(await storage.getEntryIdByExactPath(slug, 'events/ask-attempt.form.md')).toBeUndefined();
  });
});
