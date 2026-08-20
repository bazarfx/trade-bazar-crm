'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { DataTable, type DataTableColumn } from '@/components/ui';
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
}: RecordTableProps) {
  const router = useRouter();

  // Maps, not `.find()` per cell: a 100-row page across 12 columns is 1,200
  // lookups, and both of these are keyed on ids that never repeat.
  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);

  return (
    <DataTable<TableRow>
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      renderCell={(column, row) =>
        renderFieldCell({
          field: fieldByKey.get(column.key),
          value: row[column.key],
          statusById,
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
    />
  );
}
