/**
 * Transfer of Deal Owner (spec §7.1): "Transferable any time by roles with
 * *Transfer deal ownership* — every transfer logged."
 *
 * Deliberately NOT `reassignRecord`. That function moves a LEAD between reps
 * under `REASSIGN_LEADS`; a deal's owner is who handles the CUSTOMER, a
 * different responsibility under a different special, and the log action is
 * its own (`OWNERSHIP_TRANSFERRED`) so a report can tell the two apart.
 *
 * Closed By is never touched here. The write below names the owner column
 * and nothing else; there is no code path in this file — or in the product
 * — that writes `closedByColumn` after conversion.
 */
import { prisma } from '@crm/db';
import {
  transferDealOwnershipInputSchema,
  type OwnershipTransferDto,
  type TransferDealOwnershipInput,
} from '@crm/shared';
import type { Principal } from '../principal.js';
import { ASSIGNMENT_REASON_KEY } from '../assignment/index.js';
import { auditWithin } from '../audit.js';
import { ConfigError } from '../config/service.js';
import { findRecordById } from '../records/list.js';
import {
  actorIdentity,
  assertAssignableOwner,
  delegateOrThrow,
  fieldForColumn,
  notFound,
  writing,
  type AuditMeta,
} from '../records/service.js';
import { resolveConversionTarget } from './modules.js';

export async function transferDealOwnership(
  principal: Principal,
  input: TransferDealOwnershipInput,
  meta: AuditMeta = {},
): Promise<OwnershipTransferDto> {
  // Re-validated here even though the route already parsed the body: this
  // function is the contract, and every guarantee about what reaches the
  // table has to hold HERE rather than at whichever call site got there.
  const { dealId, newOwnerId, reason } = transferDealOwnershipInputSchema.parse(input);

  const { target } = await resolveConversionTarget(principal);

  // `hasSpecial` short-circuits for the Admin, exactly as every other special.
  if (!target.engine.hasSpecial('TRANSFER_DEAL_OWNERSHIP')) {
    throw new ConfigError('Requires the "TRANSFER_DEAL_OWNERSHIP" permission', 403, 'FORBIDDEN');
  }

  const ownerColumn = target.storage.shape.ownerColumn;
  if (!target.module.hasOwner || ownerColumn === null) {
    throw new ConfigError('Records in this module have no owner', 422, 'GUARDRAIL');
  }
  const ownerKey = fieldForColumn(target.fields, ownerColumn)?.key ?? ownerColumn;

  return writing(() =>
    prisma.$transaction(async (tx) => {
      // Proved inside the transaction: a target deactivated between the check
      // and the write would leave the customer with nobody.
      await assertAssignableOwner(tx, newOwnerId);

      // Through the scope filter: a deal this actor cannot see is a 404, not
      // a 403 that confirms it exists.
      const deal = await findRecordById({
        module: target.module,
        fields: target.metas,
        engine: target.engine,
        actor: principal.actor,
        id: dealId,
        client: tx,
      });
      if (!deal) throw notFound();

      const from = deal.raw[ownerColumn];
      const fromId = typeof from === 'string' ? from : '';
      // Already theirs: no write and no timeline entry. The timeline is what
      // happened, not what was submitted.
      if (fromId === newOwnerId) return { dealId, ownerId: { from: fromId, to: newOwnerId } };

      // The owner column and NOTHING else — see the file header.
      await delegateOrThrow(tx, target).update({
        where: { id: dealId },
        data: { [ownerColumn]: newOwnerId },
        select: { id: true },
      });

      await auditWithin(tx).log({
        entityType: target.storage.shape.entityType,
        entityId: dealId,
        action: 'OWNERSHIP_TRANSFERRED',
        ...actorIdentity(principal),
        changes: {
          [ownerKey]: { from: fromId, to: newOwnerId },
          // The human's stated reason when they gave one, else the same
          // 'manual' every hand-made ownership change carries.
          [ASSIGNMENT_REASON_KEY]: { from: null, to: reason ?? 'manual' },
        },
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });

      return { dealId, ownerId: { from: fromId, to: newOwnerId } };
    }),
  );
}
