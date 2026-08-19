/**
 * Field definitions of one module. GET serves every authenticated user (the
 * form renderer and list views need it); the mutation asserts its permission
 * inside the config service, never here — a route cannot forget a check it
 * does not own.
 */
import { NextResponse } from 'next/server';
import { fieldCreateSchema, type FieldCreateInput } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { createField, listFields } from '@/lib/config/fields';

export const GET = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  const q = new URL(req.url).searchParams.get('includeDeleted');
  const fields = await listFields(principal, slug, { includeDeleted: q === '1' || q === 'true' });
  return NextResponse.json({ fields });
});

export const POST = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  // The schema carries .default()s, so its INPUT type has optional flags and
  // parseBody's ZodType<T> infers that looser shape. parse() applies the
  // defaults, so the runtime value IS the output type — the cast is honest.
  const input = (await parseBody(req, fieldCreateSchema)) as FieldCreateInput;
  const { field, warning } = await createField(principal, slug, input);
  // JSON.stringify drops an undefined warning, so the happy path stays clean.
  return NextResponse.json({ field, warning }, { status: 201 });
});
