/**
 * Records of one module — the list and the create.
 *
 * Thin adapter: parse, call, serialise. Every rule the write obeys — the
 * permission check, the generated schema, the owner fallback, the audit entry,
 * the duplicate scan — lives in `@/lib/records/service`, so no route can
 * forget one and no second caller (the worker's import and webhook pipelines)
 * can implement them differently.
 *
 * GET carries the SIMPLE query state — search term, sort, page — because that
 * belongs in a URL: it is what makes a filtered list linkable, bookmarkable
 * and back-button-able. A FILTER TREE does not go here; it goes to
 * `./records/query` as a POST body, for the reasons written in that file.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { MAX_SORT_KEYS, type SortSpec } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { requestMeta } from '@/lib/audit';
import { createRecord, listModuleRecords } from '@/lib/records/service';

const DEFAULT_TAKE = 50;
const MAX_TAKE = 200;

/** A bounded non-negative integer from the query string. Hand-edited URLs
 *  happen, and `?take=100000` is a query that reads a module into memory. */
function intParam(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return Math.min(n, max);
}

/**
 * `?sort=lead_status:asc,created_at:desc` — a compact form, not JSON.
 *
 * A sort is a short list of (key, direction) pairs and reads fine in a URL,
 * where it is worth having: it survives a copied link. Unknown keys are NOT
 * dropped here — they travel to the repository, which resolves them and throws
 * a 400 naming the key. Dropping one silently would mean a link that quietly
 * sorts by something other than what it says.
 */
function sortParam(raw: string | null): SortSpec[] | undefined {
  if (!raw) return undefined;
  const specs: SortSpec[] = [];
  for (const part of raw.split(',').slice(0, MAX_SORT_KEYS)) {
    const [fieldKey, direction] = part.split(':');
    if (!fieldKey) continue;
    specs.push({ fieldKey: fieldKey.trim(), direction: direction === 'desc' ? 'desc' : 'asc' });
  }
  return specs.length > 0 ? specs : undefined;
}

export const GET = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  const params = new URL(req.url).searchParams;
  const pageParam = intParam(params.get('page'), 0, 100_000);
  const sort = sortParam(params.get('sort'));
  const search = params.get('search')?.trim();

  const { records, total, page, pageSize } = await listModuleRecords(principal, slug, {
    take: Math.max(intParam(params.get('take'), DEFAULT_TAKE, MAX_TAKE), 1),
    skip: intParam(params.get('skip'), 0, Number.MAX_SAFE_INTEGER),
    // `page` is the newer, 1-based form; `skip` stays for callers that already
    // speak it. `paging()` in the repository decides which wins, in one place.
    ...(pageParam > 0 ? { page: pageParam } : {}),
    ...(search ? { search } : {}),
    ...(sort ? { sort } : {}),
  });
  return NextResponse.json({ records, total, page, pageSize });
});

export const POST = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  // The envelope is deliberately unvalidated here: a record payload has no
  // fixed shape, and its real schema is generated from the module's live
  // FieldDefinitions inside the service. Declaring a shape in this file would
  // be a second, weaker copy of a contract that changes whenever an Admin adds
  // a field. `parseBody` still rejects a malformed body as a 400.
  const body = await parseBody(req, z.unknown());
  const record = await createRecord(principal, slug, body, requestMeta(req));
  return NextResponse.json({ record }, { status: 201 });
});
