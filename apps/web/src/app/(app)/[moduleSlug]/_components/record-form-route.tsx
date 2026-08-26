'use client';

import { useRouter } from 'next/navigation';
import { RecordFormScreen, type LockedField } from './record-form-screen';

/**
 * The navigation half of the record form.
 *
 * The form itself knows nothing about routes — it calls `onClose` and
 * `onSaved`, exactly as it did when it opened over the page. This wrapper is
 * what turns those into navigation now that the form IS a page (measured off
 * `CRM _ Leads_Create Leads`, which draws the sidebar and top bar around it).
 *
 * Cancel goes BACK rather than to a fixed URL: the form is reachable from the
 * list and from a record, and returning somebody to the list when they opened
 * it from a record is the small wrongness that makes a screen feel borrowed.
 * A save goes to the record that was written, which is where the person was
 * heading anyway.
 */
export interface RecordFormRouteProps {
  slug: string;
  label: string;
  systemColumns: Record<string, string | null>;
  locked?: readonly LockedField[];
  recordId?: string;
}

export function RecordFormRoute({
  slug,
  label,
  systemColumns,
  locked,
  recordId,
}: RecordFormRouteProps) {
  const router = useRouter();

  return (
    <RecordFormScreen
      slug={slug}
      label={label}
      systemColumns={systemColumns}
      {...(locked ? { locked } : {})}
      {...(recordId === undefined ? {} : { recordId })}
      onClose={() => router.back()}
      onSaved={(id) => router.push(`/${slug}/${id}`)}
    />
  );
}
