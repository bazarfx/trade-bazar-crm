/**
 * The wizard's final Next — and the line CLAUDE.md draws.
 *
 * Everything before this ran in a request; everything after it runs in the
 * worker. This handler validates what a human can still fix, enqueues, and
 * returns immediately with the counters at zero. It does not import a single
 * row: a multi-megabyte import is the example CLAUDE.md gives for work that
 * never belongs in a route handler.
 */
import { NextResponse } from 'next/server';
import { importCommitSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { commitImport } from '@/lib/imports/service';

type Params = { slug: string; batchId: string };

export const POST = guarded<Params>(async (req, principal, { slug, batchId }) => {
  const input = await parseBody(req, importCommitSchema);
  const progress = await commitImport(principal, slug, batchId, input);
  // 202: accepted, not done. The wizard polls GET on the batch from here.
  return NextResponse.json({ progress }, { status: 202 });
});
