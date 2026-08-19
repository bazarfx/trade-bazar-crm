/**
 * Status operations — per-module, fully Admin-editable pipelines.
 *
 * Everything here reads Status.tag for behaviour, never the name: names are
 * display data the Admin renames at will (isSystem statuses included). The
 * guardrails live in `@crm/core` (`guardTagChange`) so the worker's webhook
 * pipeline and this config surface can never disagree about what is safe.
 *
 * All writes travel through `applyConfigChange` — permission assertion,
 * ConfigChangeLog snapshot and AuditLog entry in one transaction.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import type {
  ReorderInput,
  StatusCreateInput,
  StatusTagValue,
  StatusUpdateInput,
} from '@crm/shared';
import { guardTagChange } from '@crm/core';
import type { Principal } from '@/lib/auth/actor';
import { assertModuleReadAccess } from '@/lib/config/access';
import {
  applyConfigChange,
  assertConfigPermission,
  ConfigError,
  requireModule,
  type Tx,
} from '@/lib/config/service';

/** The serialisable shape every status API returns. */
export interface StatusDto {
  id: string;
  name: string;
  tag: StatusTagValue;
  color: string | null;
  displayOrder: number;
  isSystem: boolean;
  isDeleted: boolean;
}

/** Doubles as the ConfigChangeLog snapshot: `revertConfigChange` writes this
 *  image back minus `id`, so it must contain exactly the mutable columns. */
const STATUS_SELECT = {
  id: true,
  name: true,
  tag: true,
  color: true,
  displayOrder: true,
  isSystem: true,
  isDeleted: true,
} as const;

/** What guardTagChange needs — every status of the module, deleted included
 *  (the guard filters live rows itself, so it sees the same world everywhere). */
const GUARD_SELECT = {
  id: true,
  name: true,
  tag: true,
  displayOrder: true,
  isDeleted: true,
} as const;

/**
 * Every table that physically carries a statusId. This is a STORAGE fact from
 * schema.prisma (Lead.statusId, Deal.statusId, Record.statusId), not module
 * logic: entityType is the Prisma MODEL name the timeline reader resolves,
 * never a module slug — slugs are Admin-editable data.
 *
 * Closures per delegate keep each query typed against its own model while the
 * caller iterates one uniform list. Works on the client and inside a tx.
 *
 * `ids` is paged and `reassign` is id-scoped rather than `{ statusId }`-scoped:
 * that pairing is what lets the caller move a page and write exactly that
 * page's timeline entries, so invariant 2 holds wherever the loop stops and a
 * row inserted mid-transaction is never moved without an entry of its own.
 */
function statusReferences(db: Tx, statusId: string) {
  return [
    {
      entityType: 'Lead',
      count: () => db.lead.count({ where: { statusId } }),
      ids: (take: number) => db.lead.findMany({ where: { statusId }, select: { id: true }, take }),
      reassign: (to: string, ids: string[]) =>
        db.lead.updateMany({ where: { id: { in: ids } }, data: { statusId: to } }),
    },
    {
      entityType: 'Deal',
      count: () => db.deal.count({ where: { statusId } }),
      ids: (take: number) => db.deal.findMany({ where: { statusId }, select: { id: true }, take }),
      reassign: (to: string, ids: string[]) =>
        db.deal.updateMany({ where: { id: { in: ids } }, data: { statusId: to } }),
    },
    {
      entityType: 'Record',
      count: () => db.record.count({ where: { statusId } }),
      ids: (take: number) => db.record.findMany({ where: { statusId }, select: { id: true }, take }),
      reassign: (to: string, ids: string[]) =>
        db.record.updateMany({ where: { id: { in: ids } }, data: { statusId: to } }),
    },
  ];
}

/** Page size of the reassignment drain loop: ids are read, moved and given
 *  their timeline entry (invariant 2) one page at a time, so neither the id
 *  list nor a createMany payload is ever unbounded. */
const AUDIT_BATCH = 1000;

