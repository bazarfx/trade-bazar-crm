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
import { prisma, Prisma } from '@crm/db';
import {
  compileFilter,
  StorageResolver,
  type FieldLocation,
  type FieldMeta,
  type OwnedRecord,
  type PermissionEngine,
} from '@crm/core';
import {
  FIELD_TYPE_SPECS,
  filterFieldIssues,
  isGroup,
  type ActorContext,
  type FilterCondition,
  type FilterGroup,
  type FilterNode,
  type SortSpec,
} from '@crm/shared';
import { ConfigError } from '@/lib/config/service';
import { serialiseMany, type RecordRow } from '@/lib/records/serialise';

export type { RecordRow };

export interface ListResult {
  rows: RecordRow[];
  total: number;
  /** echoed back so a caller never has to re-derive what it actually got */
  page: number;
  pageSize: number;
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
    /** an ARRAY: a sort is a list of keys and always ends in a tiebreak */
    orderBy: Row[];
    take: number;
    skip: number;
  }): Promise<Row[]>;
  findFirst(args: { where: Row; select: Row }): Promise<Row | null>;
  count(args: { where: Row }): Promise<number>;
  create(args: { data: Row; select: Row }): Promise<Row>;
  update(args: { where: { id: string }; data: Row; select: Row }): Promise<Row>;
  /** One statement for a whole page of ids — what a bulk reassignment moves
   *  with. Never a `where` a caller built by hand: the ids come from a read
   *  that already went through `scopedWhere`. */
  updateMany(args: { where: Row; data: Row }): Promise<{ count: number }>;
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
  /**
   * Column carrying the TEAM a record belongs to; null = this table has no
   * group. Written by the assignment engine beside the owner: round-robin
   * picks a person out of a language group, and the group is what a floor
   * manager filters and reports on afterwards. Also what GROUP view scope
   * reads, which is why the two ✗ GROUP rows below are the same tables that
   * carry null here.
   */
  groupColumn: string | null;
  /** column carrying the Status foreign key; null = this table has no status */
  statusColumn: string | null;
  /** column carrying the record's language — half of the dedupe match key */
  languageColumn: string | null;
  /**
   * Column carrying WHERE a record came from — the permanent Source stamp
   * (spec §6.1). Null = this table has no source, and everything in it is
   * campaign-shaped as far as routing is concerned. Read by the assignment
   * engine, which routes an ARK-stamped record to the senior pool and
   * everything else to the language group.
   */
  sourceColumn: string | null;
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
  // The generic table has no groupId and no source: its promoted slots are
  // name/email/phone/language/owner/status/amount. An Admin-created module
  // therefore assigns by language group and pool without recording the group
  // on the row, and routes as CAMPAIGN.
  groupColumn: null,
  statusColumn: 'statusId',
  languageColumn: 'language',
  sourceColumn: null,
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
    groupColumn: 'groupId',
    statusColumn: 'statusId',
    languageColumn: 'language',
    sourceColumn: 'source',
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
    // No groupId column — see the GROUP scope table above — and no source: a
    // deal's origin is its linked lead, one hop away.
    groupColumn: null,
    statusColumn: 'statusId',
    languageColumn: 'language',
    sourceColumn: null,
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
    groupColumn: null,
    statusColumn: null,
    languageColumn: null,
    sourceColumn: null,
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
    // A user's groups are the GroupMember join table, not a column, and a user
    // is never round-robined to a team.
    groupColumn: null,
    statusColumn: null,
    // `languages` is a multi-select of what a user SPEAKS, not the record's own
    // language, and a user is never dedupe-matched on it.
    languageColumn: null,
    sourceColumn: null,
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
    groupColumn: null,
    statusColumn: null,
    languageColumn: null,
    sourceColumn: null,
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

// ── the query side: filter, sort, search, paginate ────────────────────────

export const DEFAULT_PAGE_SIZE = 50;
/** `?pageSize=100000` is a query that reads a module into memory. */
export const MAX_PAGE_SIZE = 200;

