'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
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
import { messageOf, Notice } from '../profile-shared';
import { GroupFormPopup } from './group-form-popup';
import { GroupMembersOverlay } from './group-members-overlay';
import type { GroupDto, GroupRow } from './types';

/**
 * The Groups sub-module (spec §5.3): create, rename, set the language of, and
 * populate the teams that assignment rounds over. Until this screen existed
 * the only way to do any of that was psql, which the client's contract rules
 * out.
 *
 * Chrome is the module list screen's: the toolbar band with the primary
 * action where Create X sits, the Profile tab row under it, then one panel
 * with THE table. Nothing here is drawn in the Figma file, so nothing here
 * invents a surface the file does not have — the pop-ups are the 511 the
 * file gives every name dialog, and members open full screen because a
 * list-plus-picker is an authoring surface.
 *
 * Every write goes through `/api/groups`, which runs `applyConfigChange`: the
 * permission assert, the before/after snapshot in ConfigChangeLog and the
 * undo all live there. This screen holds no decision of its own.
 */

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; group: GroupDto }
  /** the server answered 409 — members exist; ask before deleting anyway */
  | { kind: 'confirmDelete'; group: GroupDto }
  /** the server answered 422 — this is the nominated default pool */
  | { kind: 'guardrail'; group: GroupDto; message: string }
  | null;

export interface GroupsManagerProps {
  slug: string;
  /** distinct `User.languages`, read on the server page */
  languages: string[];
  /** The Profile tab row, rendered by the page between the band and the panel. */
  tabs: ReactNode;
}

const COLUMNS: DataTableColumn[] = [
  { key: 'name', label: 'Name', width: 260, pinned: 'left' },
  { key: 'language', label: 'Language', width: 160 },
  { key: 'members', label: 'Members', width: 160 },
  { key: 'flags', label: '', width: 200 },
  { key: 'actions', label: '', width: 180, pinned: 'right' },
];

