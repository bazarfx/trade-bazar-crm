/**
 * ARK sources — list and create.
 *
 * Thin adapters. The MANAGE_CAMPAIGNS gate, the token generation, the change
 * log entry and the slug all live in `lib/ark/sources`. The one thing a route
 * knows that the service does not is the public origin of the request, which
 * the create response needs to print the full receiver URL — once.
 */
import { NextResponse } from 'next/server';
import { arkSourceCreateSchema } from '@crm/shared';
import { guarded, parseBody, publicOrigin } from '@/lib/api';
import { createArkSource, listArkSources } from '@/lib/ark/sources';

export const GET = guarded(async (_req, principal) => {
  const sources = await listArkSources(principal);
  return NextResponse.json({ sources });
});

export const POST = guarded(async (req, principal) => {
  const input = await parseBody(req, arkSourceCreateSchema);
  const created = await createArkSource(principal, input, publicOrigin(req));
  return NextResponse.json(created, { status: 201 });
});
