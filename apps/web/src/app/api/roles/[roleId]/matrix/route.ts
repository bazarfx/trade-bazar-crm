/**
 * The permission grid for one role. GET returns every ENABLED module — with
 * or without a stored row — so the editor renders a complete grid and never
 * invents a default; PUT saves the whole grid as one change.
 */
import { NextResponse } from 'next/server';
import { permissionMatrixSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { getRoleMatrix, saveMatrix } from '@/lib/config/roles';

type Params = { roleId: string };

export const GET = guarded<Params>(async (_req, principal, { roleId }) => {
  const { role, modules, specials } = await getRoleMatrix(principal, roleId);
  return NextResponse.json({ role, modules, specials });
});

export const PUT = guarded<Params>(async (req, principal, { roleId }) => {
  const input = await parseBody(req, permissionMatrixSchema);
  await saveMatrix(principal, roleId, input);
  return NextResponse.json({ ok: true });
});
