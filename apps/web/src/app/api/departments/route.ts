/**
 * Thin adapter: parse -> lib -> serialise. All behaviour lives in
 * `@/lib/config/departments`; the read gate and the write gate are asserted
 * there, so this file holds no decision of its own.
 */
import { NextResponse } from 'next/server';
import { departmentCreateSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { createDepartment, listDepartments } from '@/lib/config/departments';

export const GET = guarded(async (req, principal) => {
  const q = new URL(req.url).searchParams.get('includeDeleted');
  const departments = await listDepartments(principal, { includeDeleted: q === '1' || q === 'true' });
  return NextResponse.json({ departments });
});

export const POST = guarded(async (req, principal) => {
  const input = await parseBody(req, departmentCreateSchema);
  const department = await createDepartment(principal, input);
  return NextResponse.json({ department }, { status: 201 });
});
