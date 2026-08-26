/**
 * Thin adapter: parse -> lib -> serialise. All behaviour lives in
 * `@/lib/config/users`: the MANAGE_USERS_ROLES gate, the PASSWORD_RESET audit
 * entry (with no diff — a credential never enters the append-only log) and the
 * session revocation are all asserted there.
 *
 * The response echoes the plaintext ONCE, for the Admin to hand to the user.
 * Nothing stores it and no later read can recover it — only the bcrypt hash
 * survives the request.
 */
import { NextResponse } from 'next/server';
import { userSetPasswordSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { resetUserPassword } from '@/lib/config/users';

type Params = { userId: string };

export const POST = guarded<Params>(async (req, principal, { userId }) => {
  const input = await parseBody(req, userSetPasswordSchema);
  const result = await resetUserPassword(principal, userId, input.password);
  return NextResponse.json(result);
});
