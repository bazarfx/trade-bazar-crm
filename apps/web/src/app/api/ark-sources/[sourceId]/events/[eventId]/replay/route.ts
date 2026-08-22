/**
 * Replay one FAILED, IGNORED or PROCESSED ARK event through the current
 * mapping.
 *
 * The other half of "persist raw first": the stored body is re-queued as-is,
 * and the worker settles it to PROCESSED or back to FAILED with a fresh
 * reason. A PROCESSED event is safe to replay because the pipeline is
 * idempotent on the event id — see `replayArkEvent`. 202 because, like the
 * receiver itself, this only queues.
 */
import { NextResponse } from 'next/server';
import { guarded } from '@/lib/api';
import { replayArkEvent } from '@/lib/ark/sources';

type Params = { sourceId: string; eventId: string };

export const POST = guarded<Params>(async (_req, principal, { sourceId, eventId }) => {
  const event = await replayArkEvent(principal, sourceId, eventId);
  return NextResponse.json({ ok: true, event }, { status: 202 });
});
