/**
 * Obsidian Bases (`.base`) in Folio (owner's decision 16.10.2026) — the shared
 * model. A base is a QUERY over pages, not storage: the file holds filters,
 * formulas and views (YAML, Obsidian's format, docs: obsidian-help/en/Bases/),
 * the rows are the pages of the space the reader may open, the columns their
 * properties (`note.*`), file fields (`file.*`) and formulas (`formula.*`).
 *
 *   GET  /api/pages/:id/base?view=<name>&offset=&limit=  viewer+ → BaseQueryResponse
 *   GET  /api/pages/:id/base/source                      viewer+ → BaseSourceResponse
 *   PUT  /api/pages/:id/base                             editor+ on the base page, body BaseWriteBody → BaseSourceResponse (409 + current on an etag mismatch)
 *   POST /api/spaces/:space/base/preview                 viewer+ on the space, body BasePreviewBody → BaseQueryResponse
 *        (a ```base block of a document, or the editor's unsaved draft; `this` = the embedding page)
 *
 * Editing a cell is editing THAT page's property through PUT /api/pages/:id/properties.
 */

/** A filter as written: one statement (an expression string) or a group. `not: [a, b]` = neither a nor b. */
export type BaseFilter = string | { and: BaseFilter[] } | { or: BaseFilter[] } | { not: BaseFilter[] };

export interface BaseSort {
  property: string;
  direction: 'ASC' | 'DESC';
}

export interface BaseGroupBy {
  property: string;
  direction: 'ASC' | 'DESC';
}

/** View types Folio renders; any other `type` falls back to a table with a notice. */
export const SUPPORTED_BASE_VIEW_TYPES = ['table', 'cards', 'list'] as const;
export type SupportedBaseViewType = (typeof SUPPORTED_BASE_VIEW_TYPES)[number];
/** The built-in Obsidian types the visual editor offers (kanban / map: "not supported yet"). */
export const KNOWN_BASE_VIEW_TYPES = ['table', 'cards', 'list', 'kanban', 'map'] as const;

export interface BaseView {
  type: string;
  name: string;
  filters?: BaseFilter;
  order?: string[];
  sort?: BaseSort[];
  groupBy?: BaseGroupBy;
  /** Only these groups, in this order; `null` = rows without a value. */
  groupOrder?: Array<string | number | boolean | null>;
  /** property id → summary name (built-in like `Average`, or a key of the base's `summaries`). */
  summaries?: Record<string, string>;
  limit?: number;
  /** Cards: the property that holds the cover image (a link, a URL or a hex colour). */
  image?: string;
  /** Every other key of the view, kept as it is. */
  [key: string]: unknown;
}

export interface BaseConfig {
  filters?: BaseFilter;
  formulas: Record<string, string>;
  /** property id → { displayName, … }. */
  properties: Record<string, { displayName?: string; [key: string]: unknown }>;
  /** Custom summary formulas over `values`. */
  summaries: Record<string, string>;
  views: BaseView[];
}

/** One evaluated value as the client renders it. */
export type BaseCell =
  | null
  | { t: 'text'; v: string }
  | { t: 'number'; v: number }
  | { t: 'bool'; v: boolean }
  /** `YYYY-MM-DD` (a date) or `YYYY-MM-DDTHH:MM:SS` (UTC). */
  | { t: 'date'; v: string }
  | { t: 'datetime'; v: string }
  | { t: 'duration'; v: string }
  /** `pageId` when the link reaches a page the reader may open; `url` for an external link. */
  | { t: 'link'; v: string; path?: string; pageId?: string; url?: string }
  | { t: 'list'; v: BaseCell[] }
  | { t: 'object'; v: string }
  /** The expression failed for this row (a type error, a bad argument). */
  | { t: 'error'; v: string }
  /** The expression uses a function Folio does not implement (its name). */
  | { t: 'unsupported'; v: string };

export type BaseColumnSource = 'note' | 'file' | 'formula';