/**
 * Ceiling on how many records a single interactive delete may reassign.
 *
 * The move must finish inside one transaction — a half-moved pipeline would
 * leave records pointing at a deleted status — and past this many rows it will
 * not, on a pooled cross-region connection, no matter how generous the budget.
 * Refusing up front beats rolling back minutes of work the Admin already
 * believes succeeded, so we say so and hand the job to a background operator.
 */
export const STATUS_REASSIGN_LIMIT = 100_000;

export async function listStatuses(
  principal: Principal,
  moduleSlug: string,
  opts?: { includeDeleted?: boolean },
): Promise<StatusDto[]> {
  // Every user who can see a record of this module needs its status list to
  // render the picker — and nobody else does, so the pipeline is not readable
  // through a module the actor has no view of.
  assertModuleReadAccess(principal, moduleSlug);
  // Deleted statuses exist only for the admin status manager — same treatment
  // as listFields, since nobody else has business knowing one ever existed.
  if (opts?.includeDeleted) assertConfigPermission(principal, 'STATUS');
  const module = await requireModule(moduleSlug);
  return prisma.status.findMany({
    where: { moduleId: module.id, ...(opts?.includeDeleted ? {} : { isDeleted: false }) },
    // id breaks displayOrder ties so the list is deterministic, matching
    // pickStatusByTag's ordering in the webhook pipeline.
    orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    select: STATUS_SELECT,
  });
}

/** 409 when the name is taken. The case-insensitive check covers live rows;
 *  the exact-name check covers soft-deleted ones, which still hold their name
 *  via @@unique([moduleId, name]) — a clear 409 beats a raw constraint 500. */
async function assertNameFree(tx: Tx, moduleId: string, name: string, excludeId?: string): Promise<void> {
  const clash = await tx.status.findFirst({
    where: {
      moduleId,
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
      OR: [
        { isDeleted: false, name: { equals: name, mode: 'insensitive' } },
        { name },
      ],
    },
    select: { isDeleted: true },
  });
  if (clash) {
    throw new ConfigError(
      clash.isDeleted
        ? `A deleted status still holds the name "${name}"; restore it or pick another name`
        : `A status named "${name}" already exists`,
      409,
      'CONFLICT',
    );
  }
}

export async function createStatus(
  principal: Principal,
  moduleSlug: string,
  input: StatusCreateInput,
): Promise<StatusDto> {
  // Fail closed before touching data: applyConfigChange asserts again, but
  // nothing (not even a 404 vs 409 distinction) should leak to a caller who
  // lacks the permission.
  assertConfigPermission(principal, 'STATUS');
  const module = await requireModule(moduleSlug);

  const { result } = await applyConfigChange<StatusDto>({
    principal,
    configType: 'STATUS',
    action: 'CREATE',
    before: async () => null,
    mutate: async (tx) => {
      // Checked inside the tx so two concurrent creates cannot both pass.
      await assertNameFree(tx, module.id, input.name);

      // max across ALL rows (deleted included) so a later restore never
      // collides with an order slot handed out after its deletion.
      const max = await tx.status.aggregate({
        where: { moduleId: module.id },
        _max: { displayOrder: true },
      });

      const created = await tx.status.create({
        data: {
          moduleId: module.id,
          name: input.name,
          tag: input.tag,
          color: input.color ?? null,
          displayOrder: (max._max.displayOrder ?? -1) + 1,
        },
        select: STATUS_SELECT,
      });
      return { result: created, configId: created.id };
    },
    after: (tx, configId) => tx.status.findUnique({ where: { id: configId }, select: STATUS_SELECT }),
  });

  return result;
}

