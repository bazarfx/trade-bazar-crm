/**
 * Thin adapter: parse -> lib -> serialise.
 *
 * POST rather than PATCH on the collection member, because activation is an
 * operation and not a field edit: it trips the last-admin guardrail, revokes
 * every live session, and answers with `ownedOpenRecords` so the caller can
 * prompt for a reassignment target (spec §5.5).
 */
import { NextResponse } from 'next/server';
import { userSetActiveSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { setUserActive } from '@/lib/config/users';

type Params = { userId: string };

export const POST = guarded<Params>(async (req, principal, { userId }) => {
  const { isActive } = await parseBody(req, userSetActiveSchema);
  const result = await setUserActive(principal, userId, isActive);
  return NextResponse.json(result);
});
