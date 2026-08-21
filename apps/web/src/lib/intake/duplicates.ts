/**
 * The duplicate review queue (spec §6.6).
 *
 * The record engine writes `DuplicateFlag` rows at create time — phone match,
 * or name + language — and this file is the ONLY reader and resolver of those
 * rows. Three rules shape it:
 *
 *  1. **Nothing merges here.** A "merge" in this product is a person copying
 *     what they need onto the record they keep, by hand, through the normal
 *     edit path — and then recording the decision. `resolveDuplicateFlag`
 *     writes a status and two audit rows; it never touches either record's
 *     data, and no code path that does may ever be added.
 *  2. **Both sides load through the scoped repository.** `findRecordById`
 *     applies the actor's view scope and `serialiseRecord` strips hidden
 *     fields, so a pair is only ever as visible as the records themselves. A
 *     side the actor may not see comes back null and the UI says so — the
 *     flag row itself leaks nothing but an id and a match reason.
 *  3. **Resolving is an edit-level power on the record under review.** The
 *     queue changes what happens to a record, so it is gated exactly like
 *     editing it — `can('edit', slug)` to look, `can('edit', slug, record)`
 *     over the primary to act.
 */
import 'server-only';
import { prisma } from '@crm/db';
import { PermissionEngine, type FieldMeta } from '@crm/core';
import type {
  DuplicateFlagDto,
  DuplicateQueueDto,
  DuplicateQueueFieldDto,
  DuplicateResolution,
  DuplicateStatusValue,
} from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { assertModuleReadAccess } from '@/lib/config/access';
import { ConfigError, requireModule } from '@/lib/config/service';
import { findRecordById, storageFor, type ModuleRef, type Storage } from '@/lib/records/list';
import { serialiseRecord, type AuditMeta } from '@/lib/records/service';
import { auditWithin } from '@/lib/audit';

/** One screenful of pairs. Each pair is two full records side by side, so a
 *  larger page is payload, not productivity. */
export const DUPLICATE_PAGE_SIZE = 20;

interface QueueContext {
  moduleRef: ModuleRef;
  engine: PermissionEngine;
  storage: Storage;
  /** `matchReason` → the field keys it was decided on (see `matchedKeysByReason`) */
  matchedKeys: Record<string, string[]>;
  /** the module's live fields this actor may see, in the Admin's order */
  fields: DuplicateQueueFieldDto[];
  metas: FieldMeta[];
}

/**
 * Everything a queue operation needs, gates first.
 *
 * The read gate runs BEFORE the module resolves (unknown and forbidden must be
 * indistinguishable), and the edit gate runs before any flag row is read: a
 * role that cannot edit these records has no business knowing which of them
 * were flagged against each other.
 */
async function queueContext(principal: Principal, moduleSlug: string): Promise<QueueContext> {
  assertModuleReadAccess(principal, moduleSlug);
  const module = await requireModule(moduleSlug);

  const engine = new PermissionEngine(principal.actor, principal.permissions);
  if (!engine.can('edit', moduleSlug)) {
    throw new ConfigError('Your role cannot resolve duplicates in this module', 403, 'FORBIDDEN');
  }

  const rows = await prisma.fieldDefinition.findMany({
    where: { moduleId: module.id, isDeleted: false },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    select: {
      key: true,
      label: true,
      type: true,
      systemColumn: true,
      isSystem: true,
      // Retired options included: an older record still stores one, and the
      // side-by-side must label it rather than show the raw value.
      options: { select: { value: true, label: true }, orderBy: { displayOrder: 'asc' } },
    },
  });

  // Hidden fields are dropped HERE, so they neither serialise nor list as
  // rows. Hiding a field in the UI is not a security control.
  const hidden = engine.hiddenFields(moduleSlug);
  const fields = rows.filter((f) => !hidden.has(f.key));
  const metas: FieldMeta[] = fields.map((f) => ({
    key: f.key,
    type: f.type,
    systemColumn: f.systemColumn,
  }));

  const moduleRef: ModuleRef = { id: module.id, slug: module.slug, isCore: module.isCore };
  const storage = storageFor(moduleRef, metas);
  return {
    moduleRef,
    engine,
    storage,
    matchedKeys: matchedKeysByReason(fields, module.recordTitleField, storage.shape.languageColumn),
    fields: fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      systemColumn: f.systemColumn,
      options: f.options,
    })),
    metas,
  };
}

/**
 * Which fields each `matchReason` was decided on — the SAME rule the record
 * engine's `flagDuplicates` applies, restated so the queue can point at the
 * matching rows: `phone` is the first system PHONE field (else the first
 * PHONE field), `name_language` is the module's title field plus the field
 * behind its language column. Nothing here names a key; a module whose Admin
 * renamed or re-typed these fields gets the right rows for free. A reason
 * this build does not know maps to no rows rather than to a guess.
 */
function matchedKeysByReason(
  fields: { key: string; type: string; systemColumn: string | null; isSystem: boolean }[],
  titleFieldKey: string,
  languageColumn: string | null,
): Record<string, string[]> {
  const phones = fields.filter((f) => f.type === 'PHONE');
  const phone = phones.find((f) => f.isSystem) ?? phones[0] ?? null;
  const title = fields.find((f) => f.key === titleFieldKey) ?? null;
  const language =
    languageColumn === null ? null : (fields.find((f) => f.systemColumn === languageColumn) ?? null);
  return {
    phone: phone ? [phone.key] : [],
    name_language: [title, language].flatMap((f) => (f ? [f.key] : [])),
  };
}

