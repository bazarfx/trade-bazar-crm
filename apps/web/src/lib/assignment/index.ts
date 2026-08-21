/**
 * The assignment engine, wired (spec §6.7).
 *
 * `LanguageRoundRobin` lives in `packages/core` and knows nothing about
 * Prisma, modules or settings. This file is the only place that hands it a
 * world: the ports over the database, the Admin's nominated pointers, and a
 * request built from whatever the record being created happens to carry.
 *
 * **Every path returns an owner.** Campaign-shaped records round-robin inside
 * the matching language group; ARK-stamped records round-robin among the
 * seniors of that language; anything neither claimed falls to the default
 * pool; and the last tier is the Admin. There is no null anywhere in this
 * file, and there must never be one — invariant 1 is not an aspiration, it is
 * a NOT NULL column.
 *
 * **Modules that carry none of this still work.** A module with no language
 * field and no source column asks with the empty string and the CAMPAIGN
 * default: no group matches the empty language, so the request falls straight
 * through the group tier to the pool and then to the Admin. That is the point
 * of putting the fall-through in the strategy rather than in the caller —
 * `records/service.ts` never has to know whether a module is lead-shaped, and
 * nothing branches on a slug.
 */
import 'server-only';
import { LanguageRoundRobin, type AssignmentRequest, type AssignmentResult } from '@crm/core';
import { getAssignmentSettings } from '@/lib/config/settings';
import type { Tx } from '@/lib/config/service';
import { PrismaAssignmentPorts } from '@/lib/assignment/ports';

export type { AssignmentResult };

/**
 * Why a record ended up where it did, as the timeline records it.
 *
 * The four automatic reasons come from the strategy; the two below are the
 * human ones. They are written into `AuditLog.changes` beside the owner
 * change, which is what lets a floor manager answer "why did this lead land
 * with Vikram" from the record itself rather than from a support ticket.
 */
export type AssignmentReason =
  | AssignmentResult['reason']
  /** a permitted user named the owner — on create, or through the reassign APIs */
  | 'manual'
  /** the owner was deactivated and their open work was handed over (spec §5.5) */
  | 'deactivation_handover';

/**
 * The key an assignment reason is written under in `AuditLog.changes`.
 *
 * Underscore-prefixed because every OTHER key in that object is a field key,
 * and an Admin can create a field labelled "Reason" — `fieldKeyFromLabel`
 * would key it `reason`, and the timeline would then render the engine's
 * explanation as a change to that field. No derived key can begin with an
 * underscore (`fieldKeyFromLabel` strips leading ones), so this one cannot
 * collide with a field that exists today or with one invented in 2027.
 */
export const ASSIGNMENT_REASON_KEY = '_reason';

export interface AssignmentInput {
  moduleSlug: string;
  /** the record's own language, or null/empty when the module has no such
   *  field — see the file header for what happens then */
  language?: string | null;
  /** the record's Source stamp. Anything that is not the ARK marker is
   *  campaign-shaped, including a module with no source column at all. */
  source?: string | null;
}

/**
 * Normalise a stored source value onto the two routes the strategy knows.
 *
 * Read as an OPAQUE MARKER, not as a label: `LeadSource` is a database enum
 * (spec §6.1, "a permanent, immutable Source stamp"), not an Admin-editable
 * status, so the comparison is against the enum member rather than against
 * anything a person can rename. Everything else — a campaign lead, a manually
 * created record, a module with no source at all — routes to the language
 * group, which is the behaviour spec §6.1 describes for every non-ARK arrival.
 */
function routeFor(source: string | null | undefined): AssignmentRequest['source'] {
  return source === 'ARK_TERMINAL' ? 'ARK_TERMINAL' : 'CAMPAIGN';
}

/**
 * Choose an owner for a record about to be written.
 *
 * Runs INSIDE the caller's transaction on purpose: `nextIndex` advances the
 * rota with a locking statement, so a create that rolls back also rolls back
 * the advance and nobody's turn is silently consumed by a failed insert.
 *
 * The settings read is deliberately outside that transaction (it is a read of
 * two rows that never participate in the write), and it cannot throw — an
 * absent or corrupt pointer resolves to null and the strategy degrades a tier.
 */
export async function assignOwner(tx: Tx, input: AssignmentInput): Promise<AssignmentResult> {
  const settings = await getAssignmentSettings();
  const strategy = new LanguageRoundRobin(new PrismaAssignmentPorts(tx, settings));

  return strategy.assign({
    moduleSlug: input.moduleSlug,
    language: (input.language ?? '').trim(),
    source: routeFor(input.source),
  });
}