/**
 * How many fields one quick search may fan out across.
 *
 * Each searchable field becomes another `ILIKE '%term%'` inside the OR, and a
 * leading wildcard uses no btree index — so the OR costs one sequential pass
 * per field over the scoped set. On a 40-field module that is 40 passes for
 * every keystroke. Twelve is the visible column budget of the list screen and
 * comfortably more than a person scans by eye.
 *
 * TODO(search): the real answer is spec §10's per-module `tsvector` column with
 * a GIN index, populated on write. That replaces this whole fan-out with one
 * indexed `@@` match and makes the cap unnecessary. Until it exists, saying
 * "we search the first twelve searchable fields" is honest; pretending to
 * search forty would not be.
 */
const SEARCH_FIELD_CAP = 12;

/**
 * Which of a module's fields this actor may filter, sort or search on.
 *
 * Hidden fields are removed HERE, not just on serialisation. A hidden field
 * that stays filterable is a value oracle: filter `salary > 100000`, read the
 * count, bisect — and the field is yours without it ever crossing the wire.
 * "Hiding a field in the UI is not a security control" cuts in this direction
 * too. Once removed, `StorageResolver.resolve` cannot see the key, so a filter
 * naming it throws exactly as an invented key does — and an actor cannot tell
 * a hidden field from a nonexistent one, which is the answer we want.
 *
 * The projection's own fields are folded in so `flatten` still knows how to
 * rebuild every column the caller asked to draw.
 */
function resolvableFields(
  engine: PermissionEngine,
  moduleSlug: string,
  projection: FieldMeta[],
  all: FieldMeta[] | undefined,
): FieldMeta[] {
  const hidden = engine.hiddenFields(moduleSlug);
  const byKey = new Map<string, FieldMeta>();
  for (const f of [...(all ?? []), ...projection]) {
    if (hidden.has(f.key)) continue;
    if (!byKey.has(f.key)) byKey.set(f.key, f);
  }
  return [...byKey.values()];
}

/**
 * Anything `compileFilter` or `resolve` refuses is a 400 naming the reason.
 *
 * The compiler throws on an unknown field key ON PURPOSE — dropping the
 * condition would widen the result set, which can leak records past a
 * permission scope — so this must never become a silent `catch {}`. It only
 * ever wraps the compile call itself, so a fault from anywhere else still
 * surfaces as the 500 it is.
 */
function filterError(err: unknown): ConfigError {
  if (err instanceof ConfigError) return err;
  return new ConfigError(err instanceof Error ? err.message : 'Invalid filter', 400, 'VALIDATION');
}

/**
 * Substitute the actor's own id into every `isMe` condition.
 *
 * `compileFilter` returns the condition's `value` for `isMe` and documents
 * that the caller supplies the id. Doing it here rather than trusting the
 * posted value is the difference between "is me" and "is whoever the client
 * named": the tree is user input, and a saved SHARED view carries an `isMe`
 * authored by somebody else entirely — it must mean the reader, not the author.
 */
function bindActor(node: FilterNode, actor: ActorContext | undefined): FilterNode {
  if (isGroup(node)) {
    return { op: node.op, children: node.children.map((c) => bindActor(c, actor)) };
  }
  if (node.operator !== 'isMe') return node;
  if (!actor) {
    // No actor means no id to substitute, and `isMe` with an undefined value
    // compiles to "field equals undefined", which Prisma reads as no condition
    // at all — a widening. Refuse instead.
    throw new ConfigError('"is me" cannot be evaluated here', 400, 'VALIDATION');
  }
  return { ...node, value: actor.userId };
}

/**
 * The quick-search tree: an OR of `contains` over the module's searchable
 * fields, compiled by the same compiler as any other filter so the values
 * travel as Prisma parameters and the JSONB path handling is not duplicated.
 *
 * `searchable` alone is not the whole test. A DROPDOWN is searchable — its
 * text is meaningful — but its operator registry is `in`/`eq`, because what a
 * record stores is the option VALUE and what a person types is the option
 * LABEL, which lives in `PicklistOption`. Substring-matching the stored value
 * would quietly miss most matches, and on a MULTI_SELECT (array storage) it is
 * not even a legal comparison. So a type joins the search only if the registry
 * says it understands `contains`.
 *
 * TODO(search): picklists belong in search via their labels — resolve the
 * typed term to option values first, then add an `in` condition to this OR.
 */
