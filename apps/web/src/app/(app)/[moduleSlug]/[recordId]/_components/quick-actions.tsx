'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { StatusOption } from '@/app/(app)/[moduleSlug]/_components/cell';
import {
  assignable,
  useDirectory,
  userLabel,
} from '@/app/(app)/[moduleSlug]/_components/directory';
import { useSpecials } from '@/app/(app)/[moduleSlug]/_components/specials';
import { Button, cn, FieldLabel, Panel, PanelBody, PanelHeader, Select, StatusChip } from '@/components/ui';
import { api } from '@/lib/client-api';
import { TransferOwnershipOverlay } from './transfer-ownership-overlay';

/**
 * Quick actions and notes — the right column of the record screen (spec §6.5).
 *
 * Two actions live here: the status move an agent performs a hundred times a
 * day, and the owner. Both write through the door the rest of the system
 * already uses — the status through the SAME PATCH the form overlay uses, the
 * owner through the assign route the bulk action uses (or, for a record that
 * is HANDED OVER rather than reassigned, the transfer route) — so the audit
 * entry and the permission check are identical whichever surface the change
 * came from. A second write path is how a timeline starts missing lines.
 *
 * The status options are the module's live statuses in the Admin's own order;
 * the owner options are the active users. Nothing here reads a status NAME, a
 * role name or a module slug.
 */

/**
 * How this module's owner moves. `reassign` is a lead changing hands between
 * reps under REASSIGN_LEADS; `transfer` is a deal's customer being handed to
 * someone else under TRANSFER_DEAL_OWNERSHIP, with its own timeline action.
 * Decided by the page from the STORAGE SHAPE (a table with a Closed By
 * column hands over; every other table reassigns), never from a slug.
 */
export type OwnerMode = 'reassign' | 'transfer';

export interface QuickActionsProps {
  slug: string;
  recordId: string;
  /** the field key the status lives under, or null when the module has no pipeline */
  statusFieldKey: string | null;
  statusFieldLabel: string;
  statuses: StatusOption[];
  currentStatusId: string | null;
  canEdit: boolean;
  /**
   * The Admin's own label for the owner field ("Lead Owner"), or null when
   * this module has no owner — or when the permission matrix hides that field
   * from this reader. Both mean the same thing to this panel: no owner block.
   * Hiding the field and then printing the owner's name beside it would make
   * the matrix cosmetic, and hiding a field in the UI is not a security
   * control.
   */
  ownerFieldLabel: string | null;
  currentOwnerId: string | null;
  /** resolved server-side, so the control never paints a UUID */
  currentOwnerName: string | null;
  ownerMode: OwnerMode;
  className?: string;
}

