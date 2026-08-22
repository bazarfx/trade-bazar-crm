/**
 * The deposit ledger, READ side (spec §8.3): every deposit row behind one
 * record, with the totals the record's header shows.
 *
 * Two rules, both structural:
 *
 *  1. **The scoped record read comes first.** The ledger is reached only
 *     after `getRecord` has answered for the parent — an actor who may not see
 *     the deal may not see its deposits either, and out-of-scope and
 *     non-existent both stay a 404 here, exactly as they do on the record.
 *  2. **Nothing here names a table.** Which delegate is the ledger, which
 *     column points at the parent and which carries the amount all come from
 *     the module's storage shape (`LedgerShape`). A module whose shape has no
 *     ledger answers 404 — "this module keeps no deposits" — which is also how
 *     the detail screen decides whether to draw the panel, so no screen ever
 *     asks `slug === 'deals'`.
 *
 * Totals are recomputed from the rows returned rather than read off the
 * parent's derived columns: the header and the table underneath it must
 * never disagree, and the rows are the truth the columns are derived from.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import type { Principal } from '@/lib/auth/actor';
import { ConfigError } from '@/lib/config/service';
import { getRecord, moduleContext } from '@/lib/records/service';

export interface DepositDto {
  id: string;
  /** exact two-decimal digits — money never round-trips through `Number()` */
  amount: string;
  depositedAt: string;
  isFtd: boolean;
  /** the raw webhook event that produced this row, when one did */
  webhookEventId: string | null;
  /** that event's source, so the screen can link straight to its event log */
  webhookSourceId: string | null;
}

export interface DepositLedgerDto {
  deposits: DepositDto[];
  totals: {
    total: string;
    count: number;
    /** the first deposit on record (the FTD), or null before one */
    first: DepositDto | null;
  };
}

/**
 * The slice of the ledger delegate this file uses. Structural, like
 * `RecordDelegate`: the delegate is chosen by name from the shape at runtime,
 * so no static Prisma type exists for it.
 */
interface LedgerReader {
  findMany(args: {
    where: Record<string, unknown>;
    orderBy: Record<string, 'asc' | 'desc'>[];
    select: Record<string, true>;
  }): Promise<Record<string, unknown>[]>;
}

function money(value: unknown): string {
  return new Prisma.Decimal(value === null || value === undefined ? 0 : String(value)).toFixed(2);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '');
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export async function listDeposits(
  principal: Principal,
  moduleSlug: string,
  recordId: string,
): Promise<DepositLedgerDto> {
  // Scope first. Throws 404 for a record this actor may not see, before the
  // ledger is so much as named.
  await getRecord(principal, moduleSlug, recordId);

  const ctx = await moduleContext(principal, moduleSlug);
  const ledger = ctx.storage.shape.ledger;
  if (!ledger) {
    throw new ConfigError('This module keeps no deposit ledger', 404, 'NOT_FOUND');
  }

  const reader = (prisma as unknown as Record<string, LedgerReader | undefined>)[ledger.delegateName];
  if (!reader) {
    throw new ConfigError(`The deposit ledger "${ledger.delegateName}" has no storage`, 500, 'GUARDRAIL');
  }

  const rows = await reader.findMany({
    where: { [ledger.parentColumn]: recordId },
    // Newest first for the table; `id` breaks ties so two deposits in the
    // same second keep a stable order across reloads.
    orderBy: [{ [ledger.atColumn]: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      [ledger.amountColumn]: true,
      [ledger.atColumn]: true,
      [ledger.eventColumn]: true,
      [ledger.firstColumn]: true,
    },
  });

  // The event → source hop, in one query, so every row can link to the event
  // log that holds its raw payload. `WebhookEvent` is the evidence table
  // every webhook shares; it is not a module and has no slug to branch on.
  const eventIds = rows
    .map((r) => str(r[ledger.eventColumn]))
    .filter((id): id is string => id !== null);
  const events =
    eventIds.length > 0
      ? await prisma.webhookEvent.findMany({
          where: { id: { in: eventIds } },
          select: { id: true, sourceId: true },
        })
      : [];
  const sourceByEvent = new Map(events.map((e) => [e.id, e.sourceId]));

  const deposits: DepositDto[] = rows.map((r) => {
    const eventId = str(r[ledger.eventColumn]);
    return {
      id: String(r['id']),
      amount: money(r[ledger.amountColumn]),
      depositedAt: iso(r[ledger.atColumn]),
      isFtd: r[ledger.firstColumn] === true,
      webhookEventId: eventId,
      webhookSourceId: eventId === null ? null : (sourceByEvent.get(eventId) ?? null),
    };
  });

  // Derived from the rows, as the totals on the record are. Decimal
  // arithmetic, never float: 0.1 + 0.2 is not a ledger anyone can reconcile.
  const total = deposits
    .reduce((sum, d) => sum.plus(new Prisma.Decimal(d.amount)), new Prisma.Decimal(0))
    .toFixed(2);
  const first = deposits.find((d) => d.isFtd) ?? deposits[deposits.length - 1] ?? null;

  return { deposits, totals: { total, count: deposits.length, first } };
}
