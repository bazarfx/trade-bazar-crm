/**
 * Thin adapter: parse -> lib -> serialise. All behaviour lives in
 * `@/lib/config/users`; the permission gate and every guardrail are asserted
 * there, so a route that forgot one still could not write.
 */
import { NextResponse } from 'next/server';
import { userUpdateSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { getUserAccount, updateUser } from '@/lib/config/users';

type Params = { userId: string };

/** The write-side read: the account as the manage-users edit form needs it —
 *  ids plus group membership. Gated on MANAGE_USERS_ROLES in the service. */
export const GET = guarded<Params>(async (_req, principal, { userId }) => {
  const user = await getUserAccount(principal, userId);
  return NextResponse.json({ user });
});

export const PATCH = guarded<Params>(async (req, principal, { userId }) => {
  const input = await parseBody(req, userUpdateSchema);
  const user = await updateUser(principal, userId, input);
  return NextResponse.json({ user });
});
