import { z } from 'zod';

/**
 * Manual and bulk reassignment payloads (spec §6.4, §6.7).
 *
 * Defined here so the list screen's bulk bar, the record header's owner
 * control, the route handler and any future importer or CLI agree on what a
 * reassignment is. Nothing in this file names a module: reassignment is a
 * property of any record whose table carries an owner, and the slug travels in
 * the URL.
 *
 * Ids only — never a name, never an email. A user is a row the Admin creates
 * and renames; the id is the only stable handle.
 */

/**
 * Ceiling on one bulk reassignment.
 *
 * The move and its per-record timeline entries must commit together
 * (invariant 2), so the whole batch is one interactive transaction on a
 * pooled, cross-region connection. Five hundred records is comfortably inside
 * that budget and is already far more than a floor manager selects by hand;
 * past it the honest answer is a background job, not a request that spends a
 * minute holding a connection and may still roll back. The cap is stated in
 * the schema so the client can disable the button rather than discover it in
 * a 400.
 */
export const BULK_ASSIGN_MAX = 500;

/** Single reassign: `POST /api/modules/{slug}/records/{recordId}/assign`. */
export const recordAssignSchema = z
  .object({ ownerId: z.string().uuid('Choose a user') })
  .strict();

export type RecordAssignInput = z.infer<typeof recordAssignSchema>;

/**
 * Bulk reassign: `POST /api/modules/{slug}/records/assign`.
 *
 * `.strict()` so a client that means to send `recordId` (singular) to the bulk
 * route is refused rather than silently reassigning nothing.
 */
export const recordBulkAssignSchema = z
  .object({
    recordIds: z
      .array(z.string().uuid())
      .min(1, 'Select at least one record')
      .max(BULK_ASSIGN_MAX, `Select at most ${BULK_ASSIGN_MAX} records`),
    ownerId: z.string().uuid('Choose a user'),
  })
  .strict();

export type RecordBulkAssignInput = z.infer<typeof recordBulkAssignSchema>;

/**
 * What a bulk reassignment did.
 *
 * `skipped` is not an error and is never silent: records outside the actor's
 * view scope are excluded rather than refused — a 403 naming them would
 * confirm that they exist — so the count is how the UI stays honest about a
 * selection that spanned more than the actor can see.
 */
export interface BulkAssignResult {
  updated: number;
  skipped: number;
}
