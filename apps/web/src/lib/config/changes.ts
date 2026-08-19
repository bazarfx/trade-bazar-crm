/**
 * Read side of ConfigChangeLog — the "what changed, by whom, can I undo it"
 * list behind the admin history screen. The write side lives in service.ts;
 * this file never mutates anything.
 */
import 'server-only';
import { prisma } from '@crm/db';
import { PermissionEngine } from '@crm/core';
import type { ConfigAction, ConfigType, SpecialPermission } from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { canReadModuleConfig, hasConfigPermission } from '@/lib/config/access';
import { ConfigError } from '@/lib/config/service';

export interface ConfigChangeSummary {
  id: string;
  configType: ConfigType;
  configId: string;
  action: ConfigAction;
  actorName: string;
  before: unknown;
  after: unknown;
  isReverted: boolean;
  revertedAt: Date | null;
  createdAt: Date;
  /** false when reverted already, or when a newer un-reverted change touches
   *  the same object — reverting past it would silently clobber it. */
  isRevertible: boolean;
  /** true when the snapshots were withheld because the actor could not read
   *  that config object directly. The row still lists — who changed what and
   *  when is the point of the log — but before/after come back null and the
   *  UI renders "details hidden". */
  redacted: boolean;
}

export interface ChangeListFilter {
  configType?: ConfigType;
  configId?: string;
  limit?: number;
}

/** Anyone who can MAKE config changes must be able to see and undo their own
 *  history, hence the config specials next to VIEW_AUDIT_LOGS. */
const CAN_VIEW: readonly SpecialPermission[] = [
  'VIEW_AUDIT_LOGS',
  'MANAGE_FIELDS_LAYOUTS',
  'MANAGE_STATUSES',
];

/** Same fail-closed style as assertConfigPermission: no grant, no list. */
function assertCanViewChanges(principal: Principal): void {
  const allowed =
    principal.actor.isAdmin ||
    CAN_VIEW.some((p) => principal.permissions.specials.has(p));
  if (!allowed) {
    throw new ConfigError('Requires the "VIEW_AUDIT_LOGS" permission', 403, 'FORBIDDEN');
  }
}

