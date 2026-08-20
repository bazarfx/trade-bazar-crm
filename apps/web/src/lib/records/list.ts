/**
 * The scoped record repository.
 *
 * This is THE ONE FILE above `StorageResolver` that is allowed to know a core
 * module is a real table and an Admin-created module is a row in `records`.
 * Everything above it — the record service, the page, the toolbar, the table,
 * the cells — receives a flat, field-keyed row and cannot tell the two apart.
 * If anything else branches on a module slug, that branch is a bug.
 *
 * It is also where `scopeFilter` is applied. That belongs in the repository and
 * nowhere else: a controller can be forgotten, and every read in the product —
 * the list AND the by-id load behind every edit, delete and timeline — comes
 * through the two calls in this file.
 *
 * TODO(record engine): fold `DELEGATE_SHAPES` into `StorageResolver` and
 * delete this file's knowledge of it. The resolver already owns the delegate,
 * the JSONB container and the flatten; what it does not model yet is that the
 * core tables are not uniform. Now that the write path lives with the same
 * table (`records/service.ts` reads owner/status/language columns and the
 * duplicate-flag capability off it), the interface is finally visible enough
 * to move — but moving it is a change to a package the worker also compiles,
 * so it waits for the webhook slice that will be its second caller.
 */
import 'server-only';
import { prisma } from '@crm/db';
import {
  StorageResolver,
  type FieldMeta,
  type OwnedRecord,
  type PermissionEngine,
} from '@crm/core';
import type { ActorContext } from '@crm/shared';
import { serialiseMany, type RecordRow } from '@/lib/records/serialise';

export type { RecordRow };

export interface ListResult {
  rows: RecordRow[];
  total: number;
}

/** A database row, or a payload heading for one. Untyped by construction: the
 *  delegate is chosen at runtime from config, so no static row type exists. */
export type Row = Record<string, unknown>;

/**
 * The slice of a Prisma delegate this file uses. Written structurally because
 * the delegate is chosen at runtime from config — `prisma[resolver.delegate]`
 * has no static type, and every delegate satisfies this shape.
 *
 * Nothing outside this file holds one: callers get it from `recordDelegate()`,
 * which is also what keeps "which table" from leaking upwards.
 */
export interface RecordDelegate {
  findMany(args: {
    where: Row;
    select: Row;
    orderBy: Record<string, 'asc' | 'desc'>;
    take: number;
    skip: number;
  }): Promise<Row[]>;
  findFirst(args: { where: Row; select: Row }): Promise<Row | null>;
  count(args: { where: Row }): Promise<number>;
  create(args: { data: Row; select: Row }): Promise<Row>;
  update(args: { where: { id: string }; data: Row; select: Row }): Promise<Row>;
}

/**
 * How one ownership key from `scopeFilter` is expressed against a given table.
 * Returning null means "this table cannot answer that question" — the caller
 * then denies everything rather than dropping the condition.
 */
type ScopeExpression = (value: unknown) => Row | null;

/**
 * How a table answers the per-ROW ownership question `PermissionEngine.can`
 * asks — the same question `scope` answers for a whole query, one row at a
 * time. Both live on the shape so they can never disagree about which column
 * carries an owner.
 */
interface OwnershipShape {
  /** extra `select` fragment the ownership read needs */
  select: Row;
  /** derive the OwnedRecord the engine checks OWN / GROUP / DEPARTMENT against */
  read(row: Row, actor: ActorContext): OwnedRecord;
}

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
  /**
   * The `AuditLog.entityType` discriminator for rows in this table — the
   * PRISMA MODEL NAME, never a module slug. A slug is Admin-editable data and
   * renaming one would orphan every timeline entry written before the rename;
   * the model name cannot change without a migration. Every write path and
   * `getTimeline` read this same value, which is what makes the timeline the
   * log rather than a second store.
   */
  entityType: string;
  /** column marking a row soft-deleted; null = this table has no delete path */
  softDeleteColumn: string | null;
  /** false = no `custom` / `data` JSONB container on this table */
  hasJsonContainer: boolean;
  /** column carrying the record's owner; null = rows here are not owned */
  ownerColumn: string | null;
  /** column carrying the Status foreign key; null = this table has no status */
  statusColumn: string | null;
  /** column carrying the record's language — half of the dedupe match key */
  languageColumn: string | null;
  /** column stamping who created the row; null = this table does not record it */
  createdByColumn: string | null;
  /**
   * Whether a row here can be created from field values alone.
   *
   * False is not a permission — it says the table needs something no
   * FieldDefinition can supply, so a field-driven insert would fail at the
   * database with half a record's worth of intent. A User is an ACCOUNT
   * (password hash, role, invite flow — spec §5.5, `lib/config/users.ts`) and
   * a Deposit is an immutable ledger row the webhook writes with its source
   * event attached (§8.3). Both have their own create paths.
   */
  canInsertRows: boolean;
  /**
   * Whether a `DuplicateFlag` row may point at this table. `DuplicateFlag`
   * carries `primaryLeadId` / `candidateLeadId` FOREIGN KEYS INTO `Lead`, so a
   * flag written for any other table would violate them at insert time.
   *
   * TODO(dedupe): generalising the review queue past one table is a MIGRATION
   * (entityType + entityId on DuplicateFlag), not a branch here or upstream.
   */
  canFlagDuplicates: boolean;
  /**
   * How this table expresses each ownership key `scopeFilter` can emit.
   * A key with no entry here is inexpressible on this table -> deny all.
   */
  scope: Record<string, ScopeExpression>;
  ownership: OwnershipShape;
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

