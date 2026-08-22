/**
 * The team roster (spec §5.3: "add/remove member controls").
 *
 * POST adds, DELETE removes — both take `groupMembersSchema` and both answer
 * with the roster as it now stands, so the screen re-renders from the
 * response rather than guessing. Both are idempotent in the service: adding
 * a member twice or removing a non-member is a no-op, never an error.
 */
import { NextResponse } from 'next/server';
import { groupMembersSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { addMembers, listMembers, removeMembers } from '@/lib/config/groups';

type Params = { groupId: string };

export const GET = guarded<Params>(async (_req, principal, { groupId }) => {
  const members = await listMembers(principal, groupId);
  return NextResponse.json({ members });
});

export const POST = guarded<Params>(async (req, principal, { groupId }) => {
  const { userIds } = await parseBody(req, groupMembersSchema);
  const members = await addMembers(principal, groupId, userIds);
  return NextResponse.json({ members });
});

export const DELETE = guarded<Params>(async (req, principal, { groupId }) => {
  const { userIds } = await parseBody(req, groupMembersSchema);
  const members = await removeMembers(principal, groupId, userIds);
  return NextResponse.json({ members });
});
