/**
 * One source's event log, paginated, newest first.
 *
 * `?status=` narrows to one `WebhookStatus`; `?page=` is 1-based. Payloads
 * over the preview ceiling travel truncated — the single-event route carries
 * the whole body.
 */
import { NextResponse } from 'next/server';
import { webhookStatusSchema } from '@crm/shared';
import { guarded } from '@/lib/api';
import { ConfigError } from '@/lib/config/service';
import { listWebhookEvents } from '@/lib/intake/sources';

type Params = { sourceId: string };

export const GET = guarded<Params>(async (req, principal, { sourceId }) => {
  const params = new URL(req.url).searchParams;

  // An unknown status throws rather than defaulting: a typo that silently
  // became "everything" would answer a different question than the one asked.
  const rawStatus = params.get('status');
  const status = rawStatus === null || rawStatus === '' ? undefined : webhookStatusSchema.parse(rawStatus);

  const rawPage = params.get('page');
  const page = rawPage === null ? 1 : Number.parseInt(rawPage, 10);
  if (!Number.isInteger(page) || page < 1) {
    throw new ConfigError('page must be a positive integer', 400, 'VALIDATION');
  }

  const result = await listWebhookEvents(principal, sourceId, {
    ...(status === undefined ? {} : { status }),
    page,
  });
  return NextResponse.json(result);
});