function searchTree(fields: FieldMeta[], term: string): FilterGroup | null {
  const children: FilterCondition[] = [];
  for (const f of fields) {
    const spec = FIELD_TYPE_SPECS[f.type];
    if (!spec.searchable || !spec.operators.includes('contains')) continue;
    children.push({ fieldKey: f.key, fieldType: f.type, operator: 'contains', value: term });
    if (children.length === SEARCH_FIELD_CAP) break;
  }
  return children.length === 0 ? null : { op: 'OR', children };
}

/**
 * Map a `SortSpec[]` onto a Prisma `orderBy`, and always end deterministically.
 *
 * Two rules:
 *
 *  - A JSONB field is REFUSED, with a 422 that says so. Prisma has no ordering
 *    over a JSON path, and the alternatives are worse than the refusal:
 *    accepting the sort and ignoring it tells the user their list is ordered
 *    when it is not, and reaching for `$queryRaw` would put a user-supplied
 *    key into SQL text. A field an Admin needs to sort by is a field that
 *    belongs in a promoted column — that is a config decision, not a silent one.
 *  - The last key is always unique. Postgres gives no ordering guarantee
 *    between rows that tie, so page 2 of a `status`-sorted list can repeat a
 *    row page 1 already showed and skip one it did not. `id` breaks every tie.
 */
function orderByFor(storage: Storage, sort: SortSpec[] | undefined): Row[] {
  const orderBy: Row[] = [];
  const used = new Set<string>();

  for (const s of sort ?? []) {
    let loc: FieldLocation;
    try {
      loc = storage.resolver.resolve(s.fieldKey);
    } catch (err) {
      throw filterError(err);
    }
    if (!loc.column) {
      throw new ConfigError(
        `"${s.fieldKey}" is stored as JSON and cannot be sorted on. Ask an admin to promote it to a column.`,
        422,
        'VALIDATION',
      );
    }
    // A key repeated later in the list can never change the order, and Prisma
    // would still issue it. Drop it rather than pay for it.
    if (used.has(loc.column)) continue;
    used.add(loc.column);
    orderBy.push({ [loc.column]: s.direction });
  }

  // Newest first is what every list screen opens on; it is a default, not a
  // rule, so an explicit sort replaces it rather than stacking on top.
  if (orderBy.length === 0) {
    orderBy.push({ createdAt: 'desc' });
    used.add('createdAt');
  }
  if (!used.has('id')) orderBy.push({ id: 'asc' });
  return orderBy;
}

/**
 * Which columns of a Prisma model are nullable, read from the DMMF.
 *
 * The DMMF is the schema Prisma was generated from, so this is the DATABASE's
 * answer, not a hand-kept list that drifts the first time a migration lands.
 * `DelegateShape.entityType` is already the Prisma model name for exactly this
 * kind of lookup.
 *
 * Cached per model: the DMMF is a plain object walked on every call otherwise,
 * and this runs once per filtered query.
 */
const nullableColumns = new Map<string, (column: string) => boolean>();

function columnIsNullableOn(modelName: string): (column: string) => boolean {
  const cached = nullableColumns.get(modelName);
  if (cached) return cached;

  const fields = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName)?.fields ?? [];
  const nullable = new Set(fields.filter((f) => !f.isRequired).map((f) => f.name));
  const declared = new Set(fields.map((f) => f.name));
  // A column the model does not declare cannot be compiled against anyway, so
  // it answers "nullable" — the pre-existing behaviour, and never a crash.
  const fn = (column: string) => nullable.has(column) || !declared.has(column);

  nullableColumns.set(modelName, fn);
  return fn;
}

/**
 * "The JSON path is absent, or holds a JSON null" — the two states Postgres
 * keeps apart and a person filtering on "is empty" does not.
 *
 * `packages/core` may not import Prisma, so the compiler takes this as an
 * option. This file is the boundary that owns the ORM, so it is where the
 * sentinel is bound. See `CompileOptions.jsonAnyNull` for what breaks without
 * it: `isEmpty` on any Admin-created field silently matched nothing.
 */
