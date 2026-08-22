/**
 * Webhook sources — list and create.
 *
 * Thin adapters. The MANAGE_CAMPAIGNS gate, the token generation, the change
 * log entry and the slug all live in `lib/intake/sources`. The one thing a
 * route knows that the service does not is the public origin of the request,
 * which the create response needs to print the full intake URL — once.
 */
import { NextResponse } from 'next/server';
import { webhookSourceCreateSchema } from '@crm/shared';
import { guarded, parseBody, publicOrigin } from '@/lib/api';
import { createWebhookSource, listWebhookSources } from '@/lib/intake/sources';

export const GET = guarded(async (_req, principal) => {
  const sources = await listWebhookSources(principal);
  return NextResponse.json({ sources });
});

export const POST = guarded(async (req, principal) => {
  const input = await parseBody(req, webhookSourceCreateSchema);
  const created = await createWebhookSource(principal, input, publicOrigin(req));
  return NextResponse.json(created, { status: 201 });
});