export function QuickActions({
  slug,
  recordId,
  statusFieldKey,
  statusFieldLabel,
  statuses,
  currentStatusId,
  canEdit,
  ownerFieldLabel,
  currentOwnerId,
  currentOwnerName,
  ownerMode,
  className,
}: QuickActionsProps) {
  const router = useRouter();
  const [value, setValue] = useState<string>(currentStatusId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // router.refresh() re-renders the server component, which hands down the
  // stored status. Adopting it here is what makes a failed write, a concurrent
  // change by someone else and a webhook status move all converge on the truth.
  useEffect(() => {
    setValue(currentStatusId ?? '');
  }, [currentStatusId]);

  async function changeStatus(next: string) {
    if (!statusFieldKey || next === '' || next === value) return;
    const previous = value;
    // Paint the move immediately — the select is the control the agent is
    // looking at — and roll back to the stored value if the write is refused.
    setValue(next);
    setSaving(true);
    setError(null);
    try {
      await api<{ record: unknown }>(`/api/modules/${slug}/records/${recordId}`, {
        method: 'PATCH',
        body: JSON.stringify({ [statusFieldKey]: next }),
      });
      // The record, the information panel and the timeline all re-read from
      // the server: the STATUS_CHANGED entry the engine just wrote belongs at
      // the top of the log, and only the server can produce it.
      router.refresh();
    } catch (err) {
      setValue(previous);
      setError(err instanceof Error ? err.message : 'The status could not be changed');
    } finally {
      setSaving(false);
    }
  }

  const current = statuses.find((s) => s.id === value) ?? null;

  return (
    <div className={cn('flex flex-col gap-6 overflow-y-auto', className)}>
      <Panel>
        <PanelHeader title="Quick actions" />
        <PanelBody className="flex flex-col gap-6">
          <div>
          {statusFieldKey === null || statuses.length === 0 ? (
            <p className="text-sm text-body">
              This module has no pipeline, so there is no status to move.
            </p>
          ) : (
            <>
              <FieldLabel htmlFor="detail-status">{statusFieldLabel}</FieldLabel>
              <Select
                id="detail-status"
                value={value}
                disabled={!canEdit || saving}
                // A disabled control with no explanation reads as a broken one.
                title={canEdit ? undefined : 'Your role cannot edit this record.'}
                onChange={(e) => void changeStatus(e.target.value)}
                data-track={`${slug}.detail.status.select`}
              >
                {/* Only reachable when a record predates the module's statuses;
                    it is never a value the reader can choose back into. */}
                {value === '' ? <option value="">Not set</option> : null}
                {statuses.map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.name}
                  </option>
                ))}
              </Select>

              {current ? (
                <div className="mt-3">
                  {/* The chip reads the TAG, so the tone survives any rename. */}
                  <StatusChip name={current.name} tag={current.tag} color={current.color} />
                </div>
              ) : null}

              {error !== null ? (
                <p role="alert" className="mt-3 rounded bg-[var(--globalcolors-red-10)] px-3 py-2 text-xs text-error">
                  {error}
                </p>
              ) : null}
            </>
          )}
          </div>

          {ownerFieldLabel !== null ? (
            ownerMode === 'transfer' ? (
              <TransferControl
                slug={slug}
                recordId={recordId}
                label={ownerFieldLabel}
                currentOwnerId={currentOwnerId}
                currentOwnerName={currentOwnerName}
              />
            ) : (
              <OwnerControl
                slug={slug}
                recordId={recordId}
                label={ownerFieldLabel}
                currentOwnerId={currentOwnerId}
                currentOwnerName={currentOwnerName}
              />
            )
          ) : null}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Notes" />
        <PanelBody>
          {/* Deliberately no input. A box that accepts text and drops it is
              worse than an honest gap: notes are their own logged entity
              (NOTE_ADDED on the timeline) and arrive with that slice. */}
          <p className="text-sm text-body">
            Notes arrive in a later slice. They will be logged entries on the timeline, not a
            free-text box beside it — so nothing typed here can be silently lost.
          </p>
        </PanelBody>
      </Panel>
    </div>
  );
}

interface OwnerControlProps {
  slug: string;
  recordId: string;
  /** the Admin's own label for the owner field */
  label: string;
  currentOwnerId: string | null;
  currentOwnerName: string | null;
}

/**
 * The owner, and the one control that moves it.
 *
 * Writes through `POST .../records/{id}/assign`, NOT through a PATCH of the
 * owner field. They are deliberately different doors: reassignment carries its
 * own permission (REASSIGN_LEADS), its own timeline action (REASSIGNED) and
 * its own reason, so a role that may edit a record does not thereby acquire
 * the power to move its ownership — and the timeline can say which of the two
 * happened.
 *
 * Invariant 1 is visible here: there is no "unassign" option and no blank
 * choice. The engine gave this record an owner the second it was created, and
 * the only thing this control can do is name a different one.
 */
