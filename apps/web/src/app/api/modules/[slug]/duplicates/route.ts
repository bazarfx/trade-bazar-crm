/**
 * The duplicate review queue for one module (spec §6.6).
 *
 * Thin adapter. The edit-permission gate, the scoped load of both sides of
 * every pair and the hidden-field strip all live in `lib/intake/duplicates` —
 * a route cannot forget a check it does not own.
 */
import { NextResponse } from 'next/server';
import { duplicateStatusSchema } from '@crm/shared';
import { guarded } from '@/lib/api';
import { ConfigError } from '@/lib/config/service';
import { listDuplicateFlags } from '@/lib/intake/duplicates';

export const GET = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  const params = new URL(req.url).searchParams;

  // An unknown status throws rather than defaulting: a typo that silently
  // became PENDING would answer a different question than the one asked.
  const rawStatus = params.get('status');
  const status = rawStatus === null ? undefined : duplicateStatusSchema.parse(rawStatus);

  const rawPage = params.get('page');
  const page = rawPage === null ? 1 : Number.parseInt(rawPage, 10);
  if (!Number.isInteger(page) || page < 1) {
    throw new ConfigError('page must be a positive integer', 400, 'VALIDATION');
  }

  const result = await listDuplicateFlags(principal, slug, {
    ...(status === undefined ? {} : { status }),
    page,
  });
  return NextResponse.json(result);
});
