/**
 * One-click undo (spec §13).
 *
 * A revert applies the INVERSE of a change as a NEW change — history is never
 * rewritten, so the log stays append-only alongside AuditLog.
 *
 * The rule that shapes this file: undoing a CREATE means DELETING, and delete
 * is where every guardrail in the product lives — the last-system-tag check,
 * the "this status is on 40,000 records, choose a replacement" check, the
 * dependency scan, the per-record timeline entries. Flipping `isDeleted`
 * directly would walk straight past all of them. So the inverse of a create is
 * routed through the very same service function the forward path uses.
 *
 * It lives in its own module rather than in service.ts because it must import
 * the per-type services, and those import service.ts.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import type { ConfigType } from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { ConfigError, assertConfigPermission } from './service';
import { softDeleteField, restoreField } from './fields';
import { deleteStatus } from './statuses';
import { softDeleteSection } from './sections';

/** Prisma delegate per config type. */
const TABLE_FOR: Partial<Record<ConfigType, string>> = {
  FIELD: 'fieldDefinition',
  SECTION: 'formSection',
  STATUS: 'status',
  PICKLIST_OPTION: 'picklistOption',
  LAYOUT: 'layout',
  // Snapshots carry name, isActive, fieldMapping and defaultValues only (never
  // the token hash or the last payload), so undoing a mapping edit writes
  // exactly those back; undoing a CREATE pauses the source via `isActive`.
  WEBHOOK_SOURCE: 'webhookSource',
};

export interface RevertOptions {
  /** Undoing a status create may need a replacement for records using it. */
  replacementStatusId?: string;
  /** Undoing a field create runs the dependency scan; confirm to proceed. */
  confirmed?: boolean;
}

export async function revertConfigChange(
  principal: Principal,
  changeId: string,
  opts: RevertOptions = {},
): Promise<void> {
  const change = await prisma.configChangeLog.findUnique({ where: { id: changeId } });
  if (!change) throw new ConfigError('Change not found', 404, 'NOT_FOUND');

  const configType = change.configType as ConfigType;
  assertConfigPermission(principal, configType);

  if (change.isReverted) throw new ConfigError('Already reverted', 409, 'CONFLICT');

  // Only the LATEST un-reverted change for an object may be undone: reverting
  // an older one would silently clobber everything applied after it.
  const newer = await prisma.configChangeLog.count({
    where: {
      configType: change.configType,
      configId: change.configId,
      createdAt: { gt: change.createdAt },
      isReverted: false,
    },
  });
  if (newer > 0) {
    throw new ConfigError('Newer changes touch this object; revert those first.', 409, 'CONFLICT');
  }

  const table = TABLE_FOR[configType];
  if (!table) throw new ConfigError('This change type cannot be reverted', 422, 'GUARDRAIL');

  switch (change.action) {
    case 'CREATE':
      await undoCreate(principal, configType, change.configId, table, opts);
      break;
    case 'DELETE':
      await undoDelete(principal, configType, change.configId, table);
      break;
    case 'REORDER':
      await undoReorder(table, change.configId, change.before);
      break;
    default:
      await undoUpdate(table, change.configId, change.before);
  }

  await prisma.$transaction([
    prisma.configChangeLog.update({
      where: { id: change.id },
      data: { isReverted: true, revertedAt: new Date() },
    }),
    prisma.auditLog.create({
      data: {
        entityType: `config:${change.configType}`,
        entityId: change.configId,
        action: 'CONFIG_CHANGED',
        actorType: 'USER',
        actorId: principal.actor.userId,
        changes: { reverted: { from: change.action, to: 'REVERTED' } } as Prisma.InputJsonObject,
      },
    }),
  ]);
}

/**
 * Inverse of CREATE — delegate to the forward-path delete so every guardrail
 * runs. Deliberately NOT wrapped in an outer transaction: each service
 * function opens its own, and nesting would take a second pooled connection
 * and can block on rows the outer one holds.
 */
