import { NextResponse } from 'next/server';
import { sectionCreateSchema, type SectionCreateInput } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { createSection, listSections } from '@/lib/config/sections';

export const GET = guarded<{ slug: string }>(async (_req, principal, { slug }) => {
  const sections = await listSections(principal, slug);
  return NextResponse.json({ sections });
});

export const POST = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  // parseBody's ZodType<T> infers the pre-default INPUT shape for schemas
  // carrying .default(); the runtime value already has defaults applied, so
  // this assertion only restates what schema.parse returned.
  const input = (await parseBody(req, sectionCreateSchema)) as SectionCreateInput;
  const section = await createSection(principal, slug, input);
  return NextResponse.json({ section }, { status: 201 });
});