export async function listChanges(
  principal: Principal,
  filter: ChangeListFilter,
): Promise<ConfigChangeSummary[]> {
  assertCanViewChanges(principal);

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);

  const rows = await prisma.configChangeLog.findMany({
    where: {
      ...(filter.configType ? { configType: filter.configType } : {}),
      ...(filter.configId ? { configId: filter.configId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { actor: { select: { fullName: true } } },
  });

  const redacted = await redactedRowIds(principal, rows);

  // Rows arrive newest-first, so by the time a row is inspected every newer
  // change to the same object has already passed through this loop — one pass
  // over the window is enough to compute isRevertible.
  const newerUnreverted = new Set<string>();
  return rows.map((row) => {
    const key = `${row.configType}:${row.configId}`;
    const isRevertible = !row.isReverted && !newerUnreverted.has(key);
    if (!row.isReverted) newerUnreverted.add(key);
    const isRedacted = redacted.has(row.id);
    return {
      id: row.id,
      configType: row.configType as ConfigType,
      configId: row.configId,
      action: row.action as ConfigAction,
      actorName: row.actor.fullName,
      before: isRedacted ? null : row.before,
      after: isRedacted ? null : row.after,
      isReverted: row.isReverted,
      revertedAt: row.revertedAt,
      createdAt: row.createdAt,
      isRevertible,
      redacted: isRedacted,
    };
  });
}

// ── snapshot redaction ────────────────────────────────────────────────────

/** Only what redaction reads. Prisma's JsonValue widens to unknown. */
interface SnapshotRow {
  id: string;
  configType: string;
  configId: string;
  action: string;
  before: unknown;
  after: unknown;
}

/**
 * Which rows must travel without their snapshots.
 *
 * `before`/`after` hold whole config rows, so returning them unfiltered hands
 * a VIEW_AUDIT_LOGS holder the very field keys PermissionEngine hides from
 * them, and the soft-deleted rows `listFields` gates behind
 * MANAGE_FIELDS_LAYOUTS. The gate on the log is deliberately broader than the
 * gates on the data inside it, so the payload is re-checked against those same
 * gates here rather than inheriting the looser one.
 *
 * Two queries for the whole page, never one per row: the module id comes off
 * the snapshot itself (or off configId, which IS the module id for a reorder),
 * and every slug resolves in a single lookup.
 */
async function redactedRowIds(
  principal: Principal,
  rows: readonly SnapshotRow[],
): Promise<ReadonlySet<string>> {
  // Admins see every field of every module, so there is nothing to strip and
  // no reason to pay for the module lookup.
  if (principal.actor.isAdmin) return new Set();

  const moduleIdByRow = new Map<string, string | null>();
  const moduleIds = new Set<string>();
  for (const row of rows) {
    const moduleId = moduleIdOf(row);
    moduleIdByRow.set(row.id, moduleId);
    if (moduleId !== null) moduleIds.add(moduleId);
  }

  const modules =
    moduleIds.size > 0
      ? await prisma.moduleDefinition.findMany({
          where: { id: { in: [...moduleIds] } },
          select: { id: true, slug: true },
        })
      : [];
  const slugById = new Map(modules.map((m) => [m.id, m.slug]));

  const engine = new PermissionEngine(principal.actor, principal.permissions);
  const hiddenBySlug = new Map<string, ReadonlySet<string>>();
  const hiddenFor = (slug: string): ReadonlySet<string> => {
    let hidden = hiddenBySlug.get(slug);
    if (!hidden) {
      hidden = engine.hiddenFields(slug);
      hiddenBySlug.set(slug, hidden);
    }
    return hidden;
  };

  const out = new Set<string>();
  for (const row of rows) {
    const moduleId = moduleIdByRow.get(row.id) ?? null;
    const slug = moduleId === null ? undefined : slugById.get(moduleId);

    // A snapshot whose module cannot be resolved cannot be checked against
    // anything — withhold it rather than guess.
    if (slug === undefined || !canReadModuleConfig(principal, slug)) {
      out.add(row.id);
      continue;
    }

    // A retired config row is admin-only on the read paths (listFields gates
    // includeDeleted); the log must not be the way around that.
    if (snapshotIsDeleted(row) && !hasConfigPermission(principal, row.configType as ConfigType)) {
      out.add(row.id);
      continue;
    }

    if (row.configType === 'FIELD' && touchesHiddenField(hiddenFor(slug), row)) {
      out.add(row.id);
    }
  }

  return out;
}

function isSnapshotObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Where the module id lives depends on the entry: a REORDER is logged against
 * the module itself (configId IS the module id), and so is a MODULE change;
 * everything else snapshots a row that carries moduleId.
 *
 * A PICKLIST_OPTION snapshot carries fieldDefinitionId instead, so it resolves
 * to nothing and is withheld — resolving it would cost a query per row, and
 * nothing writes that configType today.
 */
function moduleIdOf(row: SnapshotRow): string | null {
  if (row.action === 'REORDER' || row.configType === 'MODULE') return row.configId;
  for (const snapshot of [row.after, row.before]) {
    if (isSnapshotObject(snapshot) && typeof snapshot.moduleId === 'string') {
      return snapshot.moduleId;
    }
  }
  return null;
}

function snapshotIsDeleted(row: SnapshotRow): boolean {
  return [row.before, row.after].some(
    (snapshot) => isSnapshotObject(snapshot) && snapshot.isDeleted === true,
  );
}

/**
 * A FIELD snapshot names its field by key, which is what hiddenFields holds.
 * An id-only snapshot — a reorder logs just the ordered id array — cannot be
 * proven free of hidden fields, so it counts as touching one whenever the
 * actor has any hidden field in that module.
 */
function touchesHiddenField(hidden: ReadonlySet<string>, row: SnapshotRow): boolean {
  if (hidden.size === 0) return false;
  let namedAField = false;
  for (const snapshot of [row.before, row.after]) {
    if (isSnapshotObject(snapshot) && typeof snapshot.key === 'string') {
      namedAField = true;
      if (hidden.has(snapshot.key)) return true;
    }
  }
  return !namedAField;
}
