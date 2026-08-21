/**
 * Thin adapter: parse -> lib -> serialise.
 *
 * POST rather than PATCH on the collection member, because activation is an
 * operation and not a field edit: it trips the last-admin guardrail, revokes
 * every live session, and HANDS OVER the user's open records (spec §5.5).
 *
 * The handover is why the payload carries `reassignToUserId`. Called without
 * one for a user who still owns open work, the service answers 409 with
 * `{ ownedOpenRecords }` — that is the reassignment prompt — and the caller
 * posts again with a target. Both halves then commit in one transaction, so
 * there is no moment in which a deactivated user owns live work.
 */
import { NextResponse } from 'next/server';
import { userSetActiveSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { setUserActive } from '@/lib/config/users';

type Params = { userId: string };

export const POST = guarded<Params>(async (req, principal, { userId }) => {
  const { isActive, reassignToUserId } = await parseBody(req, userSetActiveSchema);
  const result = await setUserActive(principal, userId, isActive, reassignToUserId);
  return NextResponse.json(result);
});
