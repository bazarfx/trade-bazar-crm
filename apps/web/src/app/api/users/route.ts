/**
 * Thin adapter: parse -> lib -> serialise. All behaviour lives in
 * `@/lib/config/users`. The read is scoped in the repository and the write is
 * gated in the service, so this file holds no decision of its own.
 */
import { NextResponse } from 'next/server';
import { userCreateSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { createUser, listUsers } from '@/lib/config/users';

/** A positive integer from the query string, or undefined. Hand-edited URLs happen. */
function positiveInt(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export const GET = guarded(async (req, principal) => {
  const params = new URL(req.url).searchParams;
  const result = await listUsers(principal, {
    take: positiveInt(params.get('take')),
    skip: positiveInt(params.get('skip')),
  });
  return NextResponse.json(result);
});

export const POST = guarded(async (req, principal) => {
  const input = await parseBody(req, userCreateSchema);
  const user = await createUser(principal, input);
  return NextResponse.json({ user }, { status: 201 });
});
