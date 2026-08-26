'use client';

import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Avatar } from './avatar';
import { cn } from './button';
import { Checkbox } from './input';

export interface DataTableColumn {
  /** Storage key on the row. Comes from a FieldDefinition, never from code. */
  key: string;
  label: string;
  /** Feeds both the colgroup and the sticky offset of a pinned column. */
  width?: number;
  pinned?: 'left' | 'right';
  /**
   * Draws the sort caret in this header. DEFAULTS TO TRUE when the table has a
   * sort handler, because that is what the file draws — every one of the ten
   * `Table / Base / Header` cells in the `CRM _ Leads` frame carries an
   * `Icon/CaretDoubleVertical`. Set `false` to opt a column out (a computed
   * column the repository cannot order by). Making it opt-IN instead would
   * silently un-sort the two screens already passing plain FieldDefinition
   * columns.
   */
  sortable?: boolean;
  /** Same rule as `sortable`, for the header's `oui:filter` funnel. */
  filterable?: boolean;
  /**
   * Key on the ROW holding this cell's picture. The file's first column is
   * `[checkbox][Display Picture 24x24][text]`; every other column hides that
   * slot. So it is per-column config, never "column 0 gets an avatar".
   */
  avatarKey?: string;
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
  onSort?: (key: string) => void;
  /**
   * The same handler under its original name. Two screens already pass
   * `onSortColumn`; renaming it would have been a silent behaviour change in
   * files this slice does not own, so both spellings resolve to one handler
   * and `onSort` wins if a caller somehow passes both.
   */
  onSortColumn?: (key: string) => void;
  /** Opens this column's filter. Omitted, no funnel is drawn. */
  onFilterColumn?: (key: string) => void;
  /** Draws the leading checkboxes. Omitted, there is no selection at all. */
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
 *
 * There is no separate selection column to offset past any more: the file puts
 * the checkbox INSIDE the first cell (`Table / Base / List`, 200x45,
 * flex-row gap:12 → `[Checkbox 20x20][Content]`), and every other cell's
 * checkbox instance is `visible: false`.
 */
function stickyOffsets(columns: DataTableColumn[]): (number | undefined)[] {
  const offsets: (number | undefined)[] = columns.map(() => undefined);

  let left = 0;
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

/**
 * The picture for this cell, when the column declares one and the row has it.
 * No value means no avatar rather than an initials disc: the file HIDES the
 * `Display Picture` slot when there is nothing to show, and a column of
 * generated monograms would read as data the record does not carry.
 */
function avatarSrcOf(column: DataTableColumn, row: Record<string, unknown>): string | undefined {
  if (column.avatarKey === undefined) return undefined;
  const value = row[column.avatarKey];
  return typeof value === 'string' && value !== '' ? value : undefined;
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
 * `Icon/CaretDoubleVertical`, measured 12x12 in the header. Traced on the 24
 * grid the rest of the app's icons use.
 *
 * The file draws only the neutral double caret — it has no ascending or
 * descending glyph. Dimming the half that does not apply says which way the
 * column is ordered without inventing a second icon; `aria-sort` on the `th`
 * is what actually carries that to a screen reader.
 */
function SortCaret({ direction }: { direction?: 'asc' | 'desc' }) {
  const stroke = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const;
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      <path d="m6 10 6-6 6 6" {...stroke} className={direction === 'desc' ? 'opacity-30' : undefined} />
      <path d="m6 14 6 6 6-6" {...stroke} className={direction === 'asc' ? 'opacity-30' : undefined} />
    </svg>
  );
}

/** `oui:filter`, measured 16x16 in the header. Same funnel path the list
 *  screen's toolbar already traces, so the two never drift apart. */
function FilterFunnel() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      <path
        d="M3 5h18l-7 8v6l-4 2v-8L3 5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The one table in this product. It knows nothing about any module: columns
 * are FieldDefinition rows, values are opaque, and the only thing it can do
 * with a row is hand it back to the caller.
 *
 * Chrome measured off `CRM _ Leads` in `tools/figma/Zoho.fig`:
 *
 *   FRAME "Table / Header"        1688x45  bg:#f6f8fa            → h-[45px] bg-background
 *   FRAME "Table / Base / Header"  200x45  flex-row gap:8 pad:12/12
 *         [Checkbox 20x20 (visible ONLY in column 0)]
 *         [label 14px Regular #111827] [Icon/CaretDoubleVertical 12x12]
 *         [oui:filter 16x16, pushed right]
 *         strokePaints EMPTY — a header cell draws NO vertical rule
 *   FRAME "Rows"                  1688x45  bg:#ffffff  border:#e5e7eb 1px
 *   FRAME "Table / Base /  List"   200x45  flex-row gap:12 pad:10/12
 *         borderLeftWeight:1 borderRightWeight:1 #e5e7eb — and NO top/bottom.
 *         So the file draws a GRID: vertical rules between DATA columns only,
 *         horizontal rules from the row frame. Re-measured off the real
 *         instances inside `CRM _ Leads` (not the component master) on
 *         26 Aug 2026 — the build had horizontal rules alone until then.
 *         [Checkbox 20x20 (column 0 only)]
 *         [Content flex-row gap:8 → Display Picture 24x24 + text]
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
  onSort,
  onSortColumn,
  onFilterColumn,
  selection,
}: DataTableProps<T>) {
  const sortHandler = onSort ?? onSortColumn;
  const offsets = stickyOffsets(columns);
  const totalWidth = columns.reduce((sum, c) => sum + (c.width ?? DEFAULT_COLUMN_WIDTH), 0);
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
    // flex-col + min-h-0: the list panel bounds this component's height, and
    // only a flex child that may shrink below its content lets the scroll port
    // below actually scroll — without it the rows push the pager out of the
    // panel instead. In an unbounded parent the column is content-sized, which
    // is exactly what it was before.
    <div className="flex min-h-0 w-full min-w-0 flex-col">
      {/* The horizontal scrollbar the frame DRAWS: `Frame 482654` 910x20,
          pad 6, r:24, over an 8-tall `Scroll Bar` thumb r:12 in #e5e7eb. It is
          the table's own overflow bar, so it is styled rather than faked — the
          6px inset is a transparent border on the thumb, which is the only way
          to inset a webkit thumb inside its track. */}
      <div
        className={
          // flex-auto, not flex-1: `flex-basis: auto` keeps this the height of
          // its own rows in the screens that drop a DataTable into ordinary
          // flow, while min-h-0 still lets it shrink — and therefore scroll —
          // inside a panel that bounds it.
          'min-h-0 w-full flex-auto overflow-auto ' +
          '[&::-webkit-scrollbar]:h-5 [&::-webkit-scrollbar]:w-5 ' +
          '[&::-webkit-scrollbar-track]:bg-transparent ' +
          '[&::-webkit-scrollbar-thumb]:rounded-[12px] ' +
          '[&::-webkit-scrollbar-thumb]:border-[6px] ' +
          '[&::-webkit-scrollbar-thumb]:border-solid ' +
          '[&::-webkit-scrollbar-thumb]:border-transparent ' +
          '[&::-webkit-scrollbar-thumb]:bg-border ' +
          '[&::-webkit-scrollbar-thumb]:bg-clip-content'
        }
      >
      <table
        className="w-full table-fixed border-collapse text-left"
        // minWidth, not width: the table fills a wide panel but refuses to
        // squeeze 19 Leads columns into 910px — it scrolls instead.
        style={{ minWidth: totalWidth }}
        aria-busy={loading || undefined}
      >
        <colgroup>
          {columns.map((col) => (
            <col key={col.key} style={{ width: col.width ?? DEFAULT_COLUMN_WIDTH }} />
          ))}
        </colgroup>

        <thead>
          <tr>
            {columns.map((col, i) => {
              const sorted = sort?.key === col.key ? sort.direction : undefined;
              // Both default to TRUE once the handler exists — see the column
              // docs above. No handler, no control: a dead affordance is worse
              // than none.
              const showSort = sortHandler !== undefined && col.sortable !== false;
              const showFilter = onFilterColumn !== undefined && col.filterable !== false;
              // The select-all box lives in the first cell, exactly as the file
              // draws it — the other nine header checkboxes are `visible: false`.
              const showSelectAll = selection !== undefined && i === 0;
              return (
                <th
                  key={col.key}
                  scope="col"
                  // aria-sort is what tells a screen reader the table is
                  // ordered and which way — the caret below is only for eyes.
                  aria-sort={
                    sorted === undefined ? undefined : sorted === 'asc' ? 'ascending' : 'descending'
                  }
                  style={stickyStyle(offsets[i], col.pinned)}
                  className={cn(
                    // 45 tall, bg #f6f8fa → background, label 14px Regular
                    // #111827 → heading. pad 12/12 → px-3 (the height is fixed,
                    // so the vertical 12 is centring, not spacing).
                    'sticky top-0 h-[45px] border-b border-border bg-background px-3 ' +
                      'text-sm font-normal text-heading',
                    // A pinned header is sticky on both axes and has to sit above
                    // the plain header cells it slides underneath.
                    col.pinned ? 'z-30' : 'z-20',
                  )}
                >
                  {/* gap:8 between the checkbox and the rest — measured. */}
                  <div className="flex items-center gap-2">
                    {showSelectAll ? (
                      <Checkbox
                        ref={headerBox}
                        checked={allSelected}
                        disabled={pageKeys.length === 0}
                        onChange={(e) => selection.onToggleAll(e.target.checked)}
                        data-track={`${trackPrefix}.rows.selectall`}
                        // The name is visually hidden: the file draws a bare
                        // 20x20 box with no caption, but a bare box announces
                        // only "checkbox" to a reader.
                        label={<span className="sr-only">Select every row on this page</span>}
                      />
                    ) : null}
                    {/* The funnel sits flush right of the cell in the wider
                        columns (the file spaces it with fixed frame widths of
                        36/164/58…, which is space-between by another name). */}
                    <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                      {showSort ? (
                        <button
                          type="button"
                          onClick={() => sortHandler(col.key)}
                          data-track={`${trackPrefix}.column.sort`}
                          className={cn(
                            'flex min-w-0 items-center gap-2 text-left focus-visible:outline-none ' +
                              'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
                            sorted === undefined ? 'hover:text-body' : 'text-heading',
                          )}
                        >
                          <span className="block truncate" title={col.label}>
                            {col.label}
                          </span>
                          <SortCaret {...(sorted ? { direction: sorted } : {})} />
                        </button>
                      ) : (
                        <span className="block min-w-0 truncate" title={col.label}>
                          {col.label}
                        </span>
                      )}
                      {showFilter ? (
                        <button
                          type="button"
                          onClick={() => onFilterColumn(col.key)}
                          // Icon-only, so it needs its own name; the column
                          // label is Admin-authored and is the only thing that
                          // distinguishes one funnel from the next.
                          aria-label={`Filter by ${col.label}`}
                          data-track={`${trackPrefix}.column.filter`}
                          className={
                            'flex shrink-0 items-center text-heading hover:text-body ' +
                            'focus-visible:outline-none focus-visible:ring-2 ' +
                            'focus-visible:ring-inset focus-visible:ring-primary'
                          }
                        >
                          <FilterFunnel />
                        </button>
                      ) : null}
                    </div>
                  </div>
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
            // fixed at the measured 45 precisely so the size estimator is
            // exact, and the sticky header and pinned columns are unaffected
            // by windowing.
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
                {columns.map((col, i) => {
                  const avatarSrc = avatarSrcOf(col, row);
                  const showBox = selection !== undefined && i === 0;
                  return (
                  <td
                    key={col.key}
                    style={stickyStyle(offsets[i], col.pinned)}
                    className={cn(
                      // 45 tall, 1px #e5e7eb between rows, pad 10/12 → px-3.
                      // border-r is the file's per-cell left+right rule: every
                      // `Table / Base /  List` carries borderLeftWeight and
                      // borderRightWeight 1 in #e5e7eb and no top/bottom, which
                      // collapses to one vertical line per column boundary.
                      // Header cells deliberately do NOT get one — their
                      // strokePaints array is empty.
                      'h-[45px] border-b border-r border-border px-3 text-sm',
                      // The file paints the first column's text #111827 and
                      // every later column #6b7280 — the title column reads as
                      // the record's identity. `renderCell` can still override.
                      i === 0 ? 'text-heading' : 'text-body',
                      // The opaque background is load-bearing, not decoration:
                      // without it the scrolling columns show through the
                      // pinned one. group-hover keeps the pinned cell in step
                      // with the row it belongs to.
                      col.pinned && 'sticky z-10 bg-surface group-hover:bg-background',
                    )}
                  >
                    {/* gap:12 between the checkbox and the content — measured. */}
                    <div className="flex items-center gap-3">
                      {showBox ? (
                        /* Both events stop here. A click would otherwise bubble
                           to the row and OPEN the record the user was ticking,
                           and Space would be swallowed by the row's own key
                           handler and open it too. The interaction logger is
                           unaffected: it listens on the capture phase. */
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
                      ) : null}
                      {/* "Content", gap:8 — the 24x24 Display Picture then the
                          value. */}
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        {avatarSrc !== undefined ? (
                          <Avatar src={avatarSrc} name={cellTitle(row[col.key]) ?? ''} size={24} />
                        ) : null}
                        {/* Truncate with a tooltip, never wrap — an
                            Admin-created field label or value has no length
                            limit, and one long value would otherwise set the
                            height of every row. */}
                        <span className="block min-w-0 truncate" title={cellTitle(row[col.key])}>
                          {renderCell ? renderCell(col, row) : defaultCell(row[col.key])}
                        </span>
                      </div>
                    </div>
                  </td>
                  );
                })}
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
