/**
 * One record: read, edit, delete.
 *
 * Thin adapter. In particular the scope check is NOT here — `getRecord`,
 * `updateRecord` and `softDeleteRecord` all load the row through the same
 * repository call the list uses, because a by-id fetch that resolved the id
 * directly is how a permission check gets skipped.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guarded, parseBody } from '@/lib/api';
import { requestMeta } from '@/lib/audit';
import { getRecord, softDeleteRecord, updateRecord } from '@/lib/records/service';

type Params = { slug: string; recordId: string };

export const GET = guarded<Params>(async (_req, principal, { slug, recordId }) => {
  const record = await getRecord(principal, slug, recordId);
  return NextResponse.json({ record });
});

export const PATCH = guarded<Params>(async (req, principal, { slug, recordId }) => {
  // Unvalidated envelope on purpose — the module's generated schema is the
  // contract, and the service parses against `.partial()` of it.
  const body = await parseBody(req, z.unknown());
  const record = await updateRecord(principal, slug, recordId, body, requestMeta(req));
  return NextResponse.json({ record });
});

export const DELETE = guarded<Params>(async (req, principal, { slug, recordId }) => {
  // Soft delete: the row survives, and so does its timeline (invariant 4).
  await softDeleteRecord(principal, slug, recordId, requestMeta(req));
  return NextResponse.json({ ok: true });
});
