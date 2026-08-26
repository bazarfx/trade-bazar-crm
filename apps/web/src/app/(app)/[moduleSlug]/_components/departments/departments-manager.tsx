'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { FieldType, FilterNode } from '@crm/shared';
import { api, ApiClientError } from '@/lib/client-api';
import {
  Button,
  Checkbox,
  Chip,
  DataTable,
  Panel,
  Popup,
  PopupFooter,
  type DataTableColumn,
} from '@/components/ui';
import { PlusIcon } from '../icons';
import { encodeFilterHash } from '../list-query';
import { messageOf, Notice } from '../profile-shared';
import { DepartmentFormPopup } from './department-form-popup';
import type { DepartmentDto, DepartmentRow } from './types';

/**
 * The Departments sub-module (spec §5.2): create, rename, retire, restore.
 * Simpler than Groups on purpose — a department has no members list of its
 * own, because membership is ONE per user and lives on the user's record.
 * This screen says so, and the user count links to the module list filtered
 * by department so the people can be found and edited where they live.
 *
 * Same chrome as Groups and the list screen; same write path (every call
 * goes through `applyConfigChange` behind `/api/departments`).
 */

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; department: DepartmentDto }
  /** the server answered 409 — users point here; ask before deleting anyway */
  | { kind: 'confirmDelete'; department: DepartmentDto }
  | null;

export interface DepartmentsManagerProps {
  slug: string;
  /** module.labelPlural — what the count is a count OF. */
  labelPlural: string;
  /**
   * The module's live field that IS the department column, when this actor
   * may see it — resolved on the server by physical column, never by label.
   * Null means the rail cannot filter by department for this reader, and the
   * count links to the plain list instead of a filter the list would refuse.
   */
  departmentField: { key: string; type: FieldType } | null;
  /** The Profile tab row, rendered by the page between the band and the panel. */
  tabs: ReactNode;
}

const COLUMNS: DataTableColumn[] = [
  { key: 'name', label: 'Name', width: 300, pinned: 'left' },
  { key: 'users', label: 'Users', width: 160 },
  { key: 'flags', label: '', width: 140 },
  { key: 'actions', label: '', width: 180, pinned: 'right' },
];

/**
 * `/[slug]?f=1#f=<tree>` — the list screen's own encoding of an ad-hoc
 * filter: the presence flag in the query string, the tree in the fragment so
 * the value never reaches a server log. One condition, wrapped in the AND
 * group the rail itself produces, so the rail seeds its draft from it.
 */
function usersHref(slug: string, field: { key: string; type: FieldType } | null, departmentId: string): string {
  if (field === null) return `/${slug}`;
  const tree: FilterNode = {
    op: 'AND',
    children: [{ fieldKey: field.key, fieldType: field.type, operator: 'eq', value: departmentId }],
  };
  return `/${slug}?f=1${encodeFilterHash(tree)}`;
}