async function undoCreate(
  principal: Principal,
  configType: ConfigType,
  configId: string,
  table: string,
  opts: RevertOptions,
): Promise<void> {
  const slug = await moduleSlugFor(table, configId);

  switch (configType) {
    case 'FIELD':
      await softDeleteField(principal, slug, configId, { confirmed: opts.confirmed ?? false });
      return;
    case 'STATUS':
      await deleteStatus(principal, slug, configId, {
        ...(opts.replacementStatusId ? { replacementStatusId: opts.replacementStatusId } : {}),
      });
      return;
    case 'SECTION':
      await softDeleteSection(principal, slug, configId);
      return;
    default:
      // LAYOUT and PICKLIST_OPTION have no forward delete of their own; taking
      // them out of service is a flag flip with nothing to guard.
      await setLive(table, configId, false);
  }
}

/** Inverse of DELETE — restoring only ever ADDS capability, so there is no
 *  guard to bypass. Field keys stay reserved while soft-deleted, so a restore
 *  can never collide on @@unique([moduleId, key]). */
async function undoDelete(
  principal: Principal,
  configType: ConfigType,
  configId: string,
  table: string,
): Promise<void> {
  if (configType === 'FIELD') {
    const slug = await moduleSlugFor(table, configId);
    await restoreField(principal, slug, configId);
    return;
  }
  await setLive(table, configId, true);
}

/** Inverse of REORDER — the snapshot is an order, not a row, and configId is
 *  the MODULE id. Writing it back through the row table (as a before-image)
 *  would look for a field whose id is a module uuid and always fail. */
async function undoReorder(table: string, moduleId: string, before: unknown): Promise<void> {
  const ids = orderedIdsFromSnapshot(before);
  if (!ids) throw new ConfigError('No order snapshot recorded; cannot revert', 422, 'GUARDRAIL');

  const delegate = rowDelegate(prisma, table);
  await prisma.$transaction(
    async () => {
      for (const [index, id] of ids.entries()) {
        // updateMany, not update: a row soft-deleted since the snapshot must be
        // a no-op rather than a P2025 that fails the whole revert. Scoping by
        // moduleId stops a snapshot from reordering another module's rows.
        await delegate.updateMany({
          where: { id, moduleId, isDeleted: false },
          data: { displayOrder: index },
        });
      }
    },
    { timeout: 30_000, maxWait: 5_000 },
  );
}

/** Inverse of UPDATE / RESTORE — write the before-image back, then replay the
 *  picklist options the same snapshot carries. updateField mutates the field
 *  AND its options under one change; reverting only the scalars would leave a
 *  retired option retired with no way left to bring it back. */
async function undoUpdate(table: string, configId: string, before: unknown): Promise<void> {
  if (!before || typeof before !== 'object') {
    throw new ConfigError('No before-image recorded; cannot revert', 422, 'GUARDRAIL');
  }
  const snapshot = before as Record<string, unknown>;
  const delegate = rowDelegate(prisma, table);

  await prisma.$transaction(
    async () => {
      await delegate.update({ where: { id: configId }, data: scalarColumns(table, snapshot) });

      const options = snapshot['options'];
      if (table === 'fieldDefinition' && Array.isArray(options)) {
        await replayOptions(configId, options as Record<string, unknown>[]);
      }
    },
    { timeout: 30_000, maxWait: 5_000 },
  );
}

/** Restore each option to its snapshotted state — including its snapshotted
 *  isDeleted, so an option already retired before the edit stays retired.
 *  Options created during the edit are soft-deleted, never removed: an
 *  AuditLog diff may already reference a value chosen from them. */
async function replayOptions(
  fieldDefinitionId: string,
  snapshot: Record<string, unknown>[],
): Promise<void> {
  const keep = new Set<string>();

  for (const opt of snapshot) {
    const id = typeof opt['id'] === 'string' ? opt['id'] : null;
    if (!id) continue;
    keep.add(id);
    await prisma.picklistOption.updateMany({
      where: { id, fieldDefinitionId },
      data: {
        label: String(opt['label'] ?? ''),
        color: typeof opt['color'] === 'string' ? opt['color'] : null,
        displayOrder: Number(opt['displayOrder'] ?? 0),
        isDeleted: opt['isDeleted'] === true,
      },
    });
  }

  await prisma.picklistOption.updateMany({
    where: { fieldDefinitionId, id: { notIn: [...keep] }, isDeleted: false },
    data: { isDeleted: true },
  });
}

