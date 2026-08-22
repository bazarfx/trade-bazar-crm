/**
 * One group: rename or re-point its language, or retire it.
 *
 * DELETE is a two-step confirm — without ?confirmed=1 a group that still has
 * active members answers 409 with `{ memberCount }` so the Admin retires it
 * with eyes open. The nominated default pool refuses outright (422). The
 * delete itself is soft, always, and keeps the membership for a restore.
 */
import { NextResponse } from 'next/server';
import { groupUpdateSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { softDeleteGroup, updateGroup } from '@/lib/config/groups';

type Params = { groupId: string };

export const PATCH = guarded<Params>(async (req, principal, { groupId }) => {
  const input = await parseBody(req, groupUpdateSchema);
  const result = await updateGroup(principal, groupId, input);
  return NextResponse.json(result);
});

export const DELETE = guarded<Params>(async (req, principal, { groupId }) => {
  const q = new URL(req.url).searchParams.get('confirmed');
  await softDeleteGroup(principal, groupId, { confirmed: q === '1' || q === 'true' });
  return NextResponse.json({ ok: true });
});
