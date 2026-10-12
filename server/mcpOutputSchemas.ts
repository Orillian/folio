/**
 * `outputSchema` of every MCP tool (spec 2025-06-18, "Structured content"). The tools answer in two forms at
 * once: `structuredContent` (validated by the SDK against these schemas) and the same data as JSON text in
 * `content`, which older clients and models without structured-output support still read.
 *
 * The root of an output schema must be an object, so a tool whose natural answer is an array wraps it under one
 * named key (`{ spaces: [...] }`); the text form keeps the bare array it always had.
 *
 * Every object is loose (extra keys allowed) and anything the server could not promise on every code path is
 * optional: a schema that is stricter than the data would turn a working call into an error. `kind`/`status`
 * are plain strings for the same reason — the enums live in shared/contracts.ts and can grow.
 */
import { z } from 'zod';

export const pageMetaOutput = z.looseObject({
  id: z.string().describe('Page id'),
  space: z.string().describe('Space slug the page belongs to'),
  path: z.string().describe('Path relative to the space root'),
  kind: z.string().describe('Page kind: doc, board, table, pdf, office or form'),
  title: z.string().describe('Page title'),
  order: z.number().describe('Position among its siblings'),
  status: z.string().describe('Page status'),
  updatedAt: z.string().describe('Last change, ISO timestamp'),
  icon: z.string().optional().describe('Emoji icon, if the page has one'),
  cover: z.string().optional().describe('Cover image URL, if the page has one'),
});

const pageList = (key: string, what: string) => ({ [key]: z.array(pageMetaOutput).describe(what) });

const columnOutput = z.looseObject({
  id: z.string().describe('Column id — what the folio_table_* tools take as a key'),
  name: z.string().describe('Column title'),
  type: z.string().describe('Column type (text, number, select, status, date, checkbox, ...)'),
  description: z.string().optional().describe('Hint shown in the column header'),
  options: z.array(z.looseObject({})).optional().describe('Allowed values of a select or status column'),
});

const cellValueOutput = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);
const rowOutput = z.looseObject({
  id: z.string().describe('Row id'),
  values: z.record(z.string(), cellValueOutput).describe('Cell values keyed by column id'),
});

type TreeNodeOutput = z.infer<typeof pageMetaOutput> & { children: TreeNodeOutput[] };
const treeNodeOutput: z.ZodType<TreeNodeOutput> = z.lazy(() =>
  pageMetaOutput.extend({ children: z.array(treeNodeOutput).describe('Child pages') }),
);

export const outputSchemas = {
  list_spaces: {
    spaces: z
      .array(
        z.looseObject({
          slug: z.string().describe('Space slug'),
          name: z.string().describe('Space name'),
          pageCount: z.number().describe('Number of pages in the space'),
          myRole: z.string().optional().describe("The caller's own role in the space: viewer, editor or admin"),
        }),
      )
      .describe('Spaces the caller can see'),
  },
  list_tree: { tree: z.array(treeNodeOutput).describe('Top-level pages of the space; each carries its children') },
  read_page: {
    ...pageMetaOutput.shape,
    markdown: z.string().optional().describe('Document body as Markdown (doc pages)'),
    svg: z.string().optional().describe('Raw SVG source (board pages when no layout summary applies)'),
    scene: z.record(z.string(), z.unknown()).nullable().optional().describe('Board layout summary: shapes, arrows, texts, frames, layout rows/cols, bounds; null when the board has no readable scene'),
    note: z.string().optional().describe('Why the content is not returned (PDF/Office file, unreadable board)'),
  },
  page: pageMetaOutput.shape,
  board_ops: {
    summary: z.string().describe('What the operations changed'),
    elements: z.record(z.string(), z.unknown()).describe('Layout summary of the board after the operations'),
  },
  search_pages: {
    hits: z
      .array(
        z.looseObject({
          id: z.string().describe('Page id'),
          space: z.string().describe('Space slug'),
          path: z.string().describe('Path relative to the space root'),
          title: z.string().describe('Page title'),
          snippet: z.string().describe('Matching excerpt'),
        }),
      )
      .describe('Matching pages, best first'),
  },
  search: {
    results: z
      .array(z.looseObject({ id: z.string().describe('Page id — pass it to fetch'), title: z.string().describe('Page title'), url: z.string().describe('Link to the page in Folio') }))
      .describe('Matching pages'),
  },
  fetch: {
    id: z.string().describe('Page id'),
    title: z.string().describe('Page title'),
    text: z.string().describe('Page content as Markdown'),
    url: z.string().describe('Link to the page in Folio'),
    metadata: z.looseObject({ space: z.string(), path: z.string(), kind: z.string(), updatedAt: z.string() }).describe('Space, path, kind and last change of the page'),
  },
  resolve_folio_url: {
    ...pageMetaOutput.shape,
    parentPathForChildren: z.string().describe('Pass as parentPath to create_page to add a child under this page'),
    note: z.string().describe('Reminder to work within this page'),
  },
  get_backlinks: pageList('backlinks', 'Pages that link to the given page'),
  page_history: {
    revisions: z
      .array(
        z.looseObject({
          sha: z.string().describe('Commit sha — pass it to page_at_sha'),
          author: z.string().describe('Commit author'),
          date: z.string().describe('Commit date, ISO timestamp'),
          message: z.string().describe('Commit message'),
        }),
      )
      .describe('Revisions of the page, newest first'),
  },
  page_at_sha: {
    markdown: z.string().optional().describe('Body at that revision (doc and table pages)'),
    svg: z.string().optional().describe('Raw SVG at that revision (board pages)'),
    file: z.looseObject({ path: z.string(), ext: z.string(), size: z.number() }).optional().describe('Path, extension and size of a PDF/Office file at that revision'),
  },
  folio_table_list: pageList('tables', 'Data table pages'),
  folio_table_schema: {
    meta: z.looseObject({}).describe('Table metadata, including whether rows carry ids (rowIds mode)'),
    columns: z.array(columnOutput).describe('Columns in display order'),
    views: z.array(z.looseObject({})).describe('Saved views with their filter and sort'),
    rowCount: z.number().describe('Number of rows in the table'),
  },
  folio_table_query: {
    rows: z.array(rowOutput).optional().describe('Matching rows (format "json")'),
    columns: z.array(columnOutput).optional().describe('Columns of the table (format "json")'),
    markdown: z.string().optional().describe('Matching rows as a GFM table (format "markdown")'),
    total: z.number().describe('Rows matching the query before limit/offset'),
  },
  folio_table_insert: {
    rows: z.array(rowOutput).describe('The rows that were added, with their new ids'),
    rowCountWarning: z.string().optional().describe('Set when the table is getting large'),
  },
  folio_table_update: {
    id: z.string().optional().describe('Id of the updated row (update by rowId)'),
    values: z.record(z.string(), cellValueOutput).optional().describe('The row after the update (update by rowId)'),
    affected: z.number().optional().describe('Rows changed (update by filter)'),
  },
  folio_table_delete: { affected: z.number().describe('Rows deleted') },
  folio_table_add_column: columnOutput.shape,
  folio_table_create: pageMetaOutput.shape,
} as const;
