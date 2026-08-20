/**
 * Saved views of one module — the listing and the save.
 *
 * Thin adapter: parse, call, serialise. Who may publish a view, who may pin a
 * role default and what a filter tree is allowed to contain all live in
 * `@/lib/config/views` and `packages/shared/views.ts`, so this file cannot
 * disagree with the next caller.
 */
import { NextResponse } from 'next/server';
import { viewCreateSchema } from '@crm/shared';
import { guarded, parseBody } from '@/lib/api';
import { createView, listViews } from '@/lib/config/views';

export const GET = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  // Live match counts are OPT-IN: they are one aggregate per view, and the
  // filter rail wants them while a "move this record to a view" picker does
  // not. The default stays the cheap answer.
  const withCounts = new URL(req.url).searchParams.get('counts') === '1';
  const views = await listViews(principal, slug, { withCounts });
  return NextResponse.json({ views });
});

export const POST = guarded<{ slug: string }>(async (req, principal, { slug }) => {
  const input = await parseBody(req, viewCreateSchema);
  const view = await createView(principal, slug, input);
  return NextResponse.json({ view }, { status: 201 });
});
