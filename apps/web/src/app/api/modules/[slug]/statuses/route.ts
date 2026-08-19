/**
 * Thin adapter: parse -> lib -> serialise. All behaviour lives in
 * `@/lib/config/statuses`; permissions are asserted in the config service.
 */
import { NextResponse } from 'next/server';
import { statusCreateSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { createStatus, listStatuses } from '@/lib/config/statuses';

export const GET = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  const includeDeleted = new URL(req.url).searchParams.get('includeDeleted') === 'true';
  const statuses = await listStatuses(principal, slug, { includeDeleted });
  return NextResponse.json({ statuses });
});

export const POST = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  const input = await parseBody(req, statusCreateSchema);
  const status = await createStatus(principal, slug, input);
  return NextResponse.json({ status }, { status: 201 });
});
