/**
 * Analytics for a record other records are attributed to (spec §9 — a
 * campaign's leads in, conversion rate, total deposited, cost per conversion).
 *
 * Thin adapter over `lib/campaigns/analytics`. A module nothing links to
 * answers `{ analytics: null }` — a 200, because the detail screen probes
 * this on every record and a 404 would log a console error per open. The
 * screen draws the panel only when the answer is non-null; it never asks
 * what the module is called. 404 remains what it means everywhere: the
 * record itself is missing or out of scope.
 */
import { NextResponse } from 'next/server';
import { guarded } from '@/lib/api';
import { campaignAnalytics } from '@/lib/campaigns/analytics';

type Params = { slug: string; recordId: string };

export const GET = guarded<Params>(async (_req, principal, { slug, recordId }) => {
  const analytics = await campaignAnalytics(principal, slug, recordId);
  return NextResponse.json({ analytics });
});
