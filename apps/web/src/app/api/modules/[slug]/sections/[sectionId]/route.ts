import { NextResponse } from 'next/server';
import { sectionUpdateSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { softDeleteSection, updateSection } from '@/lib/config/sections';

type Params = { slug: string; sectionId: string };

export const PATCH = guarded<Params>(async (req, principal, { slug, sectionId }) => {
  const input = await parseBody(req, sectionUpdateSchema);
  const section = await updateSection(principal, slug, sectionId, input);
  return NextResponse.json({ section });
});

export const DELETE = guarded<Params>(async (_req, principal, { slug, sectionId }) => {
  await softDeleteSection(principal, slug, sectionId);
  return NextResponse.json({ ok: true });
});
