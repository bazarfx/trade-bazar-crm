/**
 * One role: rename or retire. The delete is soft and refuses to strand people
 * — a role held by users needs a reassignment target, and the 409 carries the
 * count so the UI can say how many before it asks.
 */
import { NextResponse } from 'next/server';
import { roleDeleteSchema, roleUpdateSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { deleteRole, updateRole } from '@/lib/config/roles';

type Params = { roleId: string };

export const PATCH = guarded<Params>(async (req, principal, { roleId }) => {
  const input = await parseBody(req, roleUpdateSchema);
  const role = await updateRole(principal, roleId, input);
  return NextResponse.json({ role });
});

export const DELETE = guarded<Params>(async (req, principal, { roleId }) => {
  // DELETE carries an OPTIONAL JSON body (the reassignment target). Many
  // clients send none at all, so an absent or malformed body must read as
  // "no target chosen" — the holder check then answers with the 409.
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    // no body — fall through with {}
  }
  const input = roleDeleteSchema.parse(raw);
  await deleteRole(principal, roleId, input);
  return NextResponse.json({ ok: true });
});