/** A non-empty string, or null. Row values arrive as `unknown`. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `departmentId` off a selected `{ owner: { departmentId } }` relation. */
function relationDepartment(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  return str((value as { departmentId?: unknown }).departmentId);
}

/** Tables carrying a real `ownerId` column and an `owner` relation to User. */
const OWNER_COLUMN_SCOPE: Record<string, ScopeExpression> = {
  ownerId: (v) => ({ ownerId: v }),
  owner: (v) => {
    const departmentId = departmentOf(v);
    return departmentId ? { owner: { departmentId } } : null;
  },
};

/** Per-row ownership for the tables with an `ownerId` column and no group. */
const OWNER_COLUMN_OWNERSHIP: OwnershipShape = {
  select: { ownerId: true, owner: { select: { departmentId: true } } },
  read: (row) => ({
    ownerId: str(row['ownerId']),
    // No `groupId` column, so GROUP scope on this table denies — the same
    // answer `scope` gives, deliberately.
    groupId: null,
    departmentId: relationDepartment(row['owner']),
  }),
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
  entityType: 'Record',
  softDeleteColumn: 'isDeleted',
  hasJsonContainer: true,
  ownerColumn: 'ownerId',
  statusColumn: 'statusId',
  languageColumn: 'language',
  createdByColumn: 'createdById',
  canFlagDuplicates: false,
  canInsertRows: true,
  scope: OWNER_COLUMN_SCOPE,
  ownership: OWNER_COLUMN_OWNERSHIP,
};