// ── helpers ───────────────────────────────────────────────────────────────

interface RowDelegate {
  update: (a: unknown) => Promise<unknown>;
  updateMany: (a: unknown) => Promise<unknown>;
  findUnique: (a: unknown) => Promise<{ moduleId?: string } | null>;
}

function rowDelegate(client: typeof prisma, table: string): RowDelegate {
  return (client as unknown as Record<string, RowDelegate>)[table]!;
}

/** The forward-path services take a module SLUG, not an id. */
async function moduleSlugFor(table: string, configId: string): Promise<string> {
  const row = await rowDelegate(prisma, table).findUnique({
    where: { id: configId },
    select: { moduleId: true },
  });
  if (!row?.moduleId) throw new ConfigError('Config object not found', 404, 'NOT_FOUND');

  const module = await prisma.moduleDefinition.findUnique({
    where: { id: row.moduleId },
    select: { slug: true },
  });
  if (!module) throw new ConfigError('Module not found', 404, 'NOT_FOUND');
  return module.slug;
}

/**
 * Take a config row in or out of service. Config tables use `isDeleted`, but
 * Layout has only `isActive` — writing `isDeleted` to it throws before it ever
 * reaches the database. Read the flag from the DMMF so this stays correct for
 * every config table without naming one.
 */
async function setLive(table: string, id: string, live: boolean): Promise<void> {
  const model = Prisma.dmmf.datamodel.models.find(
    (m) => m.name.toLowerCase() === table.toLowerCase(),
  );
  const names = new Set(model?.fields.map((f) => f.name) ?? []);

  const data = names.has('isDeleted')
    ? { isDeleted: !live }
    : names.has('isActive')
      ? { isActive: live }
      : null;
  if (!data) throw new ConfigError('This change type cannot be reverted', 422, 'GUARDRAIL');

  await rowDelegate(prisma, table).update({ where: { id }, data });
}

/** Three reorder snapshot shapes exist across the config services. Accept all
 *  of them so rows already written stay revertible. */
function orderedIdsFromSnapshot(before: unknown): string[] | null {
  if (Array.isArray(before)) {
    if (before.every((v) => typeof v === 'string')) return before as string[];
    if (before.every((v) => v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string')) {
      return (before as { id: string }[]).map((r) => r.id);
    }
    return null;
  }
  const ids = (before as { orderedIds?: unknown } | null)?.orderedIds;
  return Array.isArray(ids) && ids.every((v) => typeof v === 'string') ? (ids as string[]) : null;
}

/** Snapshots include relations (the log viewer wants them) but only scalar
 *  columns can be written back — a relation key like `options: []` makes
 *  prisma.update() throw. Filter by DMMF so this needs no table names. */
function scalarColumns(table: string, snapshot: Record<string, unknown>): Record<string, unknown> {
  const model = Prisma.dmmf.datamodel.models.find(
    (m) => m.name.toLowerCase() === table.toLowerCase(),
  );
  if (!model) throw new ConfigError('This change type cannot be reverted', 422, 'GUARDRAIL');

  const scalars = model.fields.filter((f) => f.kind !== 'object');
  const allowed = new Set(
    scalars.map((f) => f.name).filter((n) => n !== 'id' && n !== 'createdAt' && n !== 'updatedAt'),
  );
  const jsonColumns = new Set(scalars.filter((f) => f.type === 'Json').map((f) => f.name));

  return Object.fromEntries(
    Object.entries(snapshot)
      .filter(([k]) => allowed.has(k))
      // A nullable Json column snapshotted as null must go back as DbNull —
      // Prisma rejects a bare null for Json fields.
      .map(([k, v]) => [k, v === null && jsonColumns.has(k) ? Prisma.DbNull : v]),
  );
}
