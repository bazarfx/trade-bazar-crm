/**
 * The filtered list: `POST /api/modules/:slug/records/query`.
 *
 * WHY A POST, and not `GET ?filters=<json>`:
 *
 *  1. **Length.** A filter tree is nested AND/OR over a module that has 33
 *     fields on Leads today. URL-encoded, a realistic saved filter runs to a
 *     few KB, and the ceiling is not ours to set — IE's 2,083 characters is
 *     history, but nginx's default `large_client_header_buffers` (8k) and
 *     CloudFront's 8,192-byte request line are not. A filter that works for
 *     eight conditions and 502s at twenty is the worst kind of limit.
 *  2. **Filter VALUES are record data.** "email contains @acme.co", "phone
 *     starts with 98", "owner is <uuid>". A query string lands in the access
 *     log, the proxy log, the browser history and the Referer header of every
 *     asset the page then loads. CLAUDE.md's privacy rule — never put personal
 *     data in a URL — applies to a filter as much as to a record.
 *
 * A POST that reads is a deliberate trade: it is not cacheable and not
 * linkable. The linkable half of the query state — search term, sort, page —
 * therefore stays on GET `../records`, and only the tree moves here.
 *
 * Thin adapter, as always: `recordQuerySchema` (packages/shared) says what a
 * query may be, and `listModuleRecords` does all of it. Note that the schema
 * is STRUCTURAL — the field-and-operator check happens against the module's
 * live fields inside the repository, which is also where an unknown key
 * becomes a 400 rather than a silently dropped condition.
 */
import { NextResponse } from 'next/server';
import { recordQuerySchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { listModuleRecords } from '@/lib/records/service';

export const POST = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  const input = await parseBody(req, recordQuerySchema);
  const { records, total, page, pageSize } = await listModuleRecords(principal, slug, {
    ...(input.filters ? { filters: input.filters } : {}),
    ...(input.sort ? { sort: input.sort } : {}),
    ...(input.search ? { search: input.search } : {}),
    ...(input.page !== undefined ? { page: input.page } : {}),
    ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
  });
  return NextResponse.json({ records, total, page, pageSize });
});