/** Load one side of a pair through the scope filter; null = not yours to see. */
async function loadSide(
  ctx: QueueContext,
  principal: Principal,
  id: string,
): Promise<{ id: string; values: Record<string, unknown> } | null> {
  const found = await findRecordById({
    module: ctx.moduleRef,
    fields: ctx.metas,
    engine: ctx.engine,
    actor: principal.actor,
    id,
  });
  if (!found) return null;
  return {
    id: found.id,
    values: serialiseRecord(ctx.engine, ctx.moduleRef.slug, found.values, ctx.metas),
  };
}

export interface ListDuplicatesOptions {
  status?: DuplicateStatusValue;
  page?: number;
}

export async function listDuplicateFlags(
  principal: Principal,
  moduleSlug: string,
  opts: ListDuplicatesOptions = {},
): Promise<DuplicateQueueDto> {
  const ctx = await queueContext(principal, moduleSlug);

  // `DuplicateFlag` FKs point at one table only (see `canFlagDuplicates` in
  // the storage shapes) — a module stored elsewhere has an empty queue by
  // construction, not a hidden one.
  if (!ctx.storage.shape.canFlagDuplicates) return { flags: [], total: 0, fields: ctx.fields };

  const status = opts.status ?? 'PENDING';
  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const where = { moduleSlug, status };

  const [total, rows] = await Promise.all([
    prisma.duplicateFlag.count({ where }),
    prisma.duplicateFlag.findMany({
      where,
      // Oldest first: the queue is worked down, and the pair that has waited
      // longest is the one two agents are most likely both dialling.
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * DUPLICATE_PAGE_SIZE,
      take: DUPLICATE_PAGE_SIZE,
    }),
  ]);

  const flags: DuplicateFlagDto[] = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      matchReason: row.matchReason,
      matchedFieldKeys: ctx.matchedKeys[row.matchReason] ?? [],
      confidence: row.confidence,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      primary: await loadSide(ctx, principal, row.primaryLeadId),
      candidate: await loadSide(ctx, principal, row.candidateLeadId),
    })),
  );

  return { flags, total, fields: ctx.fields };
}

/** PENDING flags for one module — the number on the list toolbar's button.
 *  Callers gate on `canFlagDuplicates` + edit permission before asking. */
export async function countPendingDuplicates(moduleSlug: string): Promise<number> {
  return prisma.duplicateFlag.count({ where: { moduleSlug, status: 'PENDING' } });
}

export async function resolveDuplicateFlag(
  principal: Principal,
  moduleSlug: string,
  flagId: string,
  resolution: DuplicateResolution,
  meta: AuditMeta = {},
): Promise<DuplicateFlagDto> {
  const ctx = await queueContext(principal, moduleSlug);

  const flag = await prisma.duplicateFlag.findFirst({
    where: { id: flagId, moduleSlug },
  });
  if (!flag) throw new ConfigError('This flag no longer exists', 404, 'NOT_FOUND');
  if (flag.status !== 'PENDING') {
    // A decision was already recorded and the audit rows for it are already
    // written; overwriting it would make the log disagree with the flag.
    throw new ConfigError('This pair was already resolved', 409, 'CONFLICT');
  }

  // The scoped load again, per record: the list gate said "may edit in this
  // module", this says "may edit THIS record". 404 rather than 403 — a
  // "forbidden" would confirm the record exists to someone who cannot see it.
  const primary = await findRecordById({
    module: ctx.moduleRef,
    fields: ctx.metas,
    engine: ctx.engine,
    actor: principal.actor,
    id: flag.primaryLeadId,
  });
  if (!primary || !ctx.engine.can('edit', moduleSlug, primary.owned)) {
    throw new ConfigError('This flag no longer exists', 404, 'NOT_FOUND');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.duplicateFlag.update({
      where: { id: flag.id },
      data: {
        status: resolution,
        resolvedById: principal.actor.userId,
        resolvedAt: new Date(),
      },
    });

    // DUPLICATE_RESOLVED on BOTH records, in the same transaction as the flag
    // update — the timeline is the log, and each record's history must carry
    // the decision that was made about it. The candidate side may be
    // soft-deleted or out of the resolver's scope; its timeline still gets the
    // entry, because invariant 4 keeps that history readable forever.
    // Same diff shape DUPLICATE_FLAGGED wrote, so the two entries read as a
    // pair on the timeline: flagged against X, resolved against X.
    const changes = (otherId: string) => ({
      resolution: { from: 'PENDING', to: resolution },
      duplicateOf: { from: null, to: otherId },
    });
    await auditWithin(tx).logMany([
      {
        entityType: ctx.storage.shape.entityType,
        entityId: flag.primaryLeadId,
        action: 'DUPLICATE_RESOLVED',
        actorType: 'USER',
        actorId: principal.actor.userId,
        changes: changes(flag.candidateLeadId),
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      },
      {
        entityType: ctx.storage.shape.entityType,
        entityId: flag.candidateLeadId,
        action: 'DUPLICATE_RESOLVED',
        actorType: 'USER',
        actorId: principal.actor.userId,
        changes: changes(flag.primaryLeadId),
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      },
    ]);

    return row;
  });

  return {
    id: updated.id,
    matchReason: updated.matchReason,
    matchedFieldKeys: ctx.matchedKeys[updated.matchReason] ?? [],
    confidence: updated.confidence,
    status: updated.status,
    createdAt: updated.createdAt.toISOString(),
    // The pair's records are not reloaded for the response: the client already
    // holds the pair it just resolved, and the only thing that changed is the
    // status above.
    primary: null,
    candidate: null,
  };
}