const DELEGATE_SHAPES: Record<string, DelegateShape> = {
  lead: {
    entityType: 'Lead',
    softDeleteColumn: 'isDeleted',
    hasJsonContainer: true,
    ownerColumn: 'ownerId',
    statusColumn: 'statusId',
    languageColumn: 'language',
    createdByColumn: 'createdById',
    // The only table `DuplicateFlag` can reference — see the field comment.
    canFlagDuplicates: true,
    canInsertRows: true,
    scope: { ...OWNER_COLUMN_SCOPE, groupId: (v) => ({ groupId: v }) },
    ownership: {
      select: { ownerId: true, groupId: true, owner: { select: { departmentId: true } } },
      read: (row) => ({
        ownerId: str(row['ownerId']),
        groupId: str(row['groupId']),
        departmentId: relationDepartment(row['owner']),
      }),
    },
  },
  deal: {
    entityType: 'Deal',
    softDeleteColumn: 'isDeleted',
    hasJsonContainer: true,
    ownerColumn: 'ownerId',
    statusColumn: 'statusId',
    languageColumn: 'language',
    // Deal has no createdById: a deal is created BY the conversion pipeline,
    // and `closedById` is the durable credit for it (spec §7.1).
    createdByColumn: null,
    canFlagDuplicates: false,
    canInsertRows: true,
    scope: OWNER_COLUMN_SCOPE,
    ownership: OWNER_COLUMN_OWNERSHIP,
  },
  campaign: {
    entityType: 'Campaign',
    softDeleteColumn: 'isDeleted',
    hasJsonContainer: true,
    ownerColumn: null,
    statusColumn: null,
    languageColumn: null,
    createdByColumn: null,
    canFlagDuplicates: false,
    canInsertRows: true,
    scope: {},
    // Nothing to read: every ownership answer is null, so OWN, GROUP and
    // DEPARTMENT all deny and only ALL sees a campaign.
    ownership: { select: {}, read: () => ({}) },
  },
  // Users are deactivated, never row-deleted: `isActive` is a state the list
  // still has to show, so there is nothing to filter out here.
  user: {
    entityType: 'User',
    softDeleteColumn: null,
    hasJsonContainer: true,
    // A user is not owned by anyone — its identity IS its ownership, which the
    // ownership read expresses and the write path must not try to stamp.
    ownerColumn: null,
    statusColumn: null,
    // `languages` is a multi-select of what a user SPEAKS, not the record's own
    // language, and a user is never dedupe-matched on it.
    languageColumn: null,
    createdByColumn: null,
    canFlagDuplicates: false,
    // An account, not a record — see `canInsertRows`.
    canInsertRows: false,
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
    ownership: {
      select: { id: true, departmentId: true, groups: { select: { groupId: true } } },
      read: (row, actor) => {
        // A user can belong to several groups while `OwnedRecord` carries one.
        // Hand the engine the group the actor SHARES, because "this row is in
        // one of my groups" is exactly the question GROUP scope asks; with no
        // shared group there is no answer that passes, so it denies.
        const memberships = Array.isArray(row['groups']) ? row['groups'] : [];
        const shared = memberships
          .map((m) => str((m as { groupId?: unknown }).groupId))
          .find((id): id is string => id !== null && actor.groupIds.includes(id));
        return {
          ownerId: str(row['id']),
          groupId: shared ?? null,
          departmentId: str(row['departmentId']),
        };
      },
    },
  },
  deposit: {
    entityType: 'Deposit',
    softDeleteColumn: null,
    hasJsonContainer: false,
    ownerColumn: null,
    statusColumn: null,
    languageColumn: null,
    createdByColumn: null,
    canFlagDuplicates: false,
    // A ledger row the webhook writes, with its source event — see above.
    canInsertRows: false,
    scope: {
      ownerId: (v) => ({ deal: { ownerId: v } }),
      owner: (v) => {
        const departmentId = departmentOf(v);
        return departmentId ? { deal: { owner: { departmentId } } } : null;
      },
    },
    ownership: {
      // One hop: a deposit belongs to whoever owns its deal, which is the same
      // route `scope` takes for the whole query.
      select: { deal: { select: { ownerId: true, owner: { select: { departmentId: true } } } } },
      read: (row) => {
        const deal = (row['deal'] ?? {}) as Row;
        return {
          ownerId: str(deal['ownerId']),
          groupId: null,
          departmentId: relationDepartment(deal['owner']),
        };
      },
    },
  },
  record: GENERIC_SHAPE,
};

