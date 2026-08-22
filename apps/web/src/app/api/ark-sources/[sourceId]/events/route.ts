/**
 * One ARK source's event log, paginated, newest first.
 *
 * `?status=` narrows to one `WebhookStatus`, `?outcome=` to one of spec §7's
 * outcomes (every row carries the outcome it took); `?page=` is 1-based.
 * Payloads over the preview ceiling travel truncated — the single-event route
 * carries the whole body.
 */
import { NextResponse } from 'next/server';
import { arkOutcomeSchema, webhookStatusSchema } from '@crm/shared';
import { guarded } from '@/lib/api';
import { listArkEvents } from '@/lib/ark/sources';
import { ConfigError } from '@/lib/config/service';

type Params = { sourceId: string };

export const GET = guarded<Params>(async (req, principal, { sourceId }) => {
  const params = new URL(req.url).searchParams;

  // An unknown status or outcome throws rather than defaulting: a typo that
  // silently became "everything" would answer a different question.
  const rawStatus = params.get('status');
  const status = rawStatus === null || rawStatus === '' ? undefined : webhookStatusSchema.parse(rawStatus);

  const rawOutcome = params.get('outcome');
  const outcome = rawOutcome === null || rawOutcome === '' ? undefined : arkOutcomeSchema.parse(rawOutcome);

  const rawPage = params.get('page');
  const page = rawPage === null ? 1 : Number.parseInt(rawPage, 10);
  if (!Number.isInteger(page) || page < 1) {
    throw new ConfigError('page must be a positive integer', 400, 'VALIDATION');
  }

  const result = await listArkEvents(principal, sourceId, {
    ...(status === undefined ? {} : { status }),
    ...(outcome === undefined ? {} : { outcome }),
    page,
  });
  return NextResponse.json(result);
});
