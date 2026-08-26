/**
 * Thin adapter: parse -> lib -> serialise. All behaviour lives in
 * `@/lib/ark/sources`; the permission gate and the audit entry are asserted
 * there, so this file holds no decision of its own.
 *
 * Its OWN route because a signing secret is a credential, not configuration:
 * it must not ride along in the payload that `PATCH /api/ark-sources/<id>`
 * snapshots into the append-only change log. The response carries the
 * source's new state — including whether a secret is now set — but never the
 * secret, which nothing can read back.
 */
import { NextResponse } from 'next/server';
import { arkSigningSecretSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { setArkSigningSecret } from '@/lib/ark/sources';

type Params = { sourceId: string };

export const PUT = guarded<Params>(async (req, principal, { sourceId }) => {
  const input = await parseBody(req, arkSigningSecretSchema);
  const source = await setArkSigningSecret(principal, sourceId, input.signingSecret);
  return NextResponse.json({ source });
});
