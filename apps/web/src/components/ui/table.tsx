'use client';

import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './button';
import { Checkbox } from './input';

export interface DataTableColumn {
  /** Storage key on the row. Comes from a FieldDefinition, never from code. */
  key: string;
  label: string;
  /** Feeds both the colgroup and the sticky offset of a pinned column. */
  width?: number;
  pinned?: 'left' | 'right';
}

/**
 * Row selection — OPT-IN, and deliberately not a boolean flag.
 *
 * A table with a selection column and nowhere to put the selection is a
 * checkbox that does nothing, so the caller has to hand over the state and
 * both toggles to get the column at all. Every other table in the product
 * omits this prop and is untouched by it.
 *
 * The selection is a set of row KEYS (whatever `rowKey` returns), never row
 * objects: the rows array is replaced on every page, sort and filter, and an
 * object identity would stop matching the moment it did.
 */
export interface DataTableSelection {
  /** Ticked row keys. A Set, so a 200-row page costs one lookup per row. */
  selected: ReadonlySet<string>;
  onToggle: (key: string, checked: boolean) => void;
  /** The header box: every row ON THIS PAGE, which is all this table can see. */
  onToggleAll: (checked: boolean) => void;
  /**
   * Accessible name for each row's box — "Select lead", composed by the caller
   * from `ModuleDefinition.label`. A column of boxes all announcing "checkbox"
   * is unusable with a screen reader, and this primitive may not know what a
   * row IS.
   */
  label: string;
}

/** The selection column's width. Sized to the 20px box plus the 12px cell
 *  padding either side — it is a handle, not a column of content. */
const SELECTION_WIDTH = 44;

export interface DataTableProps<T extends Record<string, unknown> = Record<string, unknown>> {
  columns: DataTableColumn[];
  rows: T[];
  rowKey: (row: T) => string;
  renderCell?: (column: DataTableColumn, row: T) => ReactNode;
  onRowClick?: (row: T) => void;
  /** `module.screen`; rows emit `${trackPrefix}.row.open`. */
  trackPrefix: string;
  emptyMessage?: string;
  loading?: boolean;
  /** The column the rows are ordered by, when the caller orders them. */
  sort?: { key: string; direction: 'asc' | 'desc' };
  /**
   * Makes the headers sortable. Called with the column key that was activated;
   * the caller decides what that means — usually "sort by this, ascending, or
   * flip the direction if it already is". Omitted, the headers stay plain
   * text, because a header that looks clickable and is not is worse than one
   * that does not.
   */
  onSortColumn?: (key: string) => void;
  /** Draws a leading checkbox column. Omitted, there is no selection column. */
  selection?: DataTableSelection;
}

/**
 * A pinned column needs a known width to know where the next one starts. When
 * a caller omits it, guessing one keeps the pinned columns from stacking on
 * top of each other — silently overlapping cells are worse than a column that
 * is 20px off.
 */
const DEFAULT_COLUMN_WIDTH = 160;

/**
 * Cumulative sticky offsets: the second pinned-left column begins where the
 * first one ends, and the same from the right. In the single-pin case the
 * reference screen uses (title left, actions right) both offsets are 0, which
 * is exact regardless of how the browser distributes leftover width.
 */
function stickyOffsets(columns: DataTableColumn[], base: number): (number | undefined)[] {
  const offsets: (number | undefined)[] = columns.map(() => undefined);

  // `base` is the selection column, which is pinned left ahead of everything
  // else. Without it the first pinned data column would sit UNDER the
  // checkboxes while scrolling sideways.
  let left = base;
  for (let i = 0; i < columns.length; i += 1) {
    const col = columns[i];
    if (!col || col.pinned !== 'left') continue;
    offsets[i] = left;
    left += col.width ?? DEFAULT_COLUMN_WIDTH;
  }

  let right = 0;
  for (let i = columns.length - 1; i >= 0; i -= 1) {
    const col = columns[i];
    if (!col || col.pinned !== 'right') continue;
    offsets[i] = right;
    right += col.width ?? DEFAULT_COLUMN_WIDTH;
  }

  return offsets;
}

function stickyStyle(
  offset: number | undefined,
  pinned: DataTableColumn['pinned'],
): CSSProperties | undefined {
  if (offset === undefined || pinned === undefined) return undefined;
  return pinned === 'left' ? { left: offset } : { right: offset };
}

