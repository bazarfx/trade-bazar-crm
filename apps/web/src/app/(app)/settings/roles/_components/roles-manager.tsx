'use client';

import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { SPECIAL_PERMISSIONS } from '@crm/shared';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import {
  Popup,
  PopupFooter,
  Button,
  Chip,
  DataTable,
  FieldError,
  FieldLabel,
  Input,
  Panel,
  PanelHeader,
  Select,
  type DataTableColumn,
} from '@/components/ui';
import { api, ApiClientError } from '@/lib/client-api';
import { MatrixEditor } from './matrix-editor';
import { messageOf, TRACK, type RoleDto, type RoleRow } from './wire';

/**
 * The roles screen (spec §5.1). One row per live role, and the whole
 * permission matrix behind each one.
 *
 * The Admin role is LISTED, carries a Locked chip and opens read-only — it is
 * never filtered out. `isAdmin` is derived from `Role.isLocked`, so a screen
 * that could edit that column would make administrator a self-service upgrade;
 * the flag is therefore never sent, never editable and never inferred from the
 * role's name.
 */

type Overlay =
  | { kind: 'create' }
  | { kind: 'rename'; role: RoleRow }
  | { kind: 'matrix'; role: RoleRow }
  | { kind: 'delete'; role: RoleRow };

const COLUMNS: DataTableColumn[] = [
  // Pinned left, actions pinned right — the unbounded-content rule. A role
  // name is Admin-authored and has no length limit.
  { key: 'name', label: 'Role', width: 280, pinned: 'left' },
  { key: 'userCount', label: 'Users', width: 110 },
  { key: 'moduleCount', label: 'Modules with access', width: 190 },
  { key: 'specialCount', label: 'Special permissions', width: 190 },
  { key: 'actions', label: '', width: 120, pinned: 'right' },
];

export function RolesManager() {
  const [roles, setRoles] = useState<RoleRow[] | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRoles((await api<{ roles: RoleRow[] }>('/api/roles')).roles);
    } catch (err) {
      setBanner(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * A new role starts with NOTHING granted, so dropping the Admin straight
   * into the matrix is the difference between creating a role and creating a
   * role that works. Counts are 0 by construction, not a guess.
   */
  async function handleCreate(name: string) {
    const { role } = await api<{ role: RoleDto }>('/api/roles', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    const row: RoleRow = { ...role, userCount: 0, moduleCount: 0, specialCount: 0 };
    setNotice(`Role "${role.name}" created — it grants nothing until you set its permissions.`);
    setOverlay({ kind: 'matrix', role: row });
    await refresh();
  }

  function openDelete(e: MouseEvent<HTMLButtonElement>, role: RoleRow) {
    // The row itself opens the matrix; without this the delete overlay would
    // stack on top of an editor nobody asked for. The interaction log is
    // unaffected — its listener runs on the capture phase.
    e.stopPropagation();
    setBanner(null);
    setNotice(null);
    setOverlay({ kind: 'delete', role });
  }

  function renderCell(column: DataTableColumn, role: RoleRow) {
    if (column.key === 'name') {
      return (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-heading" title={role.name}>
            {role.name}
          </span>
          {role.isLocked && <Chip tone="info">Locked</Chip>}
        </span>
      );
    }
    if (column.key === 'specialCount') {
      return `${role.specialCount} of ${SPECIAL_PERMISSIONS.length}`;
    }
    if (column.key === 'actions') {
      // A locked role has no delete affordance at all: offering a button the
      // server will always refuse teaches the Admin to ignore refusals.
      if (role.isLocked) return <span className="text-body">—</span>;
      return (
        <span className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              // The row itself opens the matrix, so a control inside it must
              // not also trigger that.
              e.stopPropagation();
              setOverlay({ kind: 'rename', role });
            }}
            data-track={`${TRACK}.row.rename`}
            className="px-0"
          >
            Rename
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => openDelete(e, role)}
            data-track={`${TRACK}.row.delete`}
            className="px-0 hover:text-error"
          >
            Delete
          </Button>
        </span>
      );
    }
    return String(role[column.key] ?? '—');
  }

  return (
    <div className="flex flex-col gap-4">
      {banner !== null && (
        <div
          role="alert"
          className="flex items-start justify-between gap-4 rounded border border-error bg-surface px-4 py-3 text-sm text-error"
        >
          <span>{banner}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setBanner(null)}
            data-track={`${TRACK}.banner.dismiss`}
            className="text-error hover:bg-error/10"
          >
            Dismiss
          </Button>
        </div>
      )}

      {notice !== null && (
        <div
          role="status"
          className="flex items-start justify-between gap-4 rounded border border-border bg-surface px-4 py-3 text-sm text-heading"
        >
          <span>{notice}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setNotice(null)}
            data-track={`${TRACK}.notice.dismiss`}
          >
            Dismiss
          </Button>
        </div>
      )}

      <Panel className="overflow-hidden">
        <PanelHeader
          title={
            roles === null ? 'Roles' : `${roles.length} role${roles.length === 1 ? '' : 's'}`
          }
          actions={
            <Button onClick={() => setOverlay({ kind: 'create' })} data-track={`${TRACK}.create.open`}>
              New role
            </Button>
          }
        />
        <DataTable<RoleRow>
          columns={COLUMNS}
          rows={roles ?? []}
          rowKey={(role) => role.id}
          renderCell={renderCell}
          onRowClick={(role) => setOverlay({ kind: 'matrix', role })}
          // The table emits `${trackPrefix}.row.open` — `settings.roles.row.open`.
          trackPrefix={TRACK}
          loading={roles === null}
          emptyMessage="No roles yet — create the first one."
        />
      </Panel>

      {overlay?.kind === 'create' && (
        <CreateRoleOverlay onCreate={handleCreate} onClose={() => setOverlay(null)} />
      )}

      {overlay?.kind === 'rename' && (
        <RenameRoleOverlay
          role={overlay.role}
          onRenamed={async (name) => {
            setOverlay(null);
            setNotice(`Role renamed to "${name}".`);
            await refresh();
          }}
          onClose={() => setOverlay(null)}
        />
      )}

      {overlay?.kind === 'matrix' && (
        <MatrixEditor
          role={overlay.role}
          onSaved={() => void refresh()}
          onClose={() => setOverlay(null)}
        />
      )}

      {overlay?.kind === 'delete' && roles !== null && (
        <DeleteRoleOverlay
          role={overlay.role}
          others={roles.filter((r) => r.id !== overlay.role.id)}
          onDeleted={async (name) => {
            setOverlay(null);
            setNotice(`Role "${name}" deleted. It is soft-deleted, so its history stays readable.`);
            await refresh();
          }}
          onClose={() => setOverlay(null)}
        />
      )}
    </div>
  );
}

