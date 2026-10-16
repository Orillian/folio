import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, ChevronRight, Sigma } from 'lucide-react';
import type { PropertyType } from '@shared/contracts';
import type { BaseCell, BaseColumn, BaseQueryResponse, BaseRow } from '@shared/bases/types';
import { cellText, columnLabel, editText, editorFor, layOut, parseEdit, type CellEditor } from './model';
import './i18n/register';

/** How a page link inside a base is opened: the app route by default; a share / public surface passes its own. */
export type PageHref = (pageId: string) => string;

export interface BaseResultsProps {
  response: BaseQueryResponse;
  space: string;
  pageHref: PageHref;
  /** Cells of editable rows/columns become editors. */
  editing?: boolean;
  /** Space types by key (the editor of a cell). */
  types?: Record<string, PropertyType>;
  /** Commits one cell; resolves when written (the caller refreshes). Rejects with a message to show. */
  onCommit?: (row: BaseRow, column: BaseColumn, value: unknown) => Promise<void>;
  /** A compact rendering (an embedded block). */
  compact?: boolean;
  /** Page links as plain anchors instead of router links (outside the app's router). */
  plainLinks?: boolean;
}

// ---------------------------------------------------------------------------
// cells
// ---------------------------------------------------------------------------

export function CellView({ cell, pageHref, plain }: { cell: BaseCell | undefined; pageHref: PageHref; plain?: boolean }): ReactNode {
  const { t } = useTranslation('bases');
  if (cell === null || cell === undefined) return null;
  switch (cell.t) {
    case 'link':
      if (cell.url) {
        return (
          <a href={cell.url} target="_blank" rel="noopener noreferrer nofollow" className="text-blue-600 hover:underline dark:text-blue-400">
            {cell.v}
          </a>
        );
      }
      if (cell.pageId) {
        if (plain) {
          return (
            <a href={pageHref(cell.pageId)} className="text-blue-600 hover:underline dark:text-blue-400">
              {cell.v}
            </a>
          );
        }
        return (
          <Link to={pageHref(cell.pageId)} className="text-blue-600 hover:underline dark:text-blue-400">
            {cell.v}
          </Link>
        );
      }
      return <span className="text-neutral-500 dark:text-neutral-400" title={t('cell.unresolved')}>{cell.v}</span>;
    case 'list':
      return (
        <span className="flex flex-wrap gap-1">
          {cell.v.map((item, i) => (
            <span key={i} className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs dark:bg-neutral-800">
              {item && item.t === 'link' ? <CellView cell={item} pageHref={pageHref} plain={plain} /> : cellText(item)}
            </span>
          ))}
        </span>
      );
    case 'bool':
      return <input type="checkbox" checked={cell.v} readOnly disabled aria-label={cell.v ? t('cell.checked') : t('cell.unchecked')} className="h-3.5 w-3.5 accent-blue-600" />;
    case 'error':
      return (
        <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400" title={cell.v}>
          <AlertTriangle size={12} aria-hidden="true" />
          {t('cell.error')}
        </span>
      );
    case 'unsupported':
      return (
        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" title={t('cell.unsupportedHint', { fn: cell.v })}>
          {t('cell.unsupported')}
        </span>
      );
    case 'number':
      return <span className="tabular-nums">{cellText(cell)}</span>;
    default:
      return <span>{cellText(cell)}</span>;
  }
}

