/**
 * The scoped list repository.
 *
 * This is THE ONE FILE above `StorageResolver` that is allowed to know a core
 * module is a real table and an Admin-created module is a row in `records`.
 * Everything above it — the page, the toolbar, the table, the cells — receives
 * a flat, field-keyed row and cannot tell the two apart. If a component ever
 * branches on a module slug, that branch is a bug.
 *
 * It is also where `scopeFilter` is applied. That belongs in the repository and
 * nowhere else: a controller can be forgotten, and every list in the product
 * comes through this one call.
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
import { serialiseMany, type RecordRow } from '@/lib/records/serialise';

export type { RecordRow };

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
 * How one ownership key from `scopeFilter` is expressed against a given table.
 * Returning null means "this table cannot answer that question" — the caller
 * then denies everything rather than dropping the condition.
 */
type ScopeExpression = (value: unknown) => Record<string, unknown> | null;

/**
 * What each table physically carries. The core tables are deliberately not
 * uniform — users are deactivated rather than deleted, deposits are immutable
 * ledger rows with neither a delete path nor a JSONB container — and asking
 * Prisma for a column a table does not have throws at query time rather than
 * quietly returning nothing. So this is stated, never assumed.
 *
 * Keyed by PRISMA MODEL, not by module slug: which table a module lives in is
 * a storage fact `StorageResolver` owns, and slugs are Admin-editable data.
 */
interface DelegateShape {
  /** column marking a row soft-deleted; null = this table has no delete path */
  softDeleteColumn: string | null;
  /** false = no `custom` / `data` JSONB container on this table */
  hasJsonContainer: boolean;
  /**
   * How this table expresses each ownership key `scopeFilter` can emit.
   * A key with no entry here is inexpressible on this table -> deny all.
   */
  scope: Record<string, ScopeExpression>;
}

/**
 * The DEPARTMENT scope arrives as `{ owner: { departmentId } }`. Pull the id
 * back out so each table can re-express it against its own columns.
 *
 * A null department means the actor belongs to no department, and DEPARTMENT
 * scope then covers nothing. Passing the null through would instead match every
 * row whose owner is ALSO departmentless — a widening, so it denies.
 */
function departmentOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as { departmentId?: unknown }).departmentId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Tables carrying a real `ownerId` column and an `owner` relation to User. */
const OWNER_COLUMN_SCOPE: Record<string, ScopeExpression> = {
  ownerId: (v) => ({ ownerId: v }),
  owner: (v) => {
    const departmentId = departmentOf(v);
    return departmentId ? { owner: { departmentId } } : null;
  },
};

/**
 * Which table can express which scope. Anything missing DENIES — spelled out
 * per table because a silently dropped condition is a permission leak:
 *
 *   lead      OWN ✓ ownerId · GROUP ✓ groupId · DEPARTMENT ✓ owner relation
 *   deal      OWN ✓ ownerId · GROUP ✗ NO groupId COLUMN · DEPARTMENT ✓
 *   campaign  ✗ NO OWNERSHIP COLUMNS AT ALL — a campaign has no owner, no
 *             group and no department, so anything but ALL sees nothing
 *   user      ✗ no ownerId and no groupId column. A user is not owned: OWN is
 *             the actor's own row, GROUP is the GroupMember join table, and
 *             DEPARTMENT is the row's OWN departmentId, not an owner's
 *   deposit   ✗ no ownership columns. A deposit belongs to whoever owns its
 *             deal, one hop away — so OWN and DEPARTMENT resolve through
 *             `deal`, and GROUP denies because Deal has no groupId either
 *   record    OWN ✓ ownerId · GROUP ✗ THE GENERIC TABLE HAS NO groupId COLUMN
 *             (promoted slots are name/email/phone/language/owner/status/amount)
 *             · DEPARTMENT ✓ owner relation
 *
 * The two ✗ GROUP rows are the ones to watch: a role given GROUP scope on
 * Deals or on an Admin-created module sees NOTHING there, deliberately, until
 * those tables carry a group. That is the fail-closed answer, and it is loud —
 * an empty list gets reported; a leak does not.
 */
const GENERIC_SHAPE: DelegateShape = {
  softDeleteColumn: 'isDeleted',
  hasJsonContainer: true,
  scope: OWNER_COLUMN_SCOPE,
};