const jsonAnyNull = Prisma.AnyNull;

/** The filter + search half of the where, or `{}` when the caller asked for
 *  neither. Kept separate from the scope so the two can never be merged. */
function userWhereFor(
  storage: Storage,
  resolvable: FieldMeta[],
  query: RecordQuery,
  actor: ActorContext | undefined,
): Row {
  const parts: Row[] = [];
  const resolve = storage.resolver.resolve;
  const columnIsNullable = columnIsNullableOn(storage.shape.entityType);

  if (query.filters) {
    // The operator registry, enforced HERE and not only at the route.
    //
    // `recordQuerySchema` is structural — it is parsed before any module's
    // config is loaded, so it cannot know that `gt` is not a text operator.
    // `compileFilter` will not catch it either: it maps an operator onto
    // Prisma by name, so `gt` on a text column compiles to a lexicographic
    // `>` that is valid SQL and matches nearly everything. This is the
    // repository, the one layer every read passes through, which is the same
    // reason `scopeFilter` is applied here rather than in a controller.
    //
    // `resolvable` is the actor's own field list with hidden fields already
    // removed, so a filter naming one is refused as "unknown" — identical to
    // an invented key, which is the answer that discloses least.
    const issues = filterFieldIssues(query.filters, resolvable);
    if (issues.length > 0) throw new ConfigError(issues[0]!.message, 400, 'VALIDATION');

    try {
      const where = compileFilter(bindActor(query.filters, actor), {
        resolve,
        jsonAnyNull,
        columnIsNullable,
      });
      if (Object.keys(where).length > 0) parts.push(where);
    } catch (err) {
      throw filterError(err);
    }
  }

  const term = query.search?.trim();
  if (term) {
    const tree = searchTree(resolvable, term);
    if (tree) {
      try {
        parts.push(compileFilter(tree, { resolve, jsonAnyNull, columnIsNullable }));
      } catch (err) {
        throw filterError(err);
      }
    } else {
      // Nothing on this module can be substring-matched, so every row would
      // match a term that matched nothing. Deny rather than ignore the search.
      parts.push(DENY_ALL);
    }
  }

  if (parts.length === 0) return {};
  // Search NARROWS the filter — a term and a filter both apply.
  return parts.length === 1 ? parts[0]! : { AND: parts };
}

/**
 * Scope AND user filter. **Never a flat merge.**
 *
 * `{ ...scopeWhere, ...userWhere }` looks equivalent and is the bug this slice
 * exists to prevent: object spread lets a LATER key overwrite an earlier one,
 * so a user filter naming `ownerId` — a perfectly ordinary filter, "owner is
 * Priya" — would replace the `ownerId` the scope filter put there and hand a
 * rep every record Priya owns. Same for `isDeleted`, and for the `module`
 * discriminator on the generic table. Nesting them under `AND` makes both
 * conditions survive, so a user filter can only ever NARROW what the scope
 * already allows. There is no filter that widens past a permission scope
 * because there is no key a user filter can reach to overwrite.
 *
 * If a future refactor is tempted to flatten this for readability: don't.
 */
function combine(scope: Row, user: Row): Row {
  if (Object.keys(user).length === 0) return scope;
  return { AND: [scope, user] };
}

/** Filter, sort, search and page — every part optional. */
export interface RecordQuery {
  filters?: FilterNode | null;
  sort?: SortSpec[] | null;
  search?: string | null;
  /** 1-based. Wins over `skip` when both are given. */
  page?: number;
  /** Wins over `take` when both are given. Capped at MAX_PAGE_SIZE. */
  pageSize?: number;
}

