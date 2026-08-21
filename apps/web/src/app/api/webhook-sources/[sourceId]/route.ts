/**
 * One webhook source — read, and the edit that matters: the payload mapping.
 *
 * PATCH is how the Admin fills in THE SPACE left for Integrately: the body
 * carries `mapping` (validated by `intakeMappingSchema`, the same contract the
 * worker parses with), `defaults`, a rename, or `isActive` to pause. Every
 * variant is one ConfigChangeLog entry with before/after, via the service.
 */
import { NextResponse } from 'next/server';
import { webhookSourceUpdateSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { getWebhookSource, updateWebhookSource } from '@/lib/intake/sources';

type Params = { sourceId: string };

export const GET = guarded<Params>(async (_req, principal, { sourceId }) => {
  const source = await getWebhookSource(principal, sourceId);
  return NextResponse.json({ source });
});

export const PATCH = guarded<Params>(async (req, principal, { sourceId }) => {
  const input = await parseBody(req, webhookSourceUpdateSchema);
  const source = await updateWebhookSource(principal, sourceId, input);
  return NextResponse.json({ source });
});