const DELEGATE_SHAPES: Record<string, DelegateShape> = {
  lead: {
    softDeleteColumn: 'isDeleted',
    hasJsonContainer: true,
    scope: { ...OWNER_COLUMN_SCOPE, groupId: (v) => ({ groupId: v }) },
  },
  deal: { softDeleteColumn: 'isDeleted', hasJsonContainer: true, scope: OWNER_COLUMN_SCOPE },
  campaign: { softDeleteColumn: 'isDeleted', hasJsonContainer: true, scope: {} },
  // Users are deactivated, never row-deleted: `isActive` is a state the list
  // still has to show, so there is nothing to filter out here.
  user: {
    softDeleteColumn: null,
    hasJsonContainer: true,
    scope: {
      // OWN on the Profile module is the actor's own row — a user's identity
      // IS its ownership. Without this, a role scoped OWN on users could not
      // see itself, which is the one row that scope is for.
      ownerId: (v) => ({ id: v }),
      groupId: (v) => ({ groups: { some: { groupId: v } } }),
      owner: (v) => {
        const departmentId = departmentOf(v);
        return departmentId ? { departmentId } : null;
      },
    },
  },
  deposit: {
    softDeleteColumn: null,
    hasJsonContainer: false,
    scope: {
      ownerId: (v) => ({ deal: { ownerId: v } }),
      owner: (v) => {
        const departmentId = departmentOf(v);
        return departmentId ? { deal: { owner: { departmentId } } } : null;
      },
    },
  },
  record: GENERIC_SHAPE,
};

/** Matches nothing, on every delegate. The fail-closed answer. */
const DENY_ALL: Record<string, unknown> = { id: { in: [] as string[] } };

/**
 * Translate the actor's scope filter into what THIS table can express.
 *
 * `scopeFilter` speaks one ownership vocabulary — `ownerId`, `groupId`,
 * `owner.departmentId` — and not every table carries those columns under those
 * names. Passing a key through to a table that lacks it throws; DROPPING it
 * would widen the result set past the actor's scope, which is exactly the leak
 * the fail-closed rule exists to prevent. So a scope this table cannot express
 * denies everything instead.
 */
function scopeWhere(shape: DelegateShape, scope: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(scope);
  // `{}` is ALL or Admin — the engine's only "no restriction" answer.
  if (entries.length === 0) return {};

  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    // `id` is how the engine itself says "see nothing"; every table has it.
    if (key === 'id') {
      out['id'] = value;
      continue;
    }

    const express = shape.scope[key];
    if (!express) return DENY_ALL;
    const fragment = express(value);
    if (!fragment) return DENY_ALL;

    for (const [k, v] of Object.entries(fragment)) {
      // Two conditions on one where-key would silently drop one of them, and
      // the one that survives may be the weaker. Deny rather than guess.
      if (k in out) return DENY_ALL;
      out[k] = v;
    }
  }
  return out;
}

export interface ListRecordsParams {
  module: { slug: string; isCore: boolean };
  /**
   * The fields to project. Hidden ones are stripped again on serialisation, so
   * a caller passing its whole field list leaks nothing — but passing only the
   * columns on screen keeps a 40-field module from selecting 40 columns to
   * draw 12 of them.
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
  // `NEVER_SERIALISED` in the serialiser is the second lock on the same door.
  const select: Record<string, boolean> = { id: true };
  if (shape.hasJsonContainer) select[resolver.jsonColumn] = true;
  for (const f of fields) if (f.systemColumn) select[f.systemColumn] = true;

  const [rows, total] = await Promise.all([
    delegate.findMany({ where, select, orderBy: { createdAt: 'desc' }, take, skip }),
    delegate.count({ where }),
  ]);

  const flattened = rows.map((row) => {
    const flat = resolver.flatten(row);
    // The id comes from the DATABASE row, not the flattened one: an Admin can
    // create a field keyed `id`, and `flatten` would have written its value
    // over the record's identity. The serialiser reads `row.id` last.
    flat['id'] = row['id'];
    return flat;
  });

  // Serialisation, not the caller, decides what leaves the server.
  return { rows: serialiseMany(engine, module.slug, flattened, fields), total };
}
