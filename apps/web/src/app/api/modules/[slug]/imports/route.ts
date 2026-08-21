/**
 * Upload (stage 1) and the list of previous imports.
 *
 * Thin adapter. The parse, the auto-mapping, the permission gate and the
 * staging INSERTs all live in `@/lib/imports/service` — this file only pulls a
 * file and four strings out of a multipart body.
 *
 * The upload is multipart rather than JSON because a 20 MB spreadsheet
 * base64-encoded into a JSON string is 27 MB of memory to say the same thing.
 * Everything except the bytes still travels through the shared schema.
 */
import { NextResponse } from 'next/server';
import { importCreateSchema } from '@crm/shared';
import { guarded } from '@/lib/api';
import { ConfigError } from '@/lib/config/service';
import { listImportBatches, stageImport } from '@/lib/imports/service';

type Params = { slug: string };

/** A form field as a string, or undefined so the schema's default applies. */
function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export const GET = guarded<Params>(async (_req, principal, { slug }) => {
  const batches = await listImportBatches(principal, slug);
  return NextResponse.json({ batches });
});

export const POST = guarded<Params>(async (req, principal, { slug }) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ConfigError('Expected a file upload', 400, 'VALIDATION');
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    throw new ConfigError('No file was uploaded', 400, 'VALIDATION');
  }

  const input = importCreateSchema.parse({
    moduleSlug: slug,
    // The browser's own filename unless the wizard renamed it; it is what the
    // error report has to say back to the user later.
    filename: field(form, 'filename') ?? file.name,
    charset: field(form, 'charset'),
    action: field(form, 'action'),
    dedupeKey: field(form, 'dedupeKey'),
  });

  const staged = await stageImport(principal, slug, { ...input, file });
  return NextResponse.json(staged, { status: 201 });
});
