/**
 * A record's timeline.
 *
 * This serves `AuditLog`, rendered per record — there is no timeline store to
 * read from (invariant 2). Cursor-paginated because a worked lead accumulates
 * an entry per field edit and the detail page opens with the newest page.
 */
import { NextResponse } from 'next/server';
import { guarded } from '@/lib/api';
import { getTimeline } from '@/lib/records/service';

type Params = { slug: string; recordId: string };

export const GET = guarded<Params>(async (req, principal, { slug, recordId }) => {
  const params = new URL(req.url).searchParams;
  const rawTake = Number(params.get('take'));
  const { entries, nextCursor } = await getTimeline(principal, slug, recordId, {
    // The service clamps; this only decides whether a take was asked for.
    take: Number.isInteger(rawTake) && rawTake > 0 ? rawTake : undefined,
    cursor: params.get('cursor'),
  });
  return NextResponse.json({ entries, nextCursor });
});
