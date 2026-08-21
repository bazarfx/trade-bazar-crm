/**
 * Reassign ONE record (spec §6.7).
 *
 * Thin adapter. Every rule the move obeys lives in `@/lib/records/service`:
 * the REASSIGN_LEADS check, the scoped load that makes an out-of-scope record
 * a 404, the active-user check on the target, and the REASSIGNED entry
 * carrying old owner -> new owner. A route cannot forget one, and the bulk
 * route beside it cannot implement them differently.
 *
 * POST rather than PATCH: a reassignment is an operation with its own
 * permission and its own timeline action, not an edit of the owner field —
 * PATCHing the record is the path for a role that may edit, and it is
 * deliberately not the same door.
 */
import { NextResponse } from 'next/server';
import { recordAssignSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { requestMeta } from '@/lib/audit';
import { reassignRecord } from '@/lib/records/service';

type Params = { slug: string; recordId: string };

export const POST = guarded<Params>(async (req, principal, { slug, recordId }) => {
  const { ownerId } = await parseBody(req, recordAssignSchema);
  const record = await reassignRecord(principal, slug, recordId, ownerId, requestMeta(req));
  return NextResponse.json({ record });
});