export function GroupsManager({ slug, languages, tabs }: GroupsManagerProps) {
  const [groups, setGroups] = useState<GroupDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [membersOf, setMembersOf] = useState<GroupDto | null>(null);
  const [deleting, setDeleting] = useState(false);

  const track = `${slug}.groups`;

  const refresh = useCallback(async () => {
    // Deleted groups come along so Restore has something to show; the toggle
    // below decides whether they are drawn. Soft delete, always (invariant 4).
    const res = await api<{ groups: GroupDto[] }>('/api/groups?includeDeleted=1');
    setGroups(res.groups);
  }, []);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    refresh()
      .catch((err: unknown) => setLoadError(messageOf(err, 'Could not load groups.')))
      .finally(() => setLoading(false));
  }, [refresh]);

  const visible = useMemo(
    () => (showDeleted ? groups : groups.filter((g) => !g.isDeleted)),
    [groups, showDeleted],
  );

  const groupLanguages = useMemo(
    () => groups.map((g) => g.language).filter((l): l is string => l !== null && l !== ''),
    [groups],
  );

  /**
   * The overlap warning, explained. Two live groups serving one language is
   * legal — the engine routes to whichever sorts first by name — but it is
   * almost always a mistake, so the server says so and this screen repeats
   * it without blocking the save.
   */
  function handleSaved(saved: GroupDto, warning: string | undefined) {
    setDialog(null);
    setActionError(null);
    setNotice(
      warning === undefined
        ? null
        : `${warning} Campaign leads route to whichever matching group sorts first by name.`,
    );
    setGroups((cur) =>
      cur.some((g) => g.id === saved.id)
        ? cur.map((g) => (g.id === saved.id ? saved : g))
        : [...cur, saved].sort((a, b) => a.name.localeCompare(b.name)),
    );
    // Counts and the default-pool flag are server-derived; re-read them
    // rather than trusting the one row the write returned.
    void refresh().catch(() => undefined);
  }

  async function remove(group: GroupDto, confirmed: boolean) {
    setActionError(null);
    setDeleting(true);
    try {
      await api<{ ok: boolean }>(`/api/groups/${group.id}${confirmed ? '?confirmed=1' : ''}`, {
        method: 'DELETE',
      });
      setDialog(null);
      setGroups((cur) => cur.map((g) => (g.id === group.id ? { ...g, isDeleted: true } : g)));
      void refresh().catch(() => undefined);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        // The server's body carries the member count too, but the row on
        // screen already holds it and the client error type does not keep
        // unknown keys — so the count shown is the one the table shows.
        setDialog({ kind: 'confirmDelete', group });
      } else if (err instanceof ApiClientError && err.status === 422) {
        setDialog({ kind: 'guardrail', group, message: err.message });
      } else {
        setDialog(null);
        setActionError(messageOf(err, 'Could not delete this group.'));
      }
    } finally {
      setDeleting(false);
    }
  }

  async function restore(group: GroupDto) {
    setActionError(null);
    try {
      const { group: restored } = await api<{ group: GroupDto }>(`/api/groups/${group.id}/restore`, {
        method: 'POST',
      });
      setGroups((cur) => cur.map((g) => (g.id === group.id ? restored : g)));
    } catch (err) {
      setActionError(messageOf(err, 'Could not restore this group.'));
    }
  }

  function renderCell(column: DataTableColumn, row: GroupRow): ReactNode {
    switch (column.key) {
      case 'name':
        return row.name;
      case 'language':
        return row.language ?? '—';
      case 'members':
        // "active of total": the round-robin rounds over the active ones, and
        // a pool of six with four deactivated routes like a pool of two.
        return `${row.activeMemberCount} active of ${row.memberCount}`;
      case 'flags':
        return (
          <span className="flex items-center gap-1">
            {row.isDefaultPool ? <Chip tone="info">Default pool</Chip> : null}
            {row.isDeleted ? <Chip tone="neutral">Deleted</Chip> : null}
          </span>
        );
      case 'actions':
        return (
          /* Both events stop here: a click would bubble to the row and open
             the members screen for the group being deleted, and Space would
             be swallowed by the row's key handler. The interaction logger is
             unaffected — it listens on the capture phase. */
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
                  onClick={() => setDialog({ kind: 'edit', group: row })}
                  data-track={`${track}.edit.open`}
                >
                  Edit
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
      {/* THE TOOLBAR BAND — the list screen's `Rectangle 5`, 1152x56, white,
          1px border, radius 8, actions inside it right-aligned. */}
      <div className="flex h-14 items-center justify-between rounded-md border border-border bg-surface px-3">
        <Checkbox
          label="Show deleted groups"
          checked={showDeleted}
          onChange={(e) => setShowDeleted(e.target.checked)}
          data-track={`${track}.showDeleted.toggle`}
        />
        <Button
          variant="primary"
          // The measured Create button: 38 tall, pad 10/12, 18px icon, gap 10,
          // 12px label — same recipe as `ListActions`.
          className="h-[38px] gap-2.5 border border-border px-3 text-xs font-normal"
          iconLeft={<PlusIcon className="h-[18px] w-[18px]" />}
          onClick={() => setDialog({ kind: 'create' })}
          data-track={`${track}.create.open`}
        >
          New group
        </Button>
      </div>

      {tabs}

      {notice !== null ? (
        <Notice tone="warning" onDismiss={() => setNotice(null)} track={`${track}.notice.dismiss`}>
          {notice}
        </Notice>
      ) : null}
      {actionError !== null ? (
        <Notice tone="error" onDismiss={() => setActionError(null)} track={`${track}.error.dismiss`}>
          {actionError}
        </Notice>
      ) : null}

      <Panel className="flex min-w-0 flex-col overflow-hidden">
        <p className="border-b border-border px-6 py-3 text-xs text-body">
          Groups are the backbone of assignment: a campaign lead round-robins inside the group
          whose language matches it, and the nominated default pool catches the rest. Click a
          group to manage its members; the pool is nominated under{' '}
          <Link
            href="/settings/assignment"
            className="text-primary hover:underline"
            data-track={`${track}.assignment.open`}
          >
            Settings → Assignment
          </Link>
          .
        </p>
        {loadError !== null ? (
          <p role="alert" className="px-6 py-4 text-sm text-error">
            {loadError}
          </p>
        ) : (
          <DataTable<GroupRow>
            columns={COLUMNS}
            rows={visible}
            rowKey={(g) => g.id}
            renderCell={renderCell}
            // A deleted group's membership is history, not something to edit;
            // Restore first. The row still reads as a row.
            onRowClick={(g) => {
              if (!g.isDeleted) setMembersOf(g);
            }}
            trackPrefix={track}
            loading={loading}
            emptyMessage="No groups yet — create one, give it a language, and add the people who speak it."
          />
        )}
      </Panel>

      {dialog?.kind === 'create' || dialog?.kind === 'edit' ? (
        <GroupFormPopup
          slug={slug}
          group={dialog.kind === 'edit' ? dialog.group : null}
          languages={languages}
          groupLanguages={groupLanguages}
          onSaved={handleSaved}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'confirmDelete' ? (
        <Popup
          open
          width={511}
          title="Delete group"
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
                onClick: () => void remove(dialog.group, true),
              }}
            />
          }
        >
          <p className="text-sm text-heading">
            &ldquo;{dialog.group.name}&rdquo; has {dialog.group.memberCount}{' '}
            {dialog.group.memberCount === 1 ? 'member' : 'members'}. Deleting it stops leads
            routing here; the members keep their accounts and every lead already in the group
            keeps its owner. It can be restored from this screen.
          </p>
        </Popup>
      ) : null}

      {dialog?.kind === 'guardrail' ? (
        <Popup
          open
          width={511}
          title="This group cannot be deleted"
          trackPrefix={`${track}.guardrail`}
          onClose={() => setDialog(null)}
          footer={
            <PopupFooter
              trackPrefix={`${track}.guardrail`}
              cancel={{ label: 'Close', onClick: () => setDialog(null) }}
            />
          }
        >
          <p className="text-sm text-heading">{dialog.message}</p>
          <p className="text-sm text-body">
            &ldquo;{dialog.group.name}&rdquo; is the nominated default pool — the group every lead
            falls back to when nothing else matches. Nominate another pool first under{' '}
            <Link
              href="/settings/assignment"
              className="text-primary hover:underline"
              data-track={`${track}.guardrail.assignment.open`}
            >
              Settings → Assignment
            </Link>
            , then delete this one.
          </p>
        </Popup>
      ) : null}

      {membersOf !== null ? (
        <GroupMembersOverlay
          slug={slug}
          group={membersOf}
          onChanged={() => void refresh().catch(() => undefined)}
          onClose={() => setMembersOf(null)}
        />
      ) : null}
    </div>
  );
}
