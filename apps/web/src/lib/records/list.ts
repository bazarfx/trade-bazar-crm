/**
 * The list repository for the generic module screen.
 *
 * This is THE ONE FILE above `StorageResolver` that is allowed to know a core
 * module is a real table and an Admin-created module is a row in `records`.
 * Everything above it — the page, the toolbar, the table, the cells — receives
 * a flat, field-keyed row and cannot tell the two apart. If a component ever
 * branches on a module slug, that branch is a bug.
 *
 * TODO(record engine): fold `DELEGATE_SHAPES` into `StorageResolver` and
 * delete this file's knowledge of it. The resolver already owns the delegate,
 * the JSONB container and the flatten; what it does not model yet is that the
 * core tables are not uniform — and inventing that shape here, ahead of the
 * write path that has to live with it too, would guess at the interface.
 */
import 'server-only';
import { prisma } from '@crm/db';
import { StorageResolver, type FieldMeta, type PermissionEngine } from '@crm/core';

/** A row as the screen sees it: flat, field-keyed and JSON-safe. */
export interface RecordRow extends Record<string, unknown> {
  id: string;
}

export interface ListResult {
  rows: RecordRow[];
  total: number;
}

/**
 * The slice of a Prisma delegate this file uses. Written structurally because
 * the delegate is chosen at runtime from config — `prisma[resolver.delegate]`
 * has no static type, and every delegate satisfies this shape.
 */
interface ListDelegate {
  findMany(args: {
    where: Record<string, unknown>;
    select: Record<string, boolean>;
    orderBy: Record<string, 'asc' | 'desc'>;
    take: number;
    skip: number;
  }): Promise<Record<string, unknown>[]>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
}

/**
 * What each table physically carries. The core tables are deliberately not
 * uniform — users are deactivated rather than deleted, deposits are immutable
 * ledger rows with neither a delete path nor a JSONB container — and asking
 * Prisma for a column a table does not have throws at query time rather than
 * quietly returning nothing. So this is stated, never assumed.
 */
interface DelegateShape {
  /** column marking a row soft-deleted; null = this table has no delete path */
  softDeleteColumn: string | null;
  /** false = no `custom` / `data` JSONB container on this table */
  hasJsonContainer: boolean;
  /** where-keys `scopeFilter` may legally use against this table */
  scopeKeys: readonly string[];
}

/** The generic table's shape, and the fallback for any delegate not listed. */
const GENERIC_SHAPE: DelegateShape = {
  softDeleteColumn: 'isDeleted',
  hasJsonContainer: true,
  scopeKeys: ['ownerId', 'owner'],
};

const DELEGATE_SHAPES: Record<string, DelegateShape> = {
  lead: { softDeleteColumn: 'isDeleted', hasJsonContainer: true, scopeKeys: ['ownerId', 'groupId', 'owner'] },
  deal: { softDeleteColumn: 'isDeleted', hasJsonContainer: true, scopeKeys: ['ownerId', 'owner'] },
  campaign: { softDeleteColumn: 'isDeleted', hasJsonContainer: true, scopeKeys: [] },
  // Users are deactivated, never row-deleted: `isActive` is a state the list
  // still has to show, so there is nothing to filter out here.
  user: { softDeleteColumn: null, hasJsonContainer: true, scopeKeys: [] },
  deposit: { softDeleteColumn: null, hasJsonContainer: false, scopeKeys: [] },
  record: GENERIC_SHAPE,
};

/** Matches nothing, on every delegate. The fail-closed answer. */
const DENY_ALL: Record<string, unknown> = { id: { in: [] as string[] } };

/**
 * Narrow the actor's scope filter to what this table can actually express.
 *
 * `scopeFilter` speaks ownership — `ownerId`, `groupId`, `owner.departmentId`
 * — and not every module's storage carries those columns. Passing one through
 * to a table that lacks it throws; DROPPING it would widen the result set past
 * the actor's scope, which is exactly the leak the fail-closed rule exists to
 * prevent. So an inexpressible scope denies everything instead.
 */
function scopeWhere(shape: DelegateShape, scope: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(scope);
  // `{}` is ALL or Admin — the engine's only "no restriction" answer.
  if (keys.length === 0) return {};
  // `id` is how the engine itself says "see nothing"; every table has it.
  if (keys.every((k) => k === 'id' || shape.scopeKeys.includes(k))) return scope;
  return DENY_ALL;
}

/**
 * React hands these rows to a client component, and the RSC serialiser refuses
 * anything that is not a plain value — a Prisma `Decimal` is a class instance
 * and throws on the boundary. Dates leave as ISO strings rather than `Date`s so
 * the cell formats them identically on both sides of a hydration; a money value
 * leaves as its exact digits, because a `Number()` round-trip loses precision.
 */
function plain(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);

  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return value;
  if (kind === 'bigint') return String(value);
  if (kind !== 'object') return null;

  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = plain(v);
    return out;
  }
  return String(value);
}

export interface ListRecordsParams {
  module: { slug: string; isCore: boolean };
  /**
   * The fields the caller may see, already stripped of hidden ones. Only these
   * keys are selected and only these keys come back, so a field hidden by the
   * permission matrix never leaves the server — hiding it in the UI is not a
   * security control.
   */
  fields: FieldMeta[];
  engine: PermissionEngine;
  take: number;
  skip?: number;
}

export async function listRecords({
  module,
  fields,
  engine,
  take,
  skip = 0,
}: ListRecordsParams): Promise<ListResult> {
  const resolver = new StorageResolver({ slug: module.slug, isCore: module.isCore, fields });
  const delegateName = resolver.delegate;
  const shape = DELEGATE_SHAPES[delegateName] ?? GENERIC_SHAPE;

  const delegate = (prisma as unknown as Record<string, ListDelegate | undefined>)[delegateName];
  // A module flagged core whose table does not exist is a config error. Showing
  // nothing is wrong but safe; falling through to another table would not be.
  if (!delegate) return { rows: [], total: 0 };

  const where: Record<string, unknown> = {
    ...resolver.discriminator,
    ...(shape.softDeleteColumn === null ? {} : { [shape.softDeleteColumn]: false }),
    // scopeFilter belongs HERE, in the repository — a controller can be
    // forgotten, and every list on this screen goes through this one call.
    ...scopeWhere(shape, engine.scopeFilter(module.slug)),
  };

  // Explicit select, never the whole row: `users` carries a password hash that
  // has no business being read, let alone travelling to a client component.
  const select: Record<string, boolean> = { id: true };
  if (shape.hasJsonContainer) select[resolver.jsonColumn] = true;
  for (const f of fields) if (f.systemColumn) select[f.systemColumn] = true;

  const [rows, total] = await Promise.all([
    delegate.findMany({ where, select, orderBy: { createdAt: 'desc' }, take, skip }),
    delegate.count({ where }),
  ]);

  return {
    rows: rows.map((row) => {
      const flat = resolver.flatten(row);
      const out: Record<string, unknown> = {};
      for (const f of fields) out[f.key] = plain(flat[f.key]);
      // `id` is written LAST, from the database row rather than the flattened
      // one. Nothing stops an Admin creating a field whose key is `id`, and a
      // row whose identity had been overwritten by a field value would collide
      // with its neighbours as a React key and open the wrong record.
      out['id'] = String(row['id'] ?? '');
      return out as RecordRow;
    }),
    total,
  };
}
