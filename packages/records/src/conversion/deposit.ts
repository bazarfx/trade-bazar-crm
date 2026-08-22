/**
 * The deposit ledger (spec §8.3).
 *
 * Every deposit — the FTD and every re-deposit arriving by webhook — is its
 * own row, and the deal's total and count are RECOMPUTED from those rows
 * after each insert: `SUM` and `COUNT`, written back, never `+= amount`. An
 * increment is right until the first replayed event, the first crash between
 * two statements or the first hand-correction of a row; a recount is right
 * every time. The totals are also stripped from every field-driven write by
 * the record engine (`derivedColumns`), so this file is the only writer.
 *
 * **Idempotent on the event.** A replayed webhook carries the same
 * `webhookEventId`; a ledger row already pointing at it is returned as-is
 * and nothing is inserted. "Every event is replayable" has to mean
 * replayable SAFELY, or nobody will dare press the button.
 *
 * Nothing here names a table. The ledger, its columns and the parent's
 * derived columns all come from the storage shape (`LedgerShape`).
 */
import { Prisma } from '@crm/db';
import type { AuditEntry } from '@crm/core';
import { depositInputSchema, type DepositInput, type DepositRecordedDto } from '@crm/shared';
import type { Principal } from '../principal.js';
import { auditWithin } from '../audit.js';
import { ConfigError, type Tx } from '../config/service.js';
import { findRecordById, type Row } from '../records/list.js';
import {
  actorIdentity,
  delegateOrThrow,
  fieldForColumn,
  notFound,
  writing,
  type AuditMeta,
  type ModuleContext,
} from '../records/service.js';
import { DEPOSIT_AMOUNT_KEY, DEPOSIT_AT_KEY, DEPOSIT_FTD_KEY, WEBHOOK_EVENT_KEY } from './keys.js';
import { resolveConversionTarget, type ConversionTarget } from './modules.js';

/**
 * The slice of the ledger's Prisma delegate this file uses, structural for
 * the same reason `RecordDelegate` is: the delegate is chosen by name from
 * the shape, so no static type exists.
 */
interface LedgerDelegate {
  findFirst(args: { where: Row; select: Row }): Promise<Row | null>;
  create(args: { data: Row; select: Row }): Promise<Row>;
  aggregate(args: {
    where: Row;
    _sum: Row;
    _count: { _all: true };
  }): Promise<{ _sum: Row; _count: { _all: number } }>;
}

function ledgerDelegate(tx: Tx, delegateName: string): LedgerDelegate {
  const delegate = (tx as unknown as Record<string, LedgerDelegate | undefined>)[delegateName];
  if (!delegate) {
    throw new ConfigError(`The deposit ledger "${delegateName}" has no storage`, 500, 'GUARDRAIL');
  }
  return delegate;
}

/** Money as the DTO and the audit log carry it: exact two-decimal digits. */
function money(value: unknown): string {
  return new Prisma.Decimal(value === null || value === undefined ? 0 : String(value)).toFixed(2);
}

/** The parent's derived columns, read straight off the row. */
async function currentTotals(
  tx: Tx,
  resolved: ConversionTarget,
  dealId: string,
): Promise<{ total: string; count: number }> {
  const { ledger, target } = resolved;
  const row = await delegateOrThrow(tx, target).findFirst({
    where: { id: dealId },
    select: { [ledger.totalColumn]: true, [ledger.countColumn]: true },
  });
  return { total: money(row?.[ledger.totalColumn]), count: Number(row?.[ledger.countColumn] ?? 0) };
}

/**
 * Recompute the parent's total and count FROM THE ROWS and write them back.
 * One aggregate, one update. The only place the derived columns are written.
 */
async function recomputeTotals(
  tx: Tx,
  resolved: ConversionTarget,
  dealId: string,
): Promise<{ total: string; count: number }> {
  const { ledger, target } = resolved;
  const agg = await ledgerDelegate(tx, ledger.delegateName).aggregate({
    where: { [ledger.parentColumn]: dealId },
    _sum: { [ledger.amountColumn]: true },
    _count: { _all: true },
  });
  const total = money(agg._sum[ledger.amountColumn]);
  const count = agg._count._all;

  await delegateOrThrow(tx, target).update({
    where: { id: dealId },
    data: { [ledger.totalColumn]: new Prisma.Decimal(total), [ledger.countColumn]: count },
    select: { id: true },
  });
  return { total, count };
}

/**
 * The status rule for a deposit that is NOT the first.
 *
 * Deal statuses carry no system tags today — the seed tags "New FTD" HOT and
 * "Re-Deposited" HOT, and nothing in the product may read a status by NAME —
 * so there is no tag to move to. The documented rule until there is: a
 * re-deposit landing on a deal still in the FIRST live status (by the
 * Admin's order) moves it to the SECOND. It is honest about what it knows
 * (the Admin's ordering) and nothing else, and an Admin who reorders deal
 * statuses changes its behaviour without a deploy.
 *
 * TODO(deal statuses): add StatusTag members for the deal lifecycle (e.g.
 * FIRST_DEPOSIT, RE_DEPOSITED) in a later slice, seed them, and replace this
 * with `pickStatusByTag`, exactly as the lead side does with CONVERTED. The
 * rule below is then deleted, not extended.
 */
