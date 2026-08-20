'use client';

import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { cn } from './button';

export interface DataTableColumn {
  /** Storage key on the row. Comes from a FieldDefinition, never from code. */
  key: string;
  label: string;
  /** Feeds both the colgroup and the sticky offset of a pinned column. */
  width?: number;
  pinned?: 'left' | 'right';
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
}: DataTableProps<T>) {
  const offsets = stickyOffsets(columns);
  const totalWidth = columns.reduce((sum, c) => sum + (c.width ?? DEFAULT_COLUMN_WIDTH), 0);
  const clickable = onRowClick !== undefined;

  const isEmpty = !loading && rows.length === 0;

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
          {columns.map((col) => (
            <col key={col.key} style={{ width: col.width ?? DEFAULT_COLUMN_WIDTH }} />
          ))}
        </colgroup>

        <thead>
          <tr>
            {columns.map((col, i) => (
              <th
                key={col.key}
                scope="col"
                style={stickyStyle(offsets[i], col.pinned)}
                className={cn(
                  'sticky top-0 h-11 border-b border-border bg-background px-3 ' +
                    'text-xs font-medium text-body',
                  // A pinned header is sticky on both axes and has to sit above
                  // the plain header cells it slides underneath.
                  col.pinned ? 'z-30' : 'z-20',
                )}
              >
                <span className="block truncate" title={col.label}>
                  {col.label}
                </span>
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {loading || rows.length === 0 ? null : (
            // TODO(record engine): virtualisation attaches here —
            // @tanstack/react-virtual over `rows`, feeding a windowed slice
            // into this map with spacer rows above and below. Row height is
            // fixed at h-12 precisely so the size estimator is exact, and the
            // sticky header and pinned columns are unaffected by windowing.
            rows.map((row) => (
              <tr
                key={rowKey(row)}
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
            ))
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
