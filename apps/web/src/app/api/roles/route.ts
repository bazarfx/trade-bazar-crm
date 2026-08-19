import { NextResponse } from 'next/server';
import { guarded } from '@/lib/api';
import { listRoles } from '@/lib/config/catalog';

export const GET = guarded(async (_req, principal) => {
  const roles = await listRoles(principal);
  return NextResponse.json({ roles });
});
