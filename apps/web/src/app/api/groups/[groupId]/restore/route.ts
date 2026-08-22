/**
 * Thin adapter. POST rather than PATCH because a restore is an operation, not
 * a field edit: it brings a retired team back, members and all.
 */
import { NextResponse } from 'next/server';
import { guarded } from '@/lib/api';
import { restoreGroup } from '@/lib/config/groups';

export const POST = guarded<{ groupId: string }>(async (_req, principal, { groupId }) => {
  const result = await restoreGroup(principal, groupId);
  return NextResponse.json(result);
});
