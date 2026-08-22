/**
 * One ARK source — read, and the edit that matters: the payload mapping.
 *
 * PATCH is how the Admin fills in THE SPACE left for ARK: the body carries
 * `mapping` (validated by `arkMappingSchema`, the same contract the worker
 * parses with), a rename, or `isActive` to pause. Every variant is one
 * ConfigChangeLog entry with before/after, via the service.
 */
import { NextResponse } from 'next/server';
import { arkSourceUpdateSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { getArkSource, updateArkSource } from '@/lib/ark/sources';

type Params = { sourceId: string };

export const GET = guarded<Params>(async (_req, principal, { sourceId }) => {
  const source = await getArkSource(principal, sourceId);
  return NextResponse.json({ source });
});

export const PATCH = guarded<Params>(async (req, principal, { sourceId }) => {
  const input = await parseBody(req, arkSourceUpdateSchema);
  const source = await updateArkSource(principal, sourceId, input);
  return NextResponse.json({ source });
});
