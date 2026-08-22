'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { DataTable, type DataTableColumn, type DataTableSelection } from '@/components/ui';
import { DEMO_AVATAR_ROW_KEY, demoAvatarFor } from '@/components/demo-avatar';
import { renderFieldCell, type CellField, type StatusOption } from './cell';

/**
 * The list table. It is handed columns, fields, statuses and rows and has no
 * idea which module produced them — the whole screen works this way, which is
 * why there is exactly one of it rather than one per module.
 *
 * This is a client component only because `DataTable` takes functions:
 * `renderCell` and `onRowClick` cannot cross the RSC boundary.
 */

/**
 * Structurally identical to `RecordRow` from the list repository, redeclared
 * here so a client module never imports from a `server-only` file — a type-only
 * import still puts that file in the bundler's resolution graph.
 */
export interface TableRow extends Record<string, unknown> {
  id: string;
}

export interface RecordTableProps {
  slug: string;
  columns: DataTableColumn[];
  fields: CellField[];
  statuses: StatusOption[];
  rows: TableRow[];
  emptyMessage: string;
  loading?: boolean;
  /** the column the list is ordered by, when it is ordered by one */
  sort?: { key: string; direction: 'asc' | 'desc' };
  /** a header was activated — the screen decides what sorting by it means */
  onSortColumn?: (key: string) => void;
  /**
   * A header's `oui:filter` funnel was activated. Measured: EVERY
   * `Table / Base / Header` cell in the `CRM _ Leads` frame carries an
   * `oui:filter` 16x16 flush right (x=686 of the 200-wide first cell, 946 of
   * the 260-wide Email cell, …) — it is not decoration on the title column.
   * `DataTable` draws the funnel only when this handler exists, so omitting it
   * was what left the built header a control short of the file.
   */
  onFilterColumn?: (key: string) => void;
  /** id → name for the user columns; absent, those cells show the stored id */
  userNames?: ReadonlyMap<string, string>;
  /** present ⇒ the table draws its selection column. See DataTableSelection. */
  selection?: DataTableSelection;
}

export function RecordTable({
  slug,
  columns,
  fields,
  statuses,
  rows,
  emptyMessage,
  loading = false,
  sort,
  onSortColumn,
  onFilterColumn,
  userNames,
  selection,
}: RecordTableProps) {
  const router = useRouter();

  // Maps, not `.find()` per cell: a 100-row page across 12 columns is 1,200
  // lookups, and both of these are keyed on ids that never repeat.
  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);

  /**
   * The 24x24 `Display Picture` the file draws inside the FIRST cell of every
   * row (`Table / Base /  List` 200x45 → `Content` gap:8 → Display Picture +
   * text). Measured: every other column's instance of that node is
   * `visible: false`, which is exactly what `DataTableColumn.avatarKey` being
   * per-column expresses.
   *
   * FILLED HERE rather than on the server because the rows arrive by two
   * different routes — the page renders them when the list is unfiltered, and
   * `ListScreen` POSTs for them when an ad-hoc filter is in effect. This is
   * the one place both paths pass through, so neither can end up with an
   * avatar the other lacks.
   *
   * The value is DEMO imagery derived from the record id and is never stored;
   * components/demo-avatar.ts explains why that is the honest option until an
   * IMAGE field is wired. When it is, the page points `avatarKey` at that
   * field's key and this whole map becomes dead weight to delete — it cannot
   * shadow a real value, because the key it writes is not a legal field key.
   */
  const rowsWithAvatars = useMemo(
    () => rows.map((row) => ({ ...row, [DEMO_AVATAR_ROW_KEY]: demoAvatarFor(row.id) })),
    [rows],
  );

  return (
    <DataTable<TableRow>
      columns={columns}
      rows={rowsWithAvatars}
      rowKey={(row) => row.id}
      renderCell={(column, row) =>
        renderFieldCell({
          field: fieldByKey.get(column.key),
          value: row[column.key],
          statusById,
          ...(userNames ? { userNames } : {}),
        })
      }
      // A real navigation, not an overlay: the record has a URL, so it can be
      // linked, opened in a new tab and returned to with the Back button. The
      // route is built from the slug, which is the only thing this component
      // knows about the module.
      onRowClick={(row) => router.push(`/${slug}/${row.id}`)}
      // The table emits `${trackPrefix}.row.open` from this prefix — the
      // interaction logger is one delegated listener, so the name has to be
      // right here rather than on each row.
      trackPrefix={`${slug}.list`}
      emptyMessage={emptyMessage}
      loading={loading}
      {...(sort ? { sort } : {})}
      {...(onSortColumn ? { onSortColumn } : {})}
      {...(onFilterColumn ? { onFilterColumn } : {})}
      {...(selection ? { selection } : {})}
    />
  );
}