/** Matches nothing, on every delegate. The fail-closed answer. */
const DENY_ALL: Row = { id: { in: [] as string[] } };

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
function scopeWhere(shape: DelegateShape, scope: Row): Row {
  const entries = Object.entries(scope);
  // `{}` is ALL or Admin — the engine's only "no restriction" answer.
  if (entries.length === 0) return {};

  const out: Row = {};
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

// ── the storage handle every caller works through ─────────────────────────

/** What a caller knows about a module. `id` is needed only to WRITE, because
 *  the generic table pins a new row to its module by id. */
export interface ModuleRef {
  id?: string;
  slug: string;
  isCore: boolean;
}

/**
 * Everything the record service is allowed to know about where a module's
 * rows live: how to reach them, what the table physically carries, and how to
 * flatten a row back into field keys. It never learns WHICH table that is —
 * `delegateName` is opaque to it and only ever handed back to this file.
 */
export interface Storage {
  resolver: StorageResolver;
  shape: DelegateShape;
  delegateName: string;
  /** columns pinning a NEW row to this module. `{}` for a core table. */
  writeDiscriminator(): Row;
}

export type StorageShape = DelegateShape;

export function storageFor(module: ModuleRef, fields: FieldMeta[]): Storage {
  const resolver = new StorageResolver({ slug: module.slug, isCore: module.isCore, fields });
  const delegateName = resolver.delegate;
  return {
    resolver,
    delegateName,
    shape: DELEGATE_SHAPES[delegateName] ?? GENERIC_SHAPE,
    writeDiscriminator: () => {
      if (module.isCore) return {};
      // The read discriminator is a relation FILTER (`module: { slug }`); an
      // insert needs the foreign key itself. Nothing above this file knows the
      // generic table is discriminated at all, so it resolves here.
      if (!module.id) throw new Error(`Module "${module.slug}" needs an id to write a record`);
      return { moduleId: module.id };
    },
  };
}

/**
 * The delegate for this storage, off a Prisma client OR an open transaction.
 *
 * `client` is `unknown` on purpose: `PrismaClient` and `Prisma.TransactionClient`
 * share no useful static shape once the delegate is chosen by name at runtime,
 * and this is the single cast that hides that from every caller.
 *
 * Returns null when a module flagged core names a table that does not exist —
 * a config error. Reading nothing is wrong but safe; falling through to
 * another table would not be.
 */
export function recordDelegate(client: unknown, delegateName: string): RecordDelegate | null {
  const byName = client as Record<string, RecordDelegate | undefined>;
  return byName[delegateName] ?? null;
}

/**
 * The `where` every read of this module starts from: the module discriminator,
 * the soft-delete filter, and the actor's scope — applied HERE, in the
 * repository, because a caller can be forgotten.
 */
export function scopedWhere(storage: Storage, engine: PermissionEngine, moduleSlug: string): Row {
  return {
    ...storage.resolver.discriminator,
    ...(storage.shape.softDeleteColumn === null
      ? {}
      : { [storage.shape.softDeleteColumn]: false }),
    ...scopeWhere(storage.shape, engine.scopeFilter(moduleSlug)),
  };
}

/**
 * The projection for a set of fields.
 *
 * Explicit select, never the whole row: `users` carries a password hash that
 * has no business being read, let alone travelling to a client component.
 * `NEVER_SERIALISED` in the serialiser is the second lock on the same door.
 */
export function selectFor(storage: Storage, fields: FieldMeta[], withOwnership = false): Row {
  const select: Row = { id: true };
  if (storage.shape.hasJsonContainer) select[storage.resolver.jsonColumn] = true;
  for (const f of fields) if (f.systemColumn) select[f.systemColumn] = true;
  // Ownership last: its fragments are relation selects, which are strictly
  // more specific than the `true` a field column would have written.
  if (withOwnership) Object.assign(select, storage.shape.ownership.select);
  return select;
}

/** A row loaded by id, before anything decides what may leave the server. */
export interface FoundRecord {
  id: string;
  /** flat, field-keyed values — NOT yet serialised */
  values: Row;
  /** the raw selected row; the write path merges into its JSONB container */
  raw: Row;
  /** what `PermissionEngine.can(action, slug, record)` checks OWN/GROUP/DEPARTMENT against */
  owned: OwnedRecord;
}

export interface FindRecordParams {
  module: ModuleRef;
  fields: FieldMeta[];
  engine: PermissionEngine;
  actor: ActorContext;
  id: string;
  /** an open transaction, when the caller needs the read and its write atomic */
  client?: unknown;
}

/**
 * Load ONE record by id, through the same scope filter as the list.
 *
 * This exists so that fetching by id cannot skip the scope check — the classic
 * way a permission leak gets introduced is a detail route that resolves an id
 * directly and never asks whose row it is. Out of scope and non-existent are
 * the same answer here: null.
 */
export async function findRecordById({
  module,
  fields,
  engine,
  actor,
  id,
  client = prisma,
}: FindRecordParams): Promise<FoundRecord | null> {
  const storage = storageFor(module, fields);
  const delegate = recordDelegate(client, storage.delegateName);
  if (!delegate) return null;

  const row = await delegate.findFirst({
    where: { id, ...scopedWhere(storage, engine, module.slug) },
    select: selectFor(storage, fields, true),
  });
  if (!row) return null;

  const values = storage.resolver.flatten(row);
  // The id comes from the DATABASE row, not the flattened one: an Admin can
  // create a field keyed `id`, and `flatten` would have written its value over
  // the record's identity.
  values['id'] = row['id'];

  return {
    id: String(row['id']),
    values,
    raw: row,
    owned: storage.shape.ownership.read(row, actor),
  };
}

export interface ListRecordsParams {
  module: ModuleRef;
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
  const storage = storageFor(module, fields);
  const delegate = recordDelegate(prisma, storage.delegateName);
  // A module flagged core whose table does not exist is a config error. Showing
  // nothing is wrong but safe; falling through to another table would not be.
  if (!delegate) return { rows: [], total: 0 };

  const where = scopedWhere(storage, engine, module.slug);
  const select = selectFor(storage, fields);

  const [rows, total] = await Promise.all([
    delegate.findMany({ where, select, orderBy: { createdAt: 'desc' }, take, skip }),
    delegate.count({ where }),
  ]);

  const flattened = rows.map((row) => {
    const flat = storage.resolver.flatten(row);
    // The id comes from the DATABASE row, not the flattened one: an Admin can
    // create a field keyed `id`, and `flatten` would have written its value
    // over the record's identity. The serialiser reads `row.id` last.
    flat['id'] = row['id'];
    return flat;
  });

  // Serialisation, not the caller, decides what leaves the server.
  return { rows: serialiseMany(engine, module.slug, flattened, fields), total };
}
