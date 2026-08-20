'use client';

import { useState } from 'react';
import { RecordFormOverlay } from '@/app/(app)/[moduleSlug]/_components/record-form-overlay';
import { Button } from '@/components/ui';

/**
 * The header action on a record: Edit.
 *
 * A record is written from exactly one place — the generated full-screen form
 * overlay — so this button opens that form rather than growing an inline
 * editor beside it. Two write surfaces would mean two validation paths, and
 * the one that drifts is always the one nobody is looking at.
 */
export interface DetailActionsProps {
  slug: string;
  /** module.label — SINGULAR, the thing this record is. */
  label: string;
  recordId: string;
  canEdit: boolean;
  /**
   * Field key → physical column. The form needs it to recognise which field IS
   * the status and which IS the owner without naming either — see
   * `RecordFormOverlay`.
   */
  systemColumns: Record<string, string | null>;
}

export function DetailActions({
  slug,
  label,
  recordId,
  canEdit,
  systemColumns,
}: DetailActionsProps) {
  const [editing, setEditing] = useState(false);

  return (
    <>
      <div className="flex shrink-0 items-center gap-3">
        <Button
          variant="primary"
          disabled={!canEdit}
          title={canEdit ? undefined : `Your role cannot edit ${label} records.`}
          onClick={() => setEditing(true)}
          data-track={`${slug}.detail.edit.open`}
        >
          Edit
        </Button>
      </div>

      {editing ? (
        // `recordId` present ⇒ the overlay loads that record and PATCHes it.
        // It refreshes the route on save, which is what redraws the panel and
        // appends the new timeline entry behind this overlay.
        <RecordFormOverlay
          slug={slug}
          label={label}
          systemColumns={systemColumns}
          recordId={recordId}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}
