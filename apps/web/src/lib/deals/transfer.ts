/**
 * Transfer of Deal Owner from the web side (spec §7.1).
 *
 * The rule lives in `transferDealOwnership` (`@crm/records`): the
 * TRANSFER_DEAL_OWNERSHIP check, the scoped load, the active-target proof,
 * the owner-column-only write and the OWNERSHIP_TRANSFERRED entry. This file
 * adds the two things a route needs around it and nothing more:
 *
 *  - proof that the module in the URL is one whose records are HANDED OVER
 *    at all, read off the storage shape (`closedByColumn`) and never off the
 *    slug — a transfer posted against a module with no Closed By is a 422,
 *    not a silent lookup in some other table;
 *  - the record re-read through the same scoped `getRecord` the detail page
 *    uses, so the response carries exactly what that page will redraw.
 */
import 'server-only';
import type { TransferOwnershipInput } from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import type { AuditMeta } from '@/lib/records/service';
import { ConfigError } from '@/lib/config/service';
import { getRecord, moduleContext, transferDealOwnership, type RecordRow } from '@/lib/records/service';

export async function transferRecordOwner(
  principal: Principal,
  moduleSlug: string,
  recordId: string,
  input: TransferOwnershipInput,
  meta: AuditMeta = {},
): Promise<RecordRow> {
  const ctx = await moduleContext(principal, moduleSlug);
  if (ctx.storage.shape.closedByColumn === null) {
    throw new ConfigError(
      'Records in this module are reassigned, not handed over — use the assign action',
      422,
      'GUARDRAIL',
    );
  }

  await transferDealOwnership(principal, { dealId: recordId, ...input }, meta);
  return getRecord(principal, moduleSlug, recordId);
}