export function DepartmentsManager({ slug, labelPlural, departmentField, tabs }: DepartmentsManagerProps) {
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [deleting, setDeleting] = useState(false);

  const track = `${slug}.departments`;

  const refresh = useCallback(async () => {
    // Deleted departments come along so Restore has something to show; the
    // toggle below decides whether they are drawn. Soft delete, always.
    const res = await api<{ departments: DepartmentDto[] }>('/api/departments?includeDeleted=1');
    setDepartments(res.departments);
  }, []);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    refresh()
      .catch((err: unknown) => setLoadError(messageOf(err, 'Could not load departments.')))
      .finally(() => setLoading(false));
  }, [refresh]);

  const visible = useMemo(
    () => (showDeleted ? departments : departments.filter((d) => !d.isDeleted)),
    [departments, showDeleted],
  );

  function handleSaved(saved: DepartmentDto) {
    setDialog(null);
    setActionError(null);
    setDepartments((cur) =>
      cur.some((d) => d.id === saved.id)
        ? cur.map((d) => (d.id === saved.id ? saved : d))
        : [...cur, saved].sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  async function remove(department: DepartmentDto, confirmed: boolean) {
    setActionError(null);
    setDeleting(true);
    try {
      await api<{ ok: boolean }>(
        `/api/departments/${department.id}${confirmed ? '?confirmed=1' : ''}`,
        { method: 'DELETE' },
      );
      setDialog(null);
      // Soft-deleted server-side (invariant 4): the row stays, flagged, and
      // the users who pointed here keep their rows.
      setDepartments((cur) => cur.map((d) => (d.id === department.id ? { ...d, isDeleted: true } : d)));
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        // The server's body carries the user count too, but the row on
        // screen already holds it and the client error type does not keep
        // unknown keys — so the count shown is the one the table shows.
        setDialog({ kind: 'confirmDelete', department });
      } else {
        setDialog(null);
        setActionError(messageOf(err, 'Could not delete this department.'));
      }
    } finally {
      setDeleting(false);
    }
  }

  async function restore(department: DepartmentDto) {
    setActionError(null);
    try {
      const { department: restored } = await api<{ department: DepartmentDto }>(
        `/api/departments/${department.id}/restore`,
        { method: 'POST' },
      );
      setDepartments((cur) => cur.map((d) => (d.id === department.id ? restored : d)));
    } catch (err) {
      setActionError(messageOf(err, 'Could not restore this department.'));
    }
  }

  function renderCell(column: DataTableColumn, row: DepartmentRow): ReactNode {
    switch (column.key) {
      case 'name':
        return row.name;
      case 'users':
        return (
          /* stopPropagation: the row opens the rename dialog; the count goes
             to the people. The interaction logger listens on capture and is
             unaffected. */
          <Link
            href={usersHref(slug, departmentField, row.id)}
            onClick={(e) => e.stopPropagation()}
            className="text-primary hover:underline"
            data-track={`${track}.count.open`}
            title={`Open ${labelPlural} in ${row.name}`}
          >
            {row.userCount} {row.userCount === 1 ? 'user' : 'users'}
          </Link>
        );
      case 'flags':
        return row.isDeleted ? <Chip tone="neutral">Deleted</Chip> : null;
      case 'actions':
        return (
          <span
            className="flex items-center justify-end gap-1"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {row.isDeleted ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void restore(row)}
                data-track={`${track}.restore`}
              >
                Restore
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDialog({ kind: 'edit', department: row })}
                  data-track={`${track}.edit.open`}
                >
                  Rename
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void remove(row, false)}
                  disabled={deleting}
                  data-track={`${track}.delete.click`}
                  className="text-error hover:bg-[var(--globalcolors-red-10)]"
                >
                  Delete
                </Button>
              </>
            )}
          </span>
        );
      default:
        return null;
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* THE TOOLBAR BAND — the list screen's, with the primary action where
          Create X sits and the show-deleted toggle at the rail's edge. */}
      <div className="flex h-14 items-center justify-between rounded-md border border-border bg-surface px-3">
        <Checkbox
          label="Show deleted departments"
          checked={showDeleted}
          onChange={(e) => setShowDeleted(e.target.checked)}
          data-track={`${track}.showDeleted.toggle`}
        />
        <Button
          variant="primary"
          className="h-[38px] gap-2.5 border border-border px-3 text-xs font-normal"
          iconLeft={<PlusIcon className="h-[18px] w-[18px]" />}
          onClick={() => setDialog({ kind: 'create' })}
          data-track={`${track}.create.open`}
        >
          New department
        </Button>
      </div>

      {tabs}

      {actionError !== null ? (
        <Notice tone="error" onDismiss={() => setActionError(null)} track={`${track}.error.dismiss`}>
          {actionError}
        </Notice>
      ) : null}

      <Panel className="flex min-w-0 flex-col overflow-hidden">
        <p className="border-b border-border px-6 py-3 text-xs text-body">
          Each user belongs to one department, chosen on their own record — to move someone,
          edit the user. A department is a view-scope boundary in the roles matrix and a filter
          across the CRM; the count opens {labelPlural} filtered to it.
        </p>
        {loadError !== null ? (
          <p role="alert" className="px-6 py-4 text-sm text-error">
            {loadError}
          </p>
        ) : (
          <DataTable<DepartmentRow>
            columns={COLUMNS}
            rows={visible}
            rowKey={(d) => d.id}
            renderCell={renderCell}
            // A deleted department is history; Restore first.
            onRowClick={(d) => {
              if (!d.isDeleted) setDialog({ kind: 'edit', department: d });
            }}
            trackPrefix={track}
            loading={loading}
            emptyMessage="No departments yet — create one, then set it on each user's record."
          />
        )}
      </Panel>

      {dialog?.kind === 'create' || dialog?.kind === 'edit' ? (
        <DepartmentFormPopup
          slug={slug}
          department={dialog.kind === 'edit' ? dialog.department : null}
          onSaved={handleSaved}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'confirmDelete' ? (
        <Popup
          open
          width={511}
          title="Delete department"
          trackPrefix={`${track}.delete`}
          onClose={() => setDialog(null)}
          footer={
            <PopupFooter
              trackPrefix={`${track}.delete`}
              cancel={{ label: 'Cancel', onClick: () => setDialog(null) }}
              next={{
                label: 'Delete',
                tone: 'destructive',
                disabled: deleting,
                onClick: () => void remove(dialog.department, true),
              }}
            />
          }
        >
          <p className="text-sm text-heading">
            {dialog.department.userCount} {dialog.department.userCount === 1 ? 'user belongs' : 'users belong'}{' '}
            to &ldquo;{dialog.department.name}&rdquo;. Deleting it leaves them without a department
            until one is set on their records, and any role scoped to this department sees
            nothing there in the meantime. It can be restored from this screen.
          </p>
        </Popup>
      ) : null}
    </div>
  );
}
