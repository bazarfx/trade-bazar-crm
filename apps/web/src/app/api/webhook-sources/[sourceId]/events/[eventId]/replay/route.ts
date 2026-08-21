/**
 * Replay one FAILED or IGNORED event through the current mapping.
 *
 * The other half of "persist raw first": the stored body is re-queued as-is,
 * and the worker settles it to PROCESSED or back to FAILED with a fresh
 * reason. 202 because, like the intake endpoint itself, this only queues.
 */
import { NextResponse } from 'next/server';
import { guarded } from '@/lib/api';
import { replayWebhookEvent } from '@/lib/intake/sources';

type Params = { sourceId: string; eventId: string };

export const POST = guarded<Params>(async (_req, principal, { sourceId, eventId }) => {
  const event = await replayWebhookEvent(principal, sourceId, eventId);
  return NextResponse.json({ ok: true, event }, { status: 202 });
});