function EditableCell({
  row,
  column,
  types,
  pageHref,
  onCommit,
}: {
  row: BaseRow;
  column: BaseColumn;
  types?: Record<string, PropertyType>;
  pageHref: PageHref;
  onCommit: NonNullable<BaseResultsProps['onCommit']>;
}) {
  const { t } = useTranslation('bases');
  const cell = row.cells[column.id];
  const editor: CellEditor = editorFor(cell, column.key ? types?.[column.key] : undefined);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  const committing = useRef(false);
  const initial = useRef('');
  const commit = async (value: unknown) => {
    if (committing.current) return;
    committing.current = true;
    setBusy(true);
    setError(null);
    try {
      await onCommit(row, column, value);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      committing.current = false;
      setBusy(false);
    }
  };
  /** Enter / blur: write only what changed. */
  const finish = () => {
    if (text === initial.current) setOpen(false);
    else void commit(parseEdit(text, editor));
  };

  if (editor === 'checkbox') {
    const checked = cell?.t === 'bool' ? cell.v : false;
    return (
      <span className="inline-flex items-center gap-1">
        <input
          type="checkbox"
          checked={checked}
          disabled={busy}
          aria-label={t('cell.toggle', { name: columnLabel(column, t) })}
          onChange={() => void commit(!checked)}
          className="h-3.5 w-3.5 cursor-pointer accent-blue-600"
        />
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="folio-base-editable block min-h-[1.5rem] w-full rounded px-1 text-left hover:bg-blue-50 focus-visible:outline focus-visible:outline-1 focus-visible:outline-blue-500 dark:hover:bg-blue-950/40"
        title={t('cell.editHint')}
        onClick={() => {
          initial.current = editText(cell, editor);
          setText(initial.current);
          setError(null);
          setOpen(true);
        }}
      >
        {cell === null || cell === undefined ? <span className="text-neutral-300 dark:text-neutral-600">—</span> : <CellView cell={cell} pageHref={pageHref} />}
        {error && <span className="block text-xs text-red-600 dark:text-red-400">{error}</span>}
      </button>
    );
  }
  const inputType = editor === 'number' ? 'text' : editor === 'date' ? 'date' : editor === 'datetime' ? 'datetime-local' : 'text';
  return (
    <span className="block">
      <input
        ref={inputRef}
        type={inputType}
        inputMode={editor === 'number' ? 'decimal' : undefined}
        value={text}
        disabled={busy}
        aria-label={columnLabel(column, t)}
        placeholder={editor === 'list' ? t('cell.listPlaceholder') : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish();
          if (e.key === 'Escape') {
            committing.current = true; // the blur that follows must not write
            setOpen(false);
            queueMicrotask(() => (committing.current = false));
          }
        }}
        onBlur={finish}
        className="w-full min-w-[6rem] rounded border border-blue-400 bg-white px-1 py-0.5 text-sm outline-none dark:border-blue-500 dark:bg-neutral-900"
      />
      {error && <span className="block text-xs text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}

const PlainLinks = createContext(false);

function Cell(props: { row: BaseRow; column: BaseColumn } & Pick<BaseResultsProps, 'editing' | 'types' | 'onCommit' | 'pageHref'>) {
  const { row, column, editing, onCommit, pageHref } = props;
  const plain = useContext(PlainLinks);
  if (editing && onCommit && column.editable && row.canEdit) return <EditableCell row={row} column={column} types={props.types} pageHref={pageHref} onCommit={onCommit} />;
  return <CellView cell={row.cells[column.id]} pageHref={pageHref} plain={plain} />;
}

function HeaderLabel({ column }: { column: BaseColumn }) {
  const { t } = useTranslation('bases');
  return (
    <span className="inline-flex items-center gap-1">
      {column.source === 'formula' && <Sigma size={12} className="opacity-50" aria-hidden="true" />}
      <span>{columnLabel(column, t)}</span>
      {column.unsupported && (
        <span className="rounded bg-amber-50 px-1 text-[10px] font-normal text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" title={column.unsupported}>
          {t('cell.formulaUnsupported')}
        </span>
      )}
    </span>
  );
}

function SummaryText({ name, value, pageHref }: { name: string; value: BaseCell; pageHref: PageHref }) {
  const { t } = useTranslation('bases');
  const known = ['Average', 'Min', 'Max', 'Sum', 'Range', 'Median', 'Stddev', 'Earliest', 'Latest', 'Checked', 'Unchecked', 'Empty', 'Filled', 'Unique'];
  const label = known.includes(name) ? t(`summary.${name}`) : name;
  return (
    <span className="inline-flex items-baseline gap-1 text-xs text-neutral-500 dark:text-neutral-400">
      <span>{label}</span>
      <span className="font-medium text-neutral-700 dark:text-neutral-200">
        <CellView cell={value} pageHref={pageHref} />
      </span>
    </span>
  );
}

function GroupLabel({ cell, pageHref }: { cell: BaseCell; pageHref: PageHref }) {
  const { t } = useTranslation('bases');
  if (cell === null) return <span className="italic text-neutral-500 dark:text-neutral-400">{t('group.none')}</span>;
  return <CellView cell={cell} pageHref={pageHref} />;
}

// ---------------------------------------------------------------------------
// layouts
// ---------------------------------------------------------------------------

function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return { collapsed, toggle };
}

function GroupToggle({ index, count, cell, collapsed, onToggle, pageHref, children }: { index: number; count: number; cell: BaseCell; collapsed: boolean; onToggle: (i: number) => void; pageHref: PageHref; children?: ReactNode }) {
  const { t } = useTranslation('bases');
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        onClick={() => onToggle(index)}
        aria-expanded={!collapsed}
        className="inline-flex items-center gap-1 font-medium text-neutral-800 dark:text-neutral-100"
      >
        {collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        <GroupLabel cell={cell} pageHref={pageHref} />
      </button>
      <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('group.count', { count })}</span>
      {children}
    </div>
  );
}