/**
 * Values arrive as `unknown` — a record engine cannot know what a module's
 * fields hold. Primitives render; anything richer is the caller's job through
 * `renderCell`. Dates go out as ISO rather than a locale format because a
 * locale format renders differently on the server and the client and shows up
 * as a hydration mismatch.
 */
function defaultCell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return '—';
}

/** Only primitives get a tooltip; a custom cell's text is not ours to guess. */
function cellTitle(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function activateOnKey(e: KeyboardEvent<HTMLTableRowElement>) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  // Space would otherwise scroll the list out from under the focused row.
  e.preventDefault();
  // `.click()` dispatches a REAL click event, so the keyboard path travels
  // through the same delegated interaction logger as the pointer path — one
  // gesture, one InteractionLog row. Calling onRowClick directly here would
  // open the record and log nothing.
  e.currentTarget.click();
}

/**
 * The one table in this product. It knows nothing about any module: columns
 * are FieldDefinition rows, values are opaque, and the only thing it can do
 * with a row is hand it back to the caller.
 *
 * Vertical stickiness assumes the caller bounds the height of this component
 * (the scroll container is the div below); an unbounded parent simply means
 * the header never has anything to stick to.
 */
export function DataTable<T extends Record<string, unknown>>({
  columns,
  rows,
  rowKey,
  renderCell,
  onRowClick,
  trackPrefix,
  emptyMessage = 'No records match this view.',
  loading = false,
  sort,
  onSortColumn,
  selection,
}: DataTableProps<T>) {
  const selectionWidth = selection ? SELECTION_WIDTH : 0;
  const offsets = stickyOffsets(columns, selectionWidth);
  const totalWidth =
    columns.reduce((sum, c) => sum + (c.width ?? DEFAULT_COLUMN_WIDTH), 0) + selectionWidth;
  const clickable = onRowClick !== undefined;

  const isEmpty = !loading && rows.length === 0;

  // Selected on THIS PAGE. The set may hold more than the page shows in some
  // future caller, so the header box answers for what is on screen and nothing
  // else — a "select all" that silently meant 40,000 rows would be a bulk
  // action nobody could review before running it.
  const pageKeys = selection ? rows.map(rowKey) : [];
  const selectedOnPage = selection
    ? pageKeys.filter((key) => selection.selected.has(key)).length
    : 0;
  const allSelected = selection !== undefined && pageKeys.length > 0 && selectedOnPage === pageKeys.length;
  const someSelected = selectedOnPage > 0 && !allSelected;

  const headerBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // `indeterminate` is a DOM property with no HTML attribute, so React
    // cannot set it from props — a partial selection would otherwise read as
    // "none selected", which is the state the box would move TO on a click.
    const el = headerBox.current;
    if (el) el.indeterminate = someSelected;
  }, [someSelected]);

  return (
    <div className="w-full">
      <div className="w-full overflow-auto">
      <table
        className="w-full table-fixed border-collapse text-left"
        // minWidth, not width: the table fills a wide panel but refuses to
        // squeeze 19 Leads columns into 910px — it scrolls instead.
        style={{ minWidth: totalWidth }}
        aria-busy={loading || undefined}
      >
        <colgroup>
          {selection ? <col style={{ width: SELECTION_WIDTH }} /> : null}
          {columns.map((col) => (
            <col key={col.key} style={{ width: col.width ?? DEFAULT_COLUMN_WIDTH }} />
          ))}
        </colgroup>

        <thead>
          <tr>
            {selection ? (
              <th
                scope="col"
                style={{ left: 0 }}
                className="sticky top-0 z-30 h-11 border-b border-border bg-background px-3"
              >
                <Checkbox
                  ref={headerBox}
                  checked={allSelected}
                  disabled={pageKeys.length === 0}
                  onChange={(e) => selection.onToggleAll(e.target.checked)}
                  data-track={`${trackPrefix}.rows.selectall`}
                  // The name is visually hidden: the column is 44px wide and a
                  // visible caption would either wrap or truncate to nothing,
                  // but a bare box announces only "checkbox" to a reader.
                  label={<span className="sr-only">Select every row on this page</span>}
                />
              </th>
            ) : null}
            {columns.map((col, i) => {
              const sorted = sort?.key === col.key ? sort.direction : undefined;
              return (
                <th
                  key={col.key}
                  scope="col"
                  // aria-sort is what tells a screen reader the table is
                  // ordered and which way — the arrow below is only for eyes.
                  aria-sort={
                    sorted === undefined ? undefined : sorted === 'asc' ? 'ascending' : 'descending'
                  }
                  style={stickyStyle(offsets[i], col.pinned)}
                  className={cn(
                    'sticky top-0 h-11 border-b border-border bg-background px-3 ' +
                      'text-xs font-medium text-body',
                    // A pinned header is sticky on both axes and has to sit above
                    // the plain header cells it slides underneath.
                    col.pinned ? 'z-30' : 'z-20',
                  )}
                >
                  {onSortColumn ? (
                    <button
                      type="button"
                      onClick={() => onSortColumn(col.key)}
                      data-track={`${trackPrefix}.column.sort`}
                      className={cn(
                        'flex w-full items-center gap-1 text-left focus-visible:outline-none ' +
                          'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
                        sorted === undefined ? 'hover:text-heading' : 'text-heading',
                      )}
                    >
                      <span className="block truncate" title={col.label}>
                        {col.label}
                      </span>
                      {/* aria-hidden: aria-sort on the header already says it. */}
                      <span aria-hidden="true" className="shrink-0">
                        {sorted === undefined ? '' : sorted === 'asc' ? '\u2191' : '\u2193'}
                      </span>
                    </button>
                  ) : (
                    <span className="block truncate" title={col.label}>
                      {col.label}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {loading || rows.length === 0 ? null : (
            // TODO(record engine): virtualisation attaches here —
            // @tanstack/react-virtual over `rows`, feeding a windowed slice
            // into this map with spacer rows above and below. Row height is
            // fixed at h-12 precisely so the size estimator is exact, and the
            // sticky header and pinned columns are unaffected by windowing.
            rows.map((row) => {
              const key = rowKey(row);
              return (
              <tr
                key={key}
                className={cn(
                  'group',
                  clickable &&
                    'cursor-pointer hover:bg-background focus-visible:outline-none ' +
                      'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
                )}
                onClick={clickable ? () => onRowClick(row) : undefined}
                onKeyDown={clickable ? activateOnKey : undefined}
                tabIndex={clickable ? 0 : undefined}
                data-track={clickable ? `${trackPrefix}.row.open` : undefined}
              >
                {selection ? (
                  <td
                    style={{ left: 0 }}
                    className={
                      'sticky z-10 h-12 border-b border-border bg-surface px-3 ' +
                      'group-hover:bg-background'
                    }
                  >
                    {/* Both events stop here. A click would otherwise bubble to
                        the row and OPEN the record the user was ticking, and
                        Space would be swallowed by the row's own key handler
                        and open it too. The interaction logger is unaffected:
                        it listens on the capture phase. */}
                    <span
                      className="flex"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={selection.selected.has(key)}
                        onChange={(e) => selection.onToggle(key, e.target.checked)}
                        data-track={`${trackPrefix}.row.select`}
                        label={<span className="sr-only">{selection.label}</span>}
                      />
                    </span>
                  </td>
                ) : null}
                {columns.map((col, i) => (
                  <td
                    key={col.key}
                    style={stickyStyle(offsets[i], col.pinned)}
                    className={cn(
                      'h-12 border-b border-border px-3 text-sm text-body',
                      // The opaque background is load-bearing, not decoration:
                      // without it the scrolling columns show through the
                      // pinned one. group-hover keeps the pinned cell in step
                      // with the row it belongs to.
                      col.pinned && 'sticky z-10 bg-surface group-hover:bg-background',
                    )}
                  >
                    {/* Truncate with a tooltip, never wrap — an Admin-created
                        field label or value has no length limit, and one long
                        value would otherwise set the height of every row. */}
                    <span className="block truncate" title={cellTitle(row[col.key])}>
                      {renderCell ? renderCell(col, row) : defaultCell(row[col.key])}
                    </span>
                  </td>
                ))}
              </tr>
              );
            })
          )}
        </tbody>
      </table>
      </div>

      {/* OUTSIDE the scroll port on purpose. A colSpan cell is as wide as every
          column combined, so a centred message inside the table sits halfway
          along the scrollable width — off-screen exactly when a module has
          enough fields to overflow. Here it is always in view, and the header
          above it keeps the column widths from jumping when rows arrive. */}
      {loading ? (
        <p className="flex h-24 items-center justify-center text-sm text-body">Loading…</p>
      ) : isEmpty ? (
        <p className="flex h-24 items-center justify-center text-sm text-body">{emptyMessage}</p>
      ) : null}
    </div>
  );
}