export interface ListRecordsParams extends RecordQuery {
  module: ModuleRef;
  /**
   * The fields to project. Hidden ones are stripped again on serialisation, so
   * a caller passing its whole field list leaks nothing — but passing only the
   * columns on screen keeps a 40-field module from selecting 40 columns to
   * draw 12 of them.
   */
  fields: FieldMeta[];
  /**
   * Every field of the module, for RESOLVING filter, sort and search keys.
   *
   * Defaults to `fields`, which is why this exists: the list screen projects
   * twelve columns, and a filter on the thirteenth field is legitimate. Without
   * this the resolver would not know that key and would throw — turning a valid
   * filter into a 400. Hidden fields are dropped from it regardless of what a
   * caller passes; see `resolvableFields`.
   */
  allFields?: FieldMeta[];
  engine: PermissionEngine;
  /** needed only to bind `isMe`; a query without one is refused, not widened */
  actor?: ActorContext;
  take?: number;
  skip?: number;
}

/** Resolve the two ways a caller can express a page into take/skip. */
function paging(params: ListRecordsParams): { take: number; skip: number; page: number } {
  const pageSize = Math.min(
    Math.max(params.pageSize ?? params.take ?? DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
  const skip =
    params.page !== undefined ? (Math.max(params.page, 1) - 1) * pageSize : (params.skip ?? 0);
  return { take: pageSize, skip, page: Math.floor(skip / pageSize) + 1 };
}

export async function listRecords(params: ListRecordsParams): Promise<ListResult> {
  const { module, fields, engine, actor } = params;
  const { take, skip, page } = paging(params);

  const resolvable = resolvableFields(engine, module.slug, fields, params.allFields);
  const storage = storageFor(module, resolvable);
  const delegate = recordDelegate(prisma, storage.delegateName);
  // A module flagged core whose table does not exist is a config error. Showing
  // nothing is wrong but safe; falling through to another table would not be.
  if (!delegate) return { rows: [], total: 0, page, pageSize: take };

  // Built BEFORE the query so an invalid filter or an unsortable field is a
  // 400/422 rather than a database error nobody can act on.
  const orderBy = orderByFor(storage, params.sort ?? undefined);
  const where = combine(
    scopedWhere(storage, engine, module.slug),
    userWhereFor(storage, resolvable, params, actor),
  );
  const select = selectFor(storage, fields);

  const [rows, total] = await Promise.all([
    delegate.findMany({ where, select, orderBy, take, skip }),
    // TODO(perf, spec §10): an exact COUNT scans the whole matched set, and the
    // OFFSET above re-walks every skipped row. Spec §10 asks for two fixes and
    // this implements neither, deliberately rather than silently:
    //   1. an ESTIMATED count above a threshold — `EXPLAIN`'s row estimate, or
    //      `pg_class.reltuples` when the where is just the scope — with the UI
    //      showing "about N";
    //   2. CURSOR pagination beyond page 50, keyed on the same (sort…, id)
    //      tuple `orderByFor` already guarantees is unique — which is exactly
    //      why the tiebreak is not optional.
    // Both change this function's RETURN shape, so they land together.
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
  return {
    rows: serialiseMany(engine, module.slug, flattened, fields),
    total,
    page,
    pageSize: take,
  };
}

export interface CountRecordsParams extends RecordQuery {
  module: ModuleRef;
  /** every field the actor may filter on — see `ListRecordsParams.allFields` */
  fields: FieldMeta[];
  engine: PermissionEngine;
  actor?: ActorContext;
}

/**
 * How many records match — scope included — without reading a single row.
 *
 * This is what the design's "Saved Filters (9)" count is: ONE `count` per view,
 * through the same scope + filter combination as the list, so the number a user
 * sees is the number they will get. It reads no columns, so a hidden field can
 * never leak through it — but it is still a COUNT over the matched set, and the
 * caller decides how many of those it is willing to issue.
 */
export async function countRecords(params: CountRecordsParams): Promise<number> {
  const { module, fields, engine, actor } = params;
  const resolvable = resolvableFields(engine, module.slug, fields, undefined);
  const storage = storageFor(module, resolvable);
  const delegate = recordDelegate(prisma, storage.delegateName);
  if (!delegate) return 0;

  return delegate.count({
    where: combine(
      scopedWhere(storage, engine, module.slug),
      userWhereFor(storage, resolvable, params, actor),
    ),
  });
}
