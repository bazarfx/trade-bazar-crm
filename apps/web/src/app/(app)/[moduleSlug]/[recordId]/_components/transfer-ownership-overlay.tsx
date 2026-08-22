'use client';

import { useState } from 'react';
import {
  assignable,
  useDirectory,
  userLabel,
} from '@/app/(app)/[moduleSlug]/_components/directory';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { Button, FieldError, FieldLabel, Input, Select } from '@/components/ui';
import { api } from '@/lib/client-api';

/**
 * Transfer of Deal Owner (spec §7.1) — "who handles the customer from now
 * on", handed to another active user, every transfer logged.
 *
 * Full screen like every other write surface. Writes through
 * `POST .../transfer-owner`, which is deliberately NOT the assign route: a
 * transfer carries its own special (TRANSFER_DEAL_OWNERSHIP), its own
 * timeline action (OWNERSHIP_TRANSFERRED) and an optional reason the
 * timeline prints, so a report can tell a handover from a lead reassignment.
 *
 * Closed By is not on this screen and cannot be: the server writes the owner
 * column and nothing else. The copy says so, because the one question a
 * floor manager asks here is whether the agent keeps the credit.
 */

export interface TransferOwnershipOverlayProps {
  slug: string;
  recordId: string;
  /** the Admin's own label for the owner field — "Deal Owner" */
  ownerLabel: string;
  currentOwnerId: string | null;
  currentOwnerName: string | null;
  onClose: () => void;
  /** the write succeeded; the caller refreshes the page */
  onTransferred: () => void;
}

export function TransferOwnershipOverlay({
  slug,
  recordId,
  ownerLabel,
  currentOwnerId,
  currentOwnerName,
  onClose,
  onTransferred,
}: TransferOwnershipOverlayProps) {
  const directory = useDirectory(true);
  const [newOwnerId, setNewOwnerId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Active users only, and never the current owner: handing a deal to the
  // person who already has it is not a transfer and writes nothing.
  const candidates = assignable(directory.users).filter((u) => u.id !== currentOwnerId);

  function submit() {
    if (newOwnerId === '') {
      setError('Choose who takes over this customer.');
      return;
    }
    setBusy(true);
    setError(null);
    api<{ record: unknown }>(`/api/modules/${slug}/records/${recordId}/transfer-owner`, {
      method: 'POST',
      body: JSON.stringify({
        newOwnerId,
        ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
      }),
    })
      .then(() => {
        setBusy(false);
        onTransferred();
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : 'The transfer could not be made.');
      });
  }

  return (
    <FullScreenOverlay title="Transfer ownership" onClose={onClose} trackPrefix={`${slug}.detail.transfer`}>
      <div className="mx-auto max-w-2xl px-8 py-8">
        <p className="text-sm text-body">
          {ownerLabel} is who handles this customer from now on. Transferring it changes that
          person and nothing else: the agent credited with the conversion keeps that credit
          permanently, and the transfer itself is written to the timeline — old owner to new
          owner, with your reason if you give one.
        </p>

        <div className="mt-6 rounded border border-border bg-background px-4 py-3 text-sm">
          <span className="text-body">Currently</span>{' '}
          <span className="font-medium text-heading">
            {currentOwnerName ?? currentOwnerId ?? 'Not set'}
          </span>
        </div>

        <FieldLabel htmlFor="transfer-owner" className="mt-6" required>
          New {ownerLabel.toLowerCase()}
        </FieldLabel>
        <Select
          id="transfer-owner"
          value={newOwnerId}
          disabled={directory.loading || candidates.length === 0}
          autoFocus
          onChange={(e) => setNewOwnerId(e.target.value)}
          data-track={`${slug}.detail.transfer.owner.select`}
        >
          <option value="">
            {directory.loading ? 'Loading people…' : candidates.length === 0 ? 'Nobody available' : 'Choose a person…'}
          </option>
          {candidates.map((user) => (
            <option key={user.id} value={user.id}>
              {userLabel(user)}
            </option>
          ))}
        </Select>
        {!directory.loading && candidates.length === 0 ? (
          <p className="mt-1 text-xs text-body">
            {directory.unavailable
              ? 'Your role cannot see the people in this workspace, so there is nobody to hand this to.'
              : 'Every other user is deactivated. A deal is never handed to someone who cannot work it.'}
          </p>
        ) : (
          <p className="mt-1 text-xs text-body">Only active users are offered.</p>
        )}

        <FieldLabel htmlFor="transfer-reason" className="mt-5">
          Reason
        </FieldLabel>
        <Input
          id="transfer-reason"
          value={reason}
          maxLength={200}
          placeholder="Optional — e.g. customer asked for a Hindi speaker"
          onChange={(e) => setReason(e.target.value)}
          data-track={`${slug}.detail.transfer.reason.input`}
        />
        <p className="mt-1 text-xs text-body">Printed on the timeline beside the transfer.</p>

        <FieldError>{error}</FieldError>

        <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
          <Button loading={busy} onClick={submit} data-track={`${slug}.detail.transfer.submit`}>
            Transfer
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose} data-track={`${slug}.detail.transfer.cancel`}>
            Cancel
          </Button>
        </div>
      </div>
    </FullScreenOverlay>
  );
}
