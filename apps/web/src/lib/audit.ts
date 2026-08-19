/**
 * Layer A — the append-only audit log, wired to Prisma.
 *
 * This log IS the timeline rendered on every record. Never UPDATE it, never
 * DELETE from it. Every mutation in the product goes through here.
 */
import 'server-only';
import { prisma } from '@crm/db';
import { AuditLogger, type AuditEntry, type AuditSink } from '@crm/core';
import { Prisma, type ActorType, type AuditAction } from '@crm/db';

const prismaSink: AuditSink = {
  async write(entries: AuditEntry[]) {
    if (entries.length === 0) return;
    await prisma.auditLog.createMany({
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

export const audit = new AuditLogger(prismaSink);

/** Client IP and user agent, for audit entries. */
export function requestMeta(req: Request): { ipAddress: string | null; userAgent: string | null } {
  const forwarded = req.headers.get('x-forwarded-for');
  const ipAddress = forwarded?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? null;
  return { ipAddress, userAgent: req.headers.get('user-agent') };
}
