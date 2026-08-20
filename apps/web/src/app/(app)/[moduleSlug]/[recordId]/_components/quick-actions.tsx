'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { StatusOption } from '@/app/(app)/[moduleSlug]/_components/cell';
import { cn, FieldLabel, Panel, PanelBody, PanelHeader, Select, StatusChip } from '@/components/ui';
import { api } from '@/lib/client-api';

/**
 * Quick actions and notes — the right column of the record screen (spec §6.5).
 *
 * The only action here today is the status move, because it is the one an
 * agent performs a hundred times a day and the one the whole pipeline is
 * keyed on. It writes through the SAME PATCH the form overlay uses, so the
 * audit entry, the duplicate rules and the permission check are identical
 * whichever door the change came through — a second write path is how a
 * timeline starts missing lines.
 *
 * The options are the module's live statuses, in the order the Admin dragged
 * them. Nothing here reads a status NAME or a module slug.
 */

export interface QuickActionsProps {
  slug: string;
  recordId: string;
  /** the field key the status lives under, or null when the module has no pipeline */
  statusFieldKey: string | null;
  statusFieldLabel: string;
  statuses: StatusOption[];
  currentStatusId: string | null;
  canEdit: boolean;
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
        <PanelBody>
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
                <p role="alert" className="mt-3 rounded bg-error/10 px-3 py-2 text-xs text-error">
                  {error}
                </p>
              ) : null}
            </>
          )}
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