/**
 * Name only. A role is created empty and gains reach in the matrix editor —
 * fail closed, so an Admin adds permissions deliberately rather than by
 * forgetting to take defaults away.
 */
function CreateRoleOverlay({
  onCreate,
  onClose,
}: {
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('Role name is required');
      return;
    }
    setBusy(true);
    setError(null);
    onCreate(trimmed).catch((err: unknown) => {
      // A 409 here is a name clash — possibly with a SOFT-DELETED role, which
      // still owns its name. The server says which; do not paraphrase it.
      setError(messageOf(err));
      setBusy(false);
    });
  }

  return (
    <FullScreenOverlay title="New role" onClose={onClose} trackPrefix={`${TRACK}.create`}>
      <div className="mx-auto max-w-2xl px-8 py-8">
        <p className="text-sm text-body">
          The name is a label — nothing in the system reads it. Behaviour follows the permissions
          you grant next, so a role can be renamed at any time without changing what it can do.
        </p>

        <FieldLabel htmlFor="role-name" className="mt-6" required>
          Role name
        </FieldLabel>
        <Input
          id="role-name"
          value={name}
          maxLength={60}
          autoFocus
          placeholder="Telesales, Floor Manager, Back Office…"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          data-track={`${TRACK}.create.name.input`}
        />
        <FieldError>{error}</FieldError>

        <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
          <Button loading={busy} onClick={submit} data-track={`${TRACK}.create.submit`}>
            {busy ? 'Creating…' : 'Create role'}
          </Button>
          <Button variant="secondary" onClick={onClose} data-track={`${TRACK}.create.cancel`}>
            Cancel
          </Button>
        </div>
      </div>
    </FullScreenOverlay>
  );
}

/**
 * Delete is a conversation with the server, exactly as it is for statuses: try
 * without a reassignment target, and only when the 409 comes back (users hold
 * this role) ask where those people should go. `User.roleId` is NOT NULL and a
 * soft-deleted role locks its holders out at login, so there is no version of
 * this that can leave them where they are.
 *
 * Last-admin protection needs nothing here: the Admin role is locked, so it
 * never reaches this overlay and nobody can be moved off it by this path.
 */
