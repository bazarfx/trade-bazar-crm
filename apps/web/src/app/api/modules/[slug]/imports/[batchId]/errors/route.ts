/**
 * The error report — the rows that did not make it, with the row numbers a
 * user can find in their own spreadsheet.
 *
 * Paginated, because "every row failed" is a real and common outcome (a file
 * mapped to the wrong module produces exactly that) and a 40,000-row response
 * would take the browser down while trying to explain what went wrong.
 */
import { NextResponse } from 'next/server';
import { guarded } from '@/lib/api';
import { listImportErrors } from '@/lib/imports/service';

type Params = { slug: string; batchId: string };

/** A bounded positive integer from the query string; hand-edited URLs happen. */
function intParam(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export const GET = guarded<Params>(async (req, principal, { slug, batchId }) => {
  const params = new URL(req.url).searchParams;
  const page = intParam(params.get('page'));
  const pageSize = intParam(params.get('pageSize'));

  const result = await listImportErrors(principal, slug, batchId, {
    ...(page !== undefined ? { page } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
  });
  return NextResponse.json(result);
});
