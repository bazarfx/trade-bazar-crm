/**
 * Thin adapter. POST rather than PATCH because a restore is an operation, not
 * a field edit.
 */
import { NextResponse } from 'next/server';
import { guarded } from '@/lib/api';
import { restoreDepartment } from '@/lib/config/departments';

export const POST = guarded<{ departmentId: string }>(async (_req, principal, { departmentId }) => {
  const department = await restoreDepartment(principal, departmentId);
  return NextResponse.json({ department });
});
