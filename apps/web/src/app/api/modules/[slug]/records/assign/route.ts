/**
 * Bulk reassign — the list screen's bulk action (spec §6.4, §6.7).
 *
 * Thin adapter. The cap, the two permissions (REASSIGN_LEADS and
 * BULK_OPERATIONS), the scoped read that silently excludes records the actor
 * cannot see, and the one REASSIGNED entry PER RECORD all live in
 * `@/lib/records/service`.
 *
 * A static segment beside `[recordId]`, so `/records/assign` is this route and
 * `/records/{id}/assign` is the single one — Next matches the literal first.
 *
 * The response reports `{ updated, skipped }` rather than an ok flag: a
 * selection can legitimately span records outside the actor's scope, and a
 * bulk action that says "done" after moving nine of forty is a lie the UI
 * would repeat to its user.
 */
import { NextResponse } from 'next/server';
import { recordBulkAssignSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { requestMeta } from '@/lib/audit';
import { reassignRecords } from '@/lib/records/service';

type Params = { slug: string };

export const POST = guarded<Params>(async (req, principal, { slug }) => {
  const { recordIds, ownerId } = await parseBody(req, recordBulkAssignSchema);
  const result = await reassignRecords(principal, slug, recordIds, ownerId, requestMeta(req));
  return NextResponse.json(result);
});
