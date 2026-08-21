/**
 * Layer A — the append-only audit log, wired to Prisma.
 *
 * This log IS the timeline rendered on every record. Never UPDATE it, never
 * DELETE from it. Every mutation in the product goes through here.
 *
 * THE SPLIT: this file used to be `apps/web/src/lib/audit.ts` in full. The
 * sink is pure Prisma and moved here so the worker can write the same rows the
 * same way — an imported lead gets its RECORD_CREATED and ASSIGNED entries
 * exactly like a hand-typed one, because it goes through this logger and not
 * around it. What stayed behind in `apps/web` is `requestMeta(req)`, which
 * reads headers off an HTTP `Request`: the worker has no request, so ip and
 * user agent are passed IN as `AuditMeta` by whoever does have one, and are
 * simply absent on a job.
 */
import { prisma } from '@crm/db';
import { AuditLogger, type AuditEntry, type AuditSink } from '@crm/core';
import { Prisma, type ActorType, type AuditAction } from '@crm/db';

/** The client OR an open transaction — both write the same rows the same way. */
type AuditClient = Pick<Prisma.TransactionClient, 'auditLog'>;

/** One mapping from `AuditEntry` to the row, used by every writer. Duplicating
 *  it per call site is how the JSON-null handling below drifts. */
function sinkOn(client: AuditClient): AuditSink {
  return {
    async write(entries: AuditEntry[]) {
      if (entries.length === 0) return;
      await client.auditLog.createMany({
        data: entries.map((e) => ({
          entityType: e.entityType,
          entityId: e.entityId,
          action: e.action as AuditAction,
          actorType: e.actorType as ActorType,
          actorId: e.actorId ?? null,
          // Prisma distinguishes "JSON null" from "column null"; an entry with no
          // diff (a login, a webhook receipt) stores column null.
          changes: e.changes
            ? (e.changes as unknown as Prisma.InputJsonObject)
            : Prisma.DbNull,
          ipAddress: e.ipAddress ?? null,
          userAgent: e.userAgent ?? null,
        })),
      });
    },
  };
}

export const audit = new AuditLogger(sinkOn(prisma));

/**
 * An `AuditLogger` bound to an OPEN TRANSACTION.
 *
 * The module-level `audit` writes on its own connection, so a mutation that
 * used it inside `$transaction` would commit its log rows even if the business
 * write rolled back — a timeline entry for something that never happened. Any
 * mutation that must be atomic with its log takes its logger from here.
 */
export function auditWithin(tx: Prisma.TransactionClient): AuditLogger {
  return new AuditLogger(sinkOn(tx));
}
