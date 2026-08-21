/**
 * Record a decision about one flagged pair (spec §6.6).
 *
 * The only resolutions are KEPT_BOTH, MERGED and DISMISSED — the schema is
 * the contract. There is deliberately no merge OPERATION behind any of them:
 * "merged" means a person already moved the data by hand through the normal
 * edit path, and this endpoint only records that it happened. The service
 * writes DUPLICATE_RESOLVED to both records' timelines in the same
 * transaction as the flag update.
 */
import { NextResponse } from 'next/server';
import { duplicateResolveSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { requestMeta } from '@/lib/audit';
import { resolveDuplicateFlag } from '@/lib/intake/duplicates';

type Params = { slug: string; flagId: string };

export const POST = guarded<Params>(async (req, principal, { slug, flagId }) => {
  const { resolution } = await parseBody(req, duplicateResolveSchema);
  const flag = await resolveDuplicateFlag(principal, slug, flagId, resolution, requestMeta(req));
  return NextResponse.json({ flag });
});
