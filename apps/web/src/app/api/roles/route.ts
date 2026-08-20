/**
 * Thin adapter: parse -> lib -> serialise. All behaviour lives in
 * `@/lib/config/roles`; permissions are asserted there and again in the config
 * service, so this file can hold no decision of its own.
 */
import { NextResponse } from 'next/server';
import { roleCreateSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { listRoles as listRoleOptions } from '@/lib/config/catalog';
import { canManageRoles, createRole, listRoles } from '@/lib/config/roles';

export const GET = guarded(async (_req, principal) => {
  // Two consumers, two needs. The roles screen wants the counts and is gated
  // on MANAGE_USERS_ROLES; the layout editor's role picker needs only
  // id/name/isLocked and belongs to a MANAGE_FIELDS_LAYOUTS holder who
  // administers no users. Serving that caller the narrower list keeps their
  // picker alive without widening what the roles screen hands out.
  const roles = canManageRoles(principal)
    ? await listRoles(principal)
    : await listRoleOptions(principal);
  return NextResponse.json({ roles });
});

export const POST = guarded(async (req, principal) => {
  const input = await parseBody(req, roleCreateSchema);
  const role = await createRole(principal, input);
  return NextResponse.json({ role }, { status: 201 });
});
