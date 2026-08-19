/**
 * Thin adapter: parse -> lib -> serialise. One REORDER config change for the
 * whole permutation, logged against the module.
 */
import { NextResponse } from 'next/server';
import { reorderSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { reorderStatuses } from '@/lib/config/statuses';

export const POST = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  const input = await parseBody(req, reorderSchema);
  const statuses = await reorderStatuses(principal, slug, input);
  return NextResponse.json({ statuses });
});