function DeleteRoleOverlay({
  role,
  others,
  onDeleted,
  onClose,
}: {
  role: RoleRow;
  others: RoleRow[];
  onDeleted: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reassignToRoleId, setReassignToRoleId] = useState('');
  /** The server's own 409 reason — it carries the holder count it counted. */
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function confirm() {
    setBusy(true);
    setError(null);
    api<{ ok: true }>(`/api/roles/${role.id}`, {
      method: 'DELETE',
      body: JSON.stringify(reassignToRoleId ? { reassignToRoleId } : {}),
    })
      .then(() => onDeleted(role.name))
      .catch((err: unknown) => {
        setBusy(false);
        if (err instanceof ApiClientError && err.status === 409 && err.code === 'CONFLICT') {
          // Not an error state — the next step. The picker appears and the
          // same button retries with a target.
          setConflict(err.message);
          return;
        }
        setError(messageOf(err));
      });
  }

  const needsTarget = conflict !== null && reassignToRoleId === '';

  return (
    <FullScreenOverlay
      title={`Delete "${role.name}"`}
      onClose={onClose}
      trackPrefix={`${TRACK}.delete`}
    >
      <div className="mx-auto max-w-2xl px-8 py-8">
        <p className="text-sm text-heading">
          {role.userCount === 1
            ? '1 user currently holds this role.'
            : `${role.userCount} users currently hold this role.`}
        </p>
        <p className="mt-2 text-sm text-body">
          The role is soft-deleted, so every audit entry naming it still resolves and it can be
          restored. Its permissions are kept — they are not rebuilt from memory on a restore.
        </p>

        {conflict !== null && (
          // Verbatim: the count in this sentence is the server's own tally,
          // taken at the moment it refused, and it may differ from the list.
          <div
            role="alert"
            className="mt-4 rounded border border-warning bg-surface px-4 py-3 text-sm text-heading"
          >
            {conflict}
          </div>
        )}

        {error !== null && (
          <div
            role="alert"
            className="mt-4 rounded border border-error bg-surface px-4 py-3 text-sm text-error"
          >
            {error}
          </div>
        )}

        {conflict !== null && (
          <>
            <FieldLabel htmlFor="reassign-role" className="mt-6" required>
              Move these users to
            </FieldLabel>
            <Select
              id="reassign-role"
              value={reassignToRoleId}
              onChange={(e) => setReassignToRoleId(e.target.value)}
              data-track={`${TRACK}.delete.reassign.select`}
            >
              <option value="">Choose a role…</option>
              {others.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-body">
              Every move is written to the user&apos;s own timeline. Only an Admin may move people
              into the Admin role.
            </p>
          </>
        )}

        <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
          {/* Solid error fill for the confirm step of a delete, matching the
              status manager — the outlined destructive variant reads as an
              affordance rather than the final act. */}
          <Button
            disabled={needsTarget}
            loading={busy}
            onClick={confirm}
            data-track={`${TRACK}.delete.confirm`}
            className="border border-error bg-error text-surface hover:bg-error/90"
          >
            {busy ? 'Deleting…' : conflict === null ? 'Delete role' : 'Delete and reassign'}
          </Button>
          <Button variant="secondary" onClick={onClose} data-track={`${TRACK}.delete.cancel`}>
            Cancel
          </Button>
        </div>
      </div>
    </FullScreenOverlay>
  );
}

/**
 * Rename.
 *
 * Nothing in the system reads a role NAME — permissions are held by id, the
 * assignment engine points at `assignment.seniorRoleId`, and `isAdmin` keys
 * off `isLocked`. So renaming "Tele Sales" to "Telesellers" changes a label
 * and nothing else, which is exactly what the create dialog already promises
 * and what this dialog makes true.
 *
 * A 511 pop-up, not a full-screen surface: the file draws "Edit Name of Save
 * Filter" at 511, and a single text field is the same shape of task.
 */
function RenameRoleOverlay({
  role,
  onRenamed,
  onClose,
}: {
  role: RoleRow;
  onRenamed: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(role.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const unchanged = trimmed === role.name;

  function submit() {
    if (trimmed === '') {
      setError('Role name is required');
      return;
    }
    if (unchanged) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    api<{ role: RoleDto }>(`/api/roles/${role.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: trimmed }),
    })
      .then(() => onRenamed(trimmed))
      // A 409 is a clash with another role — including a SOFT-DELETED one,
      // which keeps its name. The server says which; do not paraphrase it.
      .catch((err: unknown) => {
        setError(messageOf(err));
        setBusy(false);
      });
  }

  return (
    <Popup
      open
      title="Rename role"
      width={511}
      onClose={onClose}
      trackPrefix={`${TRACK}.rename`}
      footer={
        <PopupFooter
          trackPrefix={`${TRACK}.rename`}
          cancel={{ label: 'Cancel', onClick: onClose }}
          next={{ label: busy ? 'Saving…' : 'Save', onClick: submit, disabled: busy }}
        />
      }
    >
      <FieldLabel htmlFor="role-rename" required>
        Role name
      </FieldLabel>
      <Input
        id="role-rename"
        value={name}
        maxLength={60}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        data-track={`${TRACK}.rename.name.input`}
      />
      <FieldError>{error}</FieldError>
      <p className="mt-3 text-xs text-body">
        Permissions, members and history are held by id, so a rename changes the label only.
      </p>
    </Popup>
  );
}
