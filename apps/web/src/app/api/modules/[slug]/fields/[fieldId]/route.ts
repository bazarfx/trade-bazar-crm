/**
 * One field: reshape or retire. DELETE is a two-step confirm — the first call
 * without ?confirmed=1 returns 409 DEPENDENCIES listing every saved view,
 * layout and import preset the field still feeds, so the Admin deletes with
 * eyes open (spec §13). The delete itself is soft, always.
 */
import { NextResponse } from 'next/server';
import { fieldUpdateSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { softDeleteField, updateField } from '@/lib/config/fields';

export const PATCH = guarded<{ slug: string; fieldId: string }>(
  async (req, principal, { slug, fieldId }) => {
    const input = await parseBody(req, fieldUpdateSchema);
    const field = await updateField(principal, slug, fieldId, input);
    return NextResponse.json({ field });
  },
);

export const DELETE = guarded<{ slug: string; fieldId: string }>(
  async (req, principal, { slug, fieldId }) => {
    const q = new URL(req.url).searchParams.get('confirmed');
    await softDeleteField(principal, slug, fieldId, { confirmed: q === '1' || q === 'true' });
    return NextResponse.json({ ok: true });
  },
);
