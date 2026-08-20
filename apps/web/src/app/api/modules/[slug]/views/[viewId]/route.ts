/**
 * One saved view — read, edit, delete.
 *
 * Thin adapter: parse -> lib -> serialise. Ownership (only the owner or an
 * Admin may write), the config gate on publishing and role defaults, and the
 * "not visible and not existing answer alike" rule are all asserted in
 * `@/lib/config/views`, never here.
 */
import { NextResponse } from 'next/server';
import { viewUpdateSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { deleteView, getView, updateView } from '@/lib/config/views';

type Params = { slug: string; viewId: string };

export const GET = guarded<Params>(async (_req, principal, { slug, viewId }) => {
  const view = await getView(principal, slug, viewId);
  return NextResponse.json({ view });
});

export const PATCH = guarded<Params>(async (req, principal, { slug, viewId }) => {
  const input = await parseBody(req, viewUpdateSchema);
  const view = await updateView(principal, slug, viewId, input);
  return NextResponse.json({ view });
});

export const DELETE = guarded<Params>(async (_req, principal, { slug, viewId }) => {
  // A saved view is a kept query, not data — the delete is hard, and
  // `deleteView` says why. It carries no body.
  const result = await deleteView(principal, slug, viewId);
  return NextResponse.json(result);
});
