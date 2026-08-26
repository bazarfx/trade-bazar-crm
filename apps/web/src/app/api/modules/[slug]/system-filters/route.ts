/**
 * The System Defined Filters group of one module's filter rail.
 *
 * Thin adapter: parse, call, serialise. Which of the nine rows this module can
 * answer — and the sentence explaining each one it cannot — is computed in
 * `@/lib/records/system-filters` from the module's storage shape, so this file
 * knows nothing about activities, campaigns or the audit log, and a module
 * that grows a capability needs no change here.
 *
 * A GET and not a POST: unlike a filter TREE, a request for the group carries
 * no record data at all — just a slug that is already in the path — so none of
 * the reasons that pushed `records/query` onto POST apply.
 *
 * The read gate lives in the lib and answers 404, not 403: to an actor with no
 * access, a module they may not see and a module that does not exist must be
 * the same answer.
 */
import { NextResponse } from 'next/server';
import { guarded } from '@/lib/api';
import { listSystemFilters } from '@/lib/records/system-filters';

export const GET = guarded<{ slug: string }>(async (_req, principal, { slug }) => {
  const filters = await listSystemFilters(principal, slug);
  return NextResponse.json({ filters });
});
