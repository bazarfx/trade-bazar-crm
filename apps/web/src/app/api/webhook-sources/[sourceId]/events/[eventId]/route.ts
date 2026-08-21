/** One event with its whole payload — what the list truncated. */
import { NextResponse } from 'next/server';
import { guarded } from '@/lib/api';
import { getWebhookEvent } from '@/lib/intake/sources';

type Params = { sourceId: string; eventId: string };

export const GET = guarded<Params>(async (_req, principal, { sourceId, eventId }) => {
  const event = await getWebhookEvent(principal, sourceId, eventId);
  return NextResponse.json({ event });
});
