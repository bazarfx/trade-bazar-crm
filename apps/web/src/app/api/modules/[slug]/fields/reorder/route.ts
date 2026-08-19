/**
 * Drag-and-drop field ordering: one POST, one REORDER entry in
 * ConfigChangeLog. The array index is the new displayOrder.
 */
import { NextResponse } from 'next/server';
import { reorderSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { reorderFields } from '@/lib/config/fields';

export const POST = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  const input = await parseBody(req, reorderSchema);
  await reorderFields(principal, slug, input);
  return NextResponse.json({ ok: true });
});