export async function updateStatus(
  principal: Principal,
  moduleSlug: string,
  statusId: string,
  input: StatusUpdateInput,
): Promise<StatusDto> {
  assertConfigPermission(principal, 'STATUS');
  const module = await requireModule(moduleSlug);

  const existing = await prisma.status.findFirst({
    where: { id: statusId, moduleId: module.id, isDeleted: false },
    select: STATUS_SELECT,
  });
  if (!existing) throw new ConfigError('Status not found', 404, 'NOT_FOUND');

  // Re-tagging can starve the webhook pipeline of a system tag — guard it.
  // Renaming and recolouring are always allowed, isSystem statuses included:
  // behaviour keys off the tag, never the name.
  if (input.tag !== undefined && input.tag !== existing.tag) {
    const all = await prisma.status.findMany({
      where: { moduleId: module.id },
      select: GUARD_SELECT,
    });
    const verdict = guardTagChange(all, statusId, { newTag: input.tag });
    if (!verdict.ok) throw new ConfigError(verdict.reason, 422, 'GUARDRAIL');
  }

  const { result } = await applyConfigChange<StatusDto>({
    principal,
    configType: 'STATUS',
    action: 'UPDATE',
    before: (tx) => tx.status.findUnique({ where: { id: statusId }, select: STATUS_SELECT }),
    mutate: async (tx) => {
      if (input.name !== undefined && input.name !== existing.name) {
        await assertNameFree(tx, module.id, input.name, statusId);
      }
      const updated = await tx.status.update({
        where: { id: statusId },
        // Prisma skips undefined keys, so a partial payload touches only what
        // it names; color: null explicitly clears the colour.
        data: { name: input.name, tag: input.tag, color: input.color },
        select: STATUS_SELECT,
      });
      return { result: updated, configId: statusId };
    },
    after: (tx, configId) => tx.status.findUnique({ where: { id: configId }, select: STATUS_SELECT }),
  });

  return result;
}

export async function deleteStatus(
  principal: Principal,
  moduleSlug: string,
  statusId: string,
  input: { replacementStatusId?: string },
): Promise<StatusDto> {
  assertConfigPermission(principal, 'STATUS');
  const module = await requireModule(moduleSlug);

  const all = await prisma.status.findMany({
    where: { moduleId: module.id },
    select: GUARD_SELECT,
  });
  const target = all.find((s) => s.id === statusId && !s.isDeleted);
  if (!target) throw new ConfigError('Status not found', 404, 'NOT_FOUND');

  // Never delete the last live carrier of a system tag — the webhook pipeline
  // would have nowhere to move a converting record.
  const verdict = guardTagChange(all, statusId, { deleting: true });
  if (!verdict.ok) throw new ConfigError(verdict.reason, 422, 'GUARDRAIL');

  // Spec §13: deleting a status in use requires choosing a replacement. The
  // count spans every table that carries a statusId, soft-deleted rows
  // included — a restored record must never point at a dangling status.
  const counts = await Promise.all(statusReferences(prisma, statusId).map((ref) => ref.count()));
  const inUse = counts.reduce((sum, n) => sum + n, 0);

  // Checked before the replacement prompt: sending the Admin off to pick a
  // replacement that could never be applied wastes their time twice.
  if (inUse > STATUS_REASSIGN_LIMIT) {
    throw new ConfigError(
      `This status is set on ${inUse} record(s), more than the ${STATUS_REASSIGN_LIMIT} one request can reassign; contact support to move them in the background`,
      422,
      'GUARDRAIL',
      { inUse, limit: STATUS_REASSIGN_LIMIT },
    );
  }

  const replacementId = input.replacementStatusId;
  if (inUse > 0 && !replacementId) {
    throw new ConfigError(
      `This status is set on ${inUse} record(s); choose a replacement status first`,
      409,
      'CONFLICT',
      { inUse },
    );
  }
  if (replacementId) {
    const replacement = all.find((s) => s.id === replacementId && !s.isDeleted);
    if (!replacement || replacementId === statusId) {
      throw new ConfigError(
        'Replacement must be a different, active status of the same module',
        422,
        'VALIDATION',
      );
    }
  }

  const { result } = await applyConfigChange<StatusDto>({
    principal,
    configType: 'STATUS',
    action: 'DELETE',
    // Reassignment touches every record carrying the status, which does not
    // fit Prisma's 5s default: at the 40k-lead design target the tx throws
    // P2028, rolls back, and the status becomes permanently undeletable. Only
    // this path needs the larger budget — a delete with nothing to move stays
    // on the defaults.
    ...(replacementId ? { timeout: 120_000, maxWait: 10_000 } : {}),
    before: (tx) => tx.status.findUnique({ where: { id: statusId }, select: STATUS_SELECT }),
    mutate: async (tx) => {
      if (replacementId) {
        let moved = 0;

        for (const ref of statusReferences(tx, statusId)) {
          // Drain loop: read one page of ids still on the old status, move
          // exactly those ids, write exactly their timeline entries, repeat.
          // No cursor is needed — every pass removes its own rows from the
          // `{ statusId }` predicate. Re-read inside the tx rather than
          // reusing the pre-check counts, so rows created in between move too.
          for (;;) {
            const rows = await ref.ids(AUDIT_BATCH);
            if (rows.length === 0) break;

            moved += rows.length;
            // The pre-flight count is a snapshot; this bounds the loop if rows
            // keep arriving underneath it, and rolls the move back whole
            // rather than leaving the pipeline half-migrated.
            if (moved > STATUS_REASSIGN_LIMIT) {
              throw new ConfigError(
                `More than ${STATUS_REASSIGN_LIMIT} records carry this status; contact support to move them in the background`,
                422,
                'GUARDRAIL',
                { limit: STATUS_REASSIGN_LIMIT },
              );
            }

            const ids = rows.map(({ id }) => id);
            await ref.reassign(replacementId, ids);

            // Invariant 2: every record's timeline must show the move. One
            // entry per record, for this page only, so the pairing holds even
            // if a later page fails — never one insert per row.
            const entries: Prisma.AuditLogCreateManyInput[] = ids.map((id) => ({
              entityType: ref.entityType,
              entityId: id,
              action: 'STATUS_CHANGED',
              actorType: 'USER',
              actorId: principal.actor.userId,
              changes: {
                status: { from: statusId, to: replacementId },
              } as Prisma.InputJsonObject,
            }));
            await tx.auditLog.createMany({ data: entries });
          }
        }
      }

      // Soft delete, always: historical diffs keep resolving this id.
      const deleted = await tx.status.update({
        where: { id: statusId },
        data: { isDeleted: true },
        select: STATUS_SELECT,
      });
      return { result: deleted, configId: statusId };
    },
    after: (tx, configId) => tx.status.findUnique({ where: { id: configId }, select: STATUS_SELECT }),
  });

  return result;
}