export interface BaseColumn {
  /** The property id as written in the file (`status`, `note.status`, `file.name`, `formula.ppu`). */
  id: string;
  /** Display name: `properties.<id>.displayName`, else the name without its `note.` prefix. */
  label: string;
  source: BaseColumnSource;
  /** For `note` columns: the front matter key. */
  key?: string;
  /** A note property a reader with edit rights may change in place (never `file.*` / `formula.*`). */
  editable: boolean;
  /** A formula that cannot be evaluated by Folio: the reason (shown as a marker in the header). */
  unsupported?: string;
  /** The summary of this column for the whole result (view.summaries). */
  summary?: { name: string; value: BaseCell };
}

export interface BaseRow {
  /** The page's id. */
  id: string;
  title: string;
  path: string;
  kind: string;
  /** The reader may edit this page's properties (editor+ on the page, a token that may write, a page kind with properties). */
  canEdit: boolean;
  /** column id → value. */
  cells: Record<string, BaseCell>;
  /** Index into `groups` when the view is grouped. */
  group?: number;
  /** Cards: the cover (a URL, a page asset URL or `#rrggbb`). */
  cover?: string;
}

export interface BaseGroup {
  /** `null` = the rows without a value. */
  key: BaseCell;
  /** Rows in the group (all of them, not only the page). */
  count: number;
  summaries?: Record<string, BaseCell>;
}

export interface BaseViewInfo {
  name: string;
  type: string;
  /** Folio renders this type itself; otherwise the table fallback is shown with a notice. */
  supported: boolean;
}

export interface BaseQueryResponse {
  views: BaseViewInfo[];
  /** The view answered (its name), or null when the base has no views (a default table is shown). */
  view: string | null;
  /** What is rendered: the view's type when supported, else 'table'. */
  layout: SupportedBaseViewType;
  /** The view's declared type (kanban, map, a plugin's id…) when it is not supported. */
  unsupportedType?: string;
  columns: BaseColumn[];
  rows: BaseRow[];
  groups?: BaseGroup[];
  /** Rows after filtering (before `offset`/`limit` paging). */
  total: number;
  offset: number;
  limit: number;
  /** More candidate pages matched than Folio evaluates (BASE_SCAN_CAP): the result covers the first ones by path. */
  truncated: boolean;
  /** Human-readable notes: filters ignored as unsupported, view type fallback, a formula cycle… */
  warnings: string[];
  /** The file could not be read as a base: shown as a readable error page. Everything else is empty then. */
  error?: { message: string; line?: number };
  /** Cards / list options of the view, as written (cardSize, imageFit, markers…). */
  options?: Record<string, unknown>;
}

export interface BaseSourceResponse {
  /** The file's text. */
  source: string;
  /** sha1 of the text; send it back with a write. */
  etag: string;
  /** The parse (null when the file is not a valid base). */
  config: BaseConfig | null;
  error?: { message: string; line?: number };
  /** The caller may edit the base file (editor+ on the base page, a token that may write). */
  canEdit: boolean;
}

/** PUT /api/pages/:id/base: either the edited config (written back preserving what it does not change) or raw text. */
export interface BaseWriteBody {
  etag: string;
  config?: BaseConfig;
  source?: string;
}

export interface BasePreviewBody {
  /** The YAML (a ```base block's body, or a draft). */
  source: string;
  /** The page `this` means (the embedding document, or the base page itself for a draft). */
  pageId?: string;
  view?: string;
  offset?: number;
  limit?: number;
}

/** Candidate pages evaluated per query at most (after the SQL prefilter, by path). */
export const BASE_SCAN_CAP = 5000;
/** Rows per response page. */
export const BASE_DEFAULT_LIMIT = 200;
export const BASE_MAX_LIMIT = 1000;
/** A `.base` file larger than this is refused with a readable error. */
export const BASE_MAX_BYTES = 256 * 1024;
