'use client';

import { useState } from 'react';
import { BULK_ASSIGN_MAX, type BulkAssignResult } from '@crm/shared';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { Button, FieldError, FieldLabel, Select } from '@/components/ui';
import { api } from '@/lib/client-api';
import { assignable, useDirectory, userLabel } from './directory';

/**
 * Bulk reassign — the list screen's selection handed to one person (spec §6.4,
 * §6.7).
 *
 * Full screen, like every other form in this product. It knows nothing about
 * which module it is moving: the slug travels in the URL, the label comes from
 * `ModuleDefinition`, and the server decides what an owner column even is.
 *
 * Two things this screen refuses to do:
 *
 *  - **Claim more than happened.** The route answers `{ updated, skipped }`
 *    because a selection can legitimately span records outside the actor's
 *    view scope — those are excluded rather than refused, since a 403 naming
 *    them would confirm they exist. So the result is reported as arithmetic,
 *    not as "Done": three of ten moved is three of ten on screen.
 *  - **Offer a move it knows will fail.** Deactivated users are out of the
 *    picker, and a selection past the cap disables the button with the cap in
 *    words rather than letting the user discover it in a 400.
 */

export interface BulkReassignOverlayProps {
  slug: string;
  /** module.labelPlural — what a selection of these records is called. */
  labelPlural: string;
  recordIds: string[];
  /** The move committed. The list re-reads and the selection is dropped. */
  onDone: (result: BulkAssignResult) => void;
  onClose: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'The reassignment could not be completed';
}

export function BulkReassignOverlay({
  slug,
  labelPlural,
  recordIds,
  onDone,
  onClose,
}: BulkReassignOverlayProps) {
  const directory = useDirectory(true);
  const [ownerId, setOwnerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkAssignResult | null>(null);

  const candidates = assignable(directory.users);
  const overCap = recordIds.length > BULK_ASSIGN_MAX;

  function submit() {
    if (ownerId === '') {
      setError('Choose the user these records should belong to.');
      return;
    }
    setBusy(true);
    setError(null);

    api<BulkAssignResult>(`/api/modules/${slug}/records/assign`, {
      method: 'POST',
      body: JSON.stringify({ recordIds, ownerId }),
    })
      .then((res) => {
        setBusy(false);
        // Held on screen rather than closing on success: the counts ARE the
        // outcome, and an overlay that vanished would report a partial move
        // as a completed one.
        setResult(res);
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(messageOf(err));
      });
  }

  /** Closing after a run tells the list to re-read; closing before it does not. */
  function finish() {
    if (result !== null) onDone(result);
    onClose();
  }

  const chosen = candidates.find((u) => u.id === ownerId);

  return (
    <FullScreenOverlay
      title={`Reassign ${recordIds.length} ${labelPlural}`}
      onClose={finish}
      trackPrefix={`${slug}.list.bulk`}
    >
      <div className="mx-auto max-w-2xl px-8 py-8">
        {result === null ? (
          <>
            <p className="text-sm text-body">
              Every record you selected moves to one owner. Each move is written to that
              record&apos;s own timeline as old owner → new owner, so the history stays readable
              afterwards — nothing about a reassignment is silent.
            </p>
            <p className="mt-2 text-sm text-body">
              Records you cannot see are left alone rather than refused, so the count below may come
              back lower than {recordIds.length}. You will see exactly how many moved.
            </p>

            {overCap ? (
              <p
                role="alert"
                className="mt-4 rounded border border-warning bg-surface px-4 py-3 text-sm text-heading"
              >
                {recordIds.length} records are selected and one reassignment moves at most{' '}
                {BULK_ASSIGN_MAX}. Deselect some and run it again — a larger move belongs in a
                background job, not in a request that may time out halfway.
              </p>
            ) : null}

            <FieldLabel htmlFor="bulk-owner" className="mt-6" required>
              New owner
            </FieldLabel>
            <Select
              id="bulk-owner"
              value={ownerId}
              disabled={directory.loading || candidates.length === 0 || overCap}
              onChange={(e) => setOwnerId(e.target.value)}
              data-track={`${slug}.list.bulk.reassign.owner.select`}
            >
              <option value="">
                {directory.loading ? 'Loading people…' : 'Choose a user…'}
              </option>
              {candidates.map((user) => (
                <option key={user.id} value={user.id}>
                  {userLabel(user)}
                </option>
              ))}
            </Select>

            {!directory.loading && candidates.length === 0 ? (
              <p className="mt-1 text-xs text-body">
                There is nobody here to choose. Either your role cannot see the people in this
                workspace, or every account is deactivated — a deactivated user keeps their records
                but never receives new ones.
              </p>
            ) : null}

            {directory.total > directory.users.length ? (
              <p className="mt-1 text-xs text-body">
                Showing the first {directory.users.length} of {directory.total} people.
              </p>
            ) : null}

            <FieldError>{error}</FieldError>

            <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
              <Button
                loading={busy}
                disabled={ownerId === '' || overCap}
                onClick={submit}
                data-track={`${slug}.list.bulk.reassign.submit`}
              >
                {busy
                  ? 'Reassigning…'
                  : `Reassign ${recordIds.length} to ${chosen ? userLabel(chosen) : 'this user'}`}
              </Button>
              <Button variant="secondary" onClick={finish} data-track={`${slug}.list.bulk.reassign.cancel`}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <p role="status" className="text-sm text-heading">
              {result.updated === 0
                ? 'Nothing moved.'
                : `${result.updated} of ${recordIds.length} ${
                    recordIds.length === 1 ? 'record' : 'records'
                  } moved to ${chosen ? userLabel(chosen) : 'the new owner'}.`}
            </p>

            {result.skipped > 0 ? (
              // Named, not rounded away. The three reasons are the only ones
              // the server has, and the actor cannot tell them apart from
              // here — deliberately, since two of them would confirm that a
              // record they may not see exists.
              <p className="mt-2 text-sm text-body">
                {result.skipped} {result.skipped === 1 ? 'was' : 'were'} left where{' '}
                {result.skipped === 1 ? 'it was' : 'they were'}: outside your view scope, already
                owned by that user, or no longer in this module.
              </p>
            ) : null}

            <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
              <Button onClick={finish} data-track={`${slug}.list.bulk.reassign.done`}>
                Done
              </Button>
            </div>
          </>
        )}
      </div>
    </FullScreenOverlay>
  );
}
