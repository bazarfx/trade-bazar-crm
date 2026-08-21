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
import { guarded, parseBody } from '@/lib/api';
import { createWebhookSource, listWebhookSources } from '@/lib/intake/sources';

/**
 * The origin a platform will reach this server on. Behind a proxy the
 * forwarded headers carry the public host; bare, the request URL does. The
 * token is appended by the service, so this only ever names the host.
 */
function publicOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? url.protocol.replace(':', '');
  const host = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ?? req.headers.get('host') ?? url.host;
  return `${proto}://${host}`;
}

export const GET = guarded(async (_req, principal) => {
  const sources = await listWebhookSources(principal);
  return NextResponse.json({ sources });
});

export const POST = guarded(async (req, principal) => {
  const input = await parseBody(req, webhookSourceCreateSchema);
  const created = await createWebhookSource(principal, input, publicOrigin(req));
  return NextResponse.json(created, { status: 201 });
});