function OwnerControl({
  slug,
  recordId,
  label,
  currentOwnerId,
  currentOwnerName,
}: OwnerControlProps) {
  const router = useRouter();
  const specials = useSpecials();
  // UX only — `assertMayReassign` runs again in the record service, and the
  // scoped load there answers 404 for a record this actor may not see.
  const canReassign = specials.has('REASSIGN_LEADS');
  // Nobody who cannot reassign pays for the directory: a read-only owner line
  // needs the NAME the server already resolved, not the list of candidates.
  const directory = useDirectory(canReassign);

  const [value, setValue] = useState<string>(currentOwnerId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The server is the truth: after a successful move `router.refresh()` hands
  // down the stored owner, and adopting it here is what makes a refused write,
  // a concurrent move by a floor manager and an ARK-driven handover all
  // converge on the same value.
  useEffect(() => {
    setValue(currentOwnerId ?? '');
  }, [currentOwnerId]);

  const candidates = assignable(directory.users);
  const chosen = candidates.find((u) => u.id === value);
  // The stored owner may be absent from the picker — deactivated, or outside
  // what this actor may enumerate — so the server-resolved name stands in.
  const shownName = chosen ? userLabel(chosen) : (currentOwnerName ?? currentOwnerId);

  async function reassign(next: string) {
    if (next === '' || next === value) return;
    const previous = value;
    // Paint the move immediately — this is the control the user is looking at
    // — and roll back to the stored owner if the write is refused.
    setValue(next);
    setSaving(true);
    setError(null);
    try {
      await api<{ record: unknown }>(`/api/modules/${slug}/records/${recordId}/assign`, {
        method: 'POST',
        body: JSON.stringify({ ownerId: next }),
      });
      // The panel and the timeline re-read from the server: the REASSIGNED
      // entry carrying old owner → new owner belongs at the top of the log,
      // and only the server can produce it.
      router.refresh();
    } catch (err) {
      setValue(previous);
      setError(err instanceof Error ? err.message : 'The owner could not be changed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <FieldLabel htmlFor="detail-owner">{label}</FieldLabel>

      {canReassign ? (
        <Select
          id="detail-owner"
          value={value}
          disabled={saving || directory.loading || candidates.length === 0}
          onChange={(e) => void reassign(e.target.value)}
          data-track={`${slug}.detail.owner.select`}
        >
          {/* Only reachable when the stored owner is not among the candidates
              — deactivated, or outside what this actor may enumerate. It is
              never a value the reader can choose back into, because a record
              is never unassigned. */}
          {chosen === undefined ? (
            <option value={value}>{shownName ?? 'Not set'}</option>
          ) : null}
          {candidates.map((user) => (
            <option key={user.id} value={user.id}>
              {userLabel(user)}
            </option>
          ))}
        </Select>
      ) : (
        // A read-only line rather than a disabled picker: the owner is worth
        // knowing even to someone who cannot change it, and a greyed-out
        // control with a tooltip is a worse way to say the same thing.
        <p className="truncate text-sm text-heading" title={shownName ?? undefined}>
          {shownName ?? '—'}
        </p>
      )}

      {canReassign && !directory.loading && candidates.length === 0 ? (
        <p className="mt-1 text-xs text-body">
          There is nobody to hand this to — your role cannot see the people in this workspace.
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="mt-3 rounded bg-[var(--globalcolors-red-10)] px-3 py-2 text-xs text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The owner of a record that is HANDED OVER, not reassigned (spec §7.1).
 *
 * The name is read-only here; the move happens in a full-screen overlay
 * through `POST .../transfer-owner`, under TRANSFER_DEAL_OWNERSHIP, with its
 * own OWNERSHIP_TRANSFERRED entry and an optional reason. The door is drawn
 * only for holders of that special — the server asserts it again.
 */
function TransferControl({
  slug,
  recordId,
  label,
  currentOwnerId,
  currentOwnerName,
}: OwnerControlProps) {
  const router = useRouter();
  const specials = useSpecials();
  const canTransfer = specials.has('TRANSFER_DEAL_OWNERSHIP');
  const [open, setOpen] = useState(false);
  const shownName = currentOwnerName ?? currentOwnerId;

  return (
    <div>
      {/* No `htmlFor`: there is no control here to point at, only a value. */}
      <FieldLabel>{label}</FieldLabel>
      <p className="truncate text-sm text-heading" title={shownName ?? undefined}>
        {shownName ?? '—'}
      </p>
      {canTransfer ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => setOpen(true)}
          data-track={`${slug}.detail.transfer.open`}
        >
          Transfer ownership
        </Button>
      ) : (
        <p className="mt-1 text-xs text-body">
          Handed over by the handover rule; transferable by roles with <em>Transfer deal ownership</em>.
        </p>
      )}

      {open ? (
        <TransferOwnershipOverlay
          slug={slug}
          recordId={recordId}
          ownerLabel={label}
          currentOwnerId={currentOwnerId}
          currentOwnerName={currentOwnerName}
          onClose={() => setOpen(false)}
          onTransferred={() => {
            setOpen(false);
            // The OWNERSHIP_TRANSFERRED entry belongs at the top of the log,
            // and only the server can produce it.
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
