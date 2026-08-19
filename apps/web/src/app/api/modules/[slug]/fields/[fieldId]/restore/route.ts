/**
 * Undo a field deletion. Always safe: a deleted field's key stays reserved
 * (the unique index spans soft-deleted rows), so restore cannot collide.
 */
import { NextResponse } from 'next/server';
import { guarded } from '@/lib/api';
import { restoreField } from '@/lib/config/fields';

export const POST = guarded<{ slug: string; fieldId: string }>(
  async (_req, principal, { slug, fieldId }) => {
    const field = await restoreField(principal, slug, fieldId);
    return NextResponse.json({ field });
  },
);