async function advanceStatusOnRedeposit(
  tx: Tx,
  ctx: ModuleContext,
  dealId: string,
  currentStatusId: string | null,
): Promise<{ from: string; to: string } | null> {
  const statusColumn = ctx.storage.shape.statusColumn;
  if (statusColumn === null || currentStatusId === null) return null;

  const ordered = await tx.status.findMany({
    where: { moduleId: ctx.module.id, isDeleted: false },
    orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    take: 2,
    select: { id: true },
  });
  const [first, second] = ordered;
  if (!first || !second || currentStatusId !== first.id) return null;

  await delegateOrThrow(tx, ctx).update({
    where: { id: dealId },
    data: { [statusColumn]: second.id },
    select: { id: true },
  });
  return { from: first.id, to: second.id };
}

/**
 * Record one deposit on an existing deal.
 *
 * Runs on the caller's transaction: the conversion records the FTD inside
 * the same transaction that created the deal, and the webhook worker settles
 * the event row beside the re-deposit it produced. The deal is loaded through
 * the scoped read for `principal` — the pipeline's system principal sees
 * everything; a human caller sees what their matrix allows.
 */
export async function recordDeposit(
  principal: Principal,
  tx: Tx,
  input: DepositInput,
  meta: AuditMeta = {},
): Promise<DepositRecordedDto> {
  const parsed = depositInputSchema.parse(input);
  const resolved = await resolveConversionTarget(principal);
  const { target, ledger } = resolved;

  return writing(async () => {
    const deal = await findRecordById({
      module: target.module,
      fields: target.metas,
      engine: target.engine,
      actor: principal.actor,
      id: parsed.dealId,
      client: tx,
    });
    if (!deal) throw notFound();

    const rows = ledgerDelegate(tx, ledger.delegateName);

    // Idempotency: the event already produced a row. Return it with the
    // totals as they stand; insert nothing, log nothing — the timeline is
    // what happened, and it happened once.
    if (parsed.webhookEventId) {
      const existing = await rows.findFirst({
        where: { [ledger.eventColumn]: parsed.webhookEventId },
        select: { id: true, [ledger.parentColumn]: true },
      });
      if (existing) {
        const totals = await currentTotals(tx, resolved, String(existing[ledger.parentColumn]));
        return {
          depositId: String(existing['id']),
          totalDeposited: totals.total,
          depositCount: totals.count,
          inserted: false,
        };
      }
    }

    const before = await currentTotals(tx, resolved, parsed.dealId);

    const created = await rows.create({
      data: {
        [ledger.parentColumn]: parsed.dealId,
        [ledger.amountColumn]: new Prisma.Decimal(money(parsed.amount)),
        [ledger.atColumn]: parsed.depositedAt,
        [ledger.eventColumn]: parsed.webhookEventId ?? null,
        [ledger.firstColumn]: parsed.isFtd,
      },
      select: { id: true },
    });
    const depositId = String(created['id']);

    const after = await recomputeTotals(tx, resolved, parsed.dealId);

    const statusMove = parsed.isFtd
      ? null
      : await advanceStatusOnRedeposit(
          tx,
          target,
          parsed.dealId,
          target.storage.shape.statusColumn === null
            ? null
            : ((deal.raw[target.storage.shape.statusColumn] as string | null | undefined) ?? null),
        );

    // Logged under the deal's OWN field keys for the derived columns when a
    // field maps to them, so a role that may not see "Total Deposited" does
    // not read it off the timeline either; the row's amount and time travel
    // under keys no field can own.
    const totalKey = fieldForColumn(target.fields, ledger.totalColumn)?.key ?? ledger.totalColumn;
    const countKey = fieldForColumn(target.fields, ledger.countColumn)?.key ?? ledger.countColumn;
    const identity = actorIdentity(principal);
    const entries: AuditEntry[] = [
      {
        entityType: target.storage.shape.entityType,
        entityId: parsed.dealId,
        action: 'DEPOSIT_RECEIVED',
        ...identity,
        changes: {
          [DEPOSIT_AMOUNT_KEY]: { from: null, to: Number(money(parsed.amount)) },
          [DEPOSIT_AT_KEY]: { from: null, to: parsed.depositedAt.toISOString() },
          [DEPOSIT_FTD_KEY]: { from: null, to: parsed.isFtd },
          [totalKey]: { from: Number(before.total), to: Number(after.total) },
          [countKey]: { from: before.count, to: after.count },
          ...(parsed.webhookEventId
            ? { [WEBHOOK_EVENT_KEY]: { from: null, to: parsed.webhookEventId } }
            : {}),
        },
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      },
    ];
    if (statusMove) {
      const statusKey =
        fieldForColumn(target.fields, target.storage.shape.statusColumn)?.key ??
        target.storage.shape.statusColumn ??
        'status';
      entries.push({
        entityType: target.storage.shape.entityType,
        entityId: parsed.dealId,
        action: 'STATUS_CHANGED',
        ...identity,
        changes: { [statusKey]: statusMove },
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });
    }
    await auditWithin(tx).logMany(entries);

    return { depositId, totalDeposited: after.total, depositCount: after.count, inserted: true };
  });
}
