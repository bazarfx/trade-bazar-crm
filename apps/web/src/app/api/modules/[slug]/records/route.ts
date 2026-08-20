/**
 * Records of one module — the list and the create.
 *
 * Thin adapter: parse, call, serialise. Every rule the write obeys — the
 * permission check, the generated schema, the owner fallback, the audit entry,
 * the duplicate scan — lives in `@/lib/records/service`, so no route can
 * forget one and no second caller (the worker's import and webhook pipelines)
 * can implement them differently.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
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

export const GET = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  const params = new URL(req.url).searchParams;
  const { records, total } = await listModuleRecords(principal, slug, {
    take: Math.max(intParam(params.get('take'), DEFAULT_TAKE, MAX_TAKE), 1),
    skip: intParam(params.get('skip'), 0, Number.MAX_SAFE_INTEGER),
  });
  return NextResponse.json({ records, total });
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
