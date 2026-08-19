/**
 * Thin adapter. Undoing a create runs the forward-path delete, which may need
 * the same answers that delete needs — a replacement status, or confirmation
 * past the dependency scan — so the body carries them through.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guarded } from '@/lib/api';
import { revertConfigChange } from '@/lib/config/revert';

const revertOptionsSchema = z
  .object({
    replacementStatusId: z.string().uuid().optional(),
    confirmed: z.boolean().optional(),
  })
  .default({});

export const POST = guarded<{ changeId: string }>(async (req, principal, { changeId }) => {
  // The body is optional: most reverts need nothing.
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    // no body — fall through with {}
  }
  const opts = revertOptionsSchema.parse(raw ?? {});

  await revertConfigChange(principal, changeId, opts);
  return NextResponse.json({ ok: true });
});
