/**
 * Thin adapter: parse -> lib -> serialise. All behaviour lives in
 * `@/lib/config/groups`; the read gate and the write gate are asserted there,
 * so this file holds no decision of its own.
 *
 * A create answers with the group AND an optional `warning` — another live
 * group already serves that language — for the screen to show next to the
 * saved row. The write is not refused; see `languageWarning` for why.
 */
import { NextResponse } from 'next/server';
import { groupCreateSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { createGroup, listGroups } from '@/lib/config/groups';

export const GET = guarded(async (req, principal) => {
  const q = new URL(req.url).searchParams.get('includeDeleted');
  const groups = await listGroups(principal, { includeDeleted: q === '1' || q === 'true' });
  return NextResponse.json({ groups });
});

export const POST = guarded(async (req, principal) => {
  const input = await parseBody(req, groupCreateSchema);
  const result = await createGroup(principal, input);
  return NextResponse.json(result, { status: 201 });
});
