import { NextResponse } from 'next/server';
import { reorderSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { reorderSections } from '@/lib/config/sections';

export const POST = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  const input = await parseBody(req, reorderSchema);
  const sections = await reorderSections(principal, slug, input);
  return NextResponse.json({ sections });
});