export async function reorderStatuses(
  principal: Principal,
  moduleSlug: string,
  input: ReorderInput,
): Promise<StatusDto[]> {
  assertConfigPermission(principal, 'STATUS');
  const module = await requireModule(moduleSlug);

  const { result } = await applyConfigChange<StatusDto[]>({
    principal,
    configType: 'STATUS',
    action: 'REORDER',
    // One change for the whole permutation, logged against the module — a
    // reorder is one gesture, not N updates.
    before: async (tx) => ({
      orderedIds: (
        await tx.status.findMany({
          where: { moduleId: module.id, isDeleted: false },
          orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
          select: { id: true },
        })
      ).map((s) => s.id),
    }),
    mutate: async (tx) => {
      const live = await tx.status.findMany({
        where: { moduleId: module.id, isDeleted: false },
        select: { id: true },
      });
      const liveIds = new Set(live.map((s) => s.id));
      const seen = new Set(input.orderedIds);

      // The payload must be a complete permutation of the live statuses: a
      // partial list would silently shuffle the omitted ones, and displayOrder
      // decides which status pickStatusByTag hands to the webhook pipeline.
      if (
        seen.size !== input.orderedIds.length ||
        seen.size !== liveIds.size ||
        input.orderedIds.some((id) => !liveIds.has(id))
      ) {
        throw new ConfigError(
          'Order must list every active status of this module exactly once',
          400,
          'VALIDATION',
        );
      }

      for (const [index, id] of input.orderedIds.entries()) {
        await tx.status.update({ where: { id }, data: { displayOrder: index } });
      }

      const reordered = await tx.status.findMany({
        where: { moduleId: module.id, isDeleted: false },
        orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
        select: STATUS_SELECT,
      });
      return { result: reordered, configId: module.id };
    },
    after: async (tx) => ({
      orderedIds: (
        await tx.status.findMany({
          where: { moduleId: module.id, isDeleted: false },
          orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
          select: { id: true },
        })
      ).map((s) => s.id),
    }),
  });

  return result;
}