function TableLayout(props: BaseResultsProps) {
  const { response, pageHref } = props;
  const { t } = useTranslation('bases');
  const { collapsed, toggle } = useCollapsed();
  const items = layOut(response, collapsed);
  const hasSummary = response.columns.some((c) => c.summary);
  return (
    <div className="folio-base-table overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-700">
      <table className="w-full min-w-max border-collapse text-sm">
        <thead className="bg-neutral-50 text-left text-xs font-medium text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300">
          <tr>
            {response.columns.map((c) => (
              <th key={c.id} scope="col" className="whitespace-nowrap border-b border-neutral-200 px-3 py-2 dark:border-neutral-700">
                <HeaderLabel column={c} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) =>
            item.kind === 'group' ? (
              <tr key={`g${item.index}`} className="bg-neutral-50/70 dark:bg-neutral-800/30">
                <td colSpan={response.columns.length} className="border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-700">
                  <GroupToggle index={item.index} count={item.group.count} cell={item.group.key} collapsed={collapsed.has(item.index)} onToggle={toggle} pageHref={pageHref}>
                    {item.group.summaries &&
                      Object.entries(item.group.summaries).map(([colId, value]) => {
                        const col = response.columns.find((c) => c.id === colId);
                        return col?.summary ? (
                          <span key={colId} className="text-xs text-neutral-500 dark:text-neutral-400">
                            {columnLabel(col, t)}: <SummaryText name={col.summary.name} value={value} pageHref={pageHref} />
                          </span>
                        ) : null;
                      })}
                  </GroupToggle>
                </td>
              </tr>
            ) : (
              <tr key={item.row.id} className="border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50/60 dark:border-neutral-800 dark:hover:bg-neutral-800/30">
                {response.columns.map((c) => (
                  <td key={c.id} className="max-w-[28rem] px-3 py-1.5 align-top">
                    <Cell row={item.row} column={c} editing={props.editing} types={props.types} onCommit={props.onCommit} pageHref={pageHref} />
                  </td>
                ))}
              </tr>
            ),
          )}
          {items.length === 0 && (
            <tr>
              <td colSpan={Math.max(1, response.columns.length)} className="px-3 py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
                {t('empty')}
              </td>
            </tr>
          )}
        </tbody>
        {hasSummary && (
          <tfoot className="bg-neutral-50 dark:bg-neutral-800/60">
            <tr>
              {response.columns.map((c) => (
                <td key={c.id} className="border-t border-neutral-200 px-3 py-1.5 dark:border-neutral-700">
                  {c.summary && <SummaryText name={c.summary.name} value={c.summary.value} pageHref={pageHref} />}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function CardsLayout(props: BaseResultsProps) {
  const { response, pageHref } = props;
  const { t } = useTranslation('bases');
  const { collapsed, toggle } = useCollapsed();
  const items = layOut(response, collapsed);
  const [titleCol, ...fields] = response.columns;
  const aspect = typeof response.options?.imageAspectRatio === 'number' ? (response.options.imageAspectRatio as number) : 0.5;
  const fit = response.options?.imageFit === 'contain' ? 'contain' : 'cover';
  const cardSize = typeof response.options?.cardSize === 'number' ? Math.min(400, Math.max(140, response.options.cardSize as number)) : 220;
  const sections: Array<{ header?: ReactNode; rows: BaseRow[] }> = [];
  for (const item of items) {
    if (item.kind === 'group') {
      sections.push({
        header: <GroupToggle index={item.index} count={item.group.count} cell={item.group.key} collapsed={collapsed.has(item.index)} onToggle={toggle} pageHref={pageHref} />,
        rows: [],
      });
    } else {
      if (sections.length === 0) sections.push({ rows: [] });
      sections[sections.length - 1].rows.push(item.row);
    }
  }
  if (items.length === 0) return <p className="py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">{t('empty')}</p>;
  return (
    <div className="space-y-4">
      {sections.map((section, si) => (
        <section key={si} className="space-y-2">
          {section.header}
          {section.rows.length > 0 && (
            <ul className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${cardSize}px), 1fr))` }}>
              {section.rows.map((row) => (
                <li key={row.id} className="folio-base-card overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
                  {row.cover &&
                    (row.cover.startsWith('#') ? (
                      <div style={{ background: row.cover, aspectRatio: String(1 / aspect) }} aria-hidden="true" />
                    ) : (
                      <img src={row.cover} alt="" loading="lazy" className="w-full bg-neutral-100 dark:bg-neutral-800" style={{ aspectRatio: String(1 / aspect), objectFit: fit }} />
                    ))}
                  <div className="space-y-1.5 p-3">
                    <div className="font-medium text-neutral-900 dark:text-neutral-100">
                      {titleCol ? <Cell row={row} column={titleCol} editing={props.editing} types={props.types} onCommit={props.onCommit} pageHref={pageHref} /> : row.title}
                    </div>
                    {fields.length > 0 && (
                      <dl className="space-y-1 text-sm">
                        {fields.map((c) => (
                          <div key={c.id} className="flex gap-2">
                            <dt className="w-24 shrink-0 truncate text-xs text-neutral-500 dark:text-neutral-400">{columnLabel(c, t)}</dt>
                            <dd className="min-w-0 flex-1 break-words">
                              <Cell row={row} column={c} editing={props.editing} types={props.types} onCommit={props.onCommit} pageHref={pageHref} />
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function ListLayout(props: BaseResultsProps) {
  const { response, pageHref } = props;
  const { t } = useTranslation('bases');
  const { collapsed, toggle } = useCollapsed();
  const items = layOut(response, collapsed);
  const [primary, ...rest] = response.columns;
  const markers = response.options?.markers === 'number' ? 'number' : response.options?.markers === 'none' ? 'none' : 'bullet';
  const ListTag = markers === 'number' ? 'ol' : 'ul';
  const listClass = markers === 'number' ? 'list-decimal pl-6' : markers === 'none' ? 'list-none pl-0' : 'list-disc pl-6';
  if (items.length === 0) return <p className="py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">{t('empty')}</p>;
  const blocks: Array<{ header?: ReactNode; rows: BaseRow[] }> = [];
  for (const item of items) {
    if (item.kind === 'group') blocks.push({ header: <GroupToggle index={item.index} count={item.group.count} cell={item.group.key} collapsed={collapsed.has(item.index)} onToggle={toggle} pageHref={pageHref} />, rows: [] });
    else {
      if (blocks.length === 0) blocks.push({ rows: [] });
      blocks[blocks.length - 1].rows.push(item.row);
    }
  }
  return (
    <div className="space-y-3">
      {blocks.map((b, i) => (
        <div key={i} className="space-y-1">
          {b.header}
          {b.rows.length > 0 && (
            <ListTag className={`${listClass} space-y-1 text-sm`}>
              {b.rows.map((row) => (
                <li key={row.id}>
                  <span className="font-medium">{primary ? <Cell row={row} column={primary} editing={props.editing} types={props.types} onCommit={props.onCommit} pageHref={pageHref} /> : row.title}</span>
                  {rest.map((c) => (
                    <span key={c.id} className="text-neutral-600 dark:text-neutral-300">
                      <span className="px-1.5 text-neutral-300 dark:text-neutral-600" aria-hidden="true">
                        ·
                      </span>
                      <span className="sr-only">{columnLabel(c, t)}: </span>
                      <span className="inline-block align-top">
                        <Cell row={row} column={c} editing={props.editing} types={props.types} onCommit={props.onCommit} pageHref={pageHref} />
                      </span>
                    </span>
                  ))}
                </li>
              ))}
            </ListTag>
          )}
        </div>
      ))}
    </div>
  );
}

export function BaseResults(props: BaseResultsProps) {
  const layout = props.response.layout === 'cards' ? <CardsLayout {...props} /> : props.response.layout === 'list' ? <ListLayout {...props} /> : <TableLayout {...props} />;
  return <PlainLinks.Provider value={props.plainLinks === true}>{layout}</PlainLinks.Provider>;
}
