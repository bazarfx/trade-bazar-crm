/**
 * Thin adapter: parse -> lib -> serialise. All behaviour lives in
 * `@/lib/config/statuses`; permissions are asserted in the config service.
 */
import { NextResponse } from 'next/server';
import { statusDeleteSchema, statusUpdateSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { deleteStatus, updateStatus } from '@/lib/config/statuses';

type Params = { slug: string; statusId: string };

export const PATCH = guarded<Params>(async (req, principal, { slug, statusId }) => {
  const input = await parseBody(req, statusUpdateSchema);
  const status = await updateStatus(principal, slug, statusId, input);
  return NextResponse.json({ status });
});

export const DELETE = guarded<Params>(async (req, principal, { slug, statusId }) => {
  // DELETE carries an OPTIONAL JSON body (the replacement choice). Many
  // clients send none at all, so an absent or malformed body must read as
  // "no replacement chosen" — the in-use check then answers with the 409.
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    // no body — fall through with {}
  }
  const input = statusDeleteSchema.parse(raw);
  const status = await deleteStatus(principal, slug, statusId, input);
  return NextResponse.json({ status });
});
