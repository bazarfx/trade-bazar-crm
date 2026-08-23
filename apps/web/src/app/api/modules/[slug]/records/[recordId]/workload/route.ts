/**
 * One person's workload: everything they own, and everything they closed.
 *
 * Thin adapter over `lib/records/workload`. Both gates live there, not here:
 *
 *  1. `assertPeopleModule` refuses any module whose rows do not live in the
 *     people table — asking a lead for its workload is a 404. It compares
 *     DELEGATES, never slugs, so renaming the module changes nothing and a
 *     module an Admin invents tomorrow is judged by the same rule.
 *  2. `personWorkload` reads the person through the ordinary scoped record
 *     read first, so a person this actor may not see is a 404 here exactly
 *     as they are on the record page — and every number underneath goes
 *     through the same scope filter as the list screen.
 */
import { NextResponse } from 'next/server';
import { guarded } from '@/lib/api';
import { assertPeopleModule, personWorkload } from '@/lib/records/workload';

type Params = { slug: string; recordId: string };

export const GET = guarded<Params>(async (_req, principal, { slug, recordId }) => {
  await assertPeopleModule(slug);
  const workload = await personWorkload(principal, recordId);
  return NextResponse.json({ workload });
});
