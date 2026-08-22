/**
 * One record's deposit ledger (spec §8.3).
 *
 * Thin adapter over `lib/deals/deposits`, which reads the parent through the
 * scoped record read BEFORE touching the ledger — a deal this actor may not
 * see is a 404 here too, and so is a module whose storage keeps no ledger.
 * That second 404 is how the detail screen learns whether to draw the panel.
 */
import { NextResponse } from 'next/server';
import { guarded } from '@/lib/api';
import { listDeposits } from '@/lib/deals/deposits';

type Params = { slug: string; recordId: string };

export const GET = guarded<Params>(async (_req, principal, { slug, recordId }) => {
  const ledger = await listDeposits(principal, slug, recordId);
  return NextResponse.json(ledger);
});
