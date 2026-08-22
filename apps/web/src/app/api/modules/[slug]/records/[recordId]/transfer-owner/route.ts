/**
 * Transfer Deal Owner (spec §7.1).
 *
 * POST, not PATCH, for the same reason the assign route is: a transfer is an
 * operation with its own special (TRANSFER_DEAL_OWNERSHIP), its own timeline
 * action (OWNERSHIP_TRANSFERRED) and its own reason — not an edit of the
 * owner field. Every rule lives in `transferDealOwnership`; this file parses,
 * calls and answers with the record as the detail page will redraw it.
 *
 * Closed By is untouched by construction: the service writes the owner
 * column and nothing else, and there is no route anywhere that writes Closed
 * By after conversion.
 */
import { NextResponse } from 'next/server';
import { transferOwnershipSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { requestMeta } from '@/lib/audit';
import { transferRecordOwner } from '@/lib/deals/transfer';

type Params = { slug: string; recordId: string };

export const POST = guarded<Params>(async (req, principal, { slug, recordId }) => {
  const input = await parseBody(req, transferOwnershipSchema);
  const record = await transferRecordOwner(principal, slug, recordId, input, requestMeta(req));
  return NextResponse.json({ record });
});
