/** One ARK event with its whole payload — what the list truncated. */
import { NextResponse } from 'next/server';
import { guarded } from '@/lib/api';
import { getArkEvent } from '@/lib/ark/sources';

type Params = { sourceId: string; eventId: string };

export const GET = guarded<Params>(async (_req, principal, { sourceId, eventId }) => {
  const event = await getArkEvent(principal, sourceId, eventId);
  return NextResponse.json({ event });
});
