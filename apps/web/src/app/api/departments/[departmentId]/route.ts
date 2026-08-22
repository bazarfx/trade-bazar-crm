/**
 * One department: rename or retire.
 *
 * DELETE is a two-step confirm — without ?confirmed=1 a department that still
 * has users answers 409 with `{ userCount }`. The delete is soft and never
 * detaches anyone: a restore brings the scope boundary straight back.
 */
import { NextResponse } from 'next/server';
import { departmentUpdateSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { softDeleteDepartment, updateDepartment } from '@/lib/config/departments';

type Params = { departmentId: string };

export const PATCH = guarded<Params>(async (req, principal, { departmentId }) => {
  const input = await parseBody(req, departmentUpdateSchema);
  const department = await updateDepartment(principal, departmentId, input);
  return NextResponse.json({ department });
});

export const DELETE = guarded<Params>(async (req, principal, { departmentId }) => {
  const q = new URL(req.url).searchParams.get('confirmed');
  await softDeleteDepartment(principal, departmentId, { confirmed: q === '1' || q === 'true' });
  return NextResponse.json({ ok: true });
});
