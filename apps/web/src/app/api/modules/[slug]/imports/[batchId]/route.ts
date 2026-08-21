/**
 * One batch: read it, or edit its instructions.
 *
 * GET answers both questions the wizard asks of a batch — "what did I stage"
 * (headers and mapping, so Previous and a reload can rebuild the screen) and
 * "how far has it got" (the counters the progress bar polls). One round trip
 * for both, because polling that also carries the mapping is cheaper than a
 * second endpoint that repeats the scope check.
 *
 * PATCH is the wizard saving as the user moves through stages 2 and 4. It
 * refuses once the batch has been submitted: the mapping is then a historical
 * fact about how the rows were imported, and the error report is read against
 * it.
 */
import { NextResponse } from 'next/server';
import { importPatchSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { getImportBatch, getImportProgress, updateImportBatch } from '@/lib/imports/service';

type Params = { slug: string; batchId: string };

export const GET = guarded<Params>(async (_req, principal, { slug, batchId }) => {
  const [batch, progress] = await Promise.all([
    getImportBatch(principal, slug, batchId),
    getImportProgress(principal, slug, batchId),
  ]);
  return NextResponse.json({ batch, progress });
});

export const PATCH = guarded<Params>(async (req, principal, { slug, batchId }) => {
  const patch = await parseBody(req, importPatchSchema);
  const batch = await updateImportBatch(principal, slug, batchId, patch);
  return NextResponse.json({ batch });
});
