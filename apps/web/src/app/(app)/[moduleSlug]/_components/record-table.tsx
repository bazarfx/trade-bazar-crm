'use client';

import { useMemo, useState } from 'react';
import { DataTable, type DataTableColumn } from '@/components/ui';
import { renderFieldCell, type CellField, type StatusOption } from './cell';
import { PendingOverlay } from './pending-overlay';

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
  /** module.label — SINGULAR, used in the record overlay's title. */
  label: string;
  columns: DataTableColumn[];
  fields: CellField[];
  statuses: StatusOption[];
  rows: TableRow[];
  emptyMessage: string;
}

export function RecordTable({
  slug,
  label,
  columns,
  fields,
  statuses,
  rows,
  emptyMessage,
}: RecordTableProps) {
  const [openRow, setOpenRow] = useState<TableRow | null>(null);

  // Maps, not `.find()` per cell: a 100-row page across 12 columns is 1,200
  // lookups, and both of these are keyed on ids that never repeat.
  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);

  return (
    <>
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
        onRowClick={setOpenRow}
        // The table emits `${trackPrefix}.row.open` from this prefix — the
        // interaction logger is one delegated listener, so the name has to be
        // right here rather than on each row.
        trackPrefix={`${slug}.list`}
        emptyMessage={emptyMessage}
      />

      {openRow ? (
        <PendingOverlay
          title={`${label} details`}
          message={
            'The record view — timeline, related lists and the layout an Admin arranged — arrives ' +
            'with the record engine slice. It opens full screen, exactly here.'
          }
          trackPrefix={`${slug}.list`}
          onClose={() => setOpenRow(null)}
        />
      ) : null}
    </>
  );
}
