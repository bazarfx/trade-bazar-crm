/**
 * One person's workload: what they are carrying, and what they have closed.
 *
 * The client asked for "the leads assigned, how many have they closed,
 * everything" on a teleseller's page. This file never learns that a
 * teleseller exists, and never learns that a module is called Leads. It asks
 * the STORAGE SHAPES three structural questions:
 *
 *   - which table carries the OWNER foreign key, and what does that key point
 *     at? Whatever it points at is the people table (`resolvePeopleModule`).
 *   - which enabled modules declare an `ownerColumn`? Every one of them can
 *     hold this person's work, so every one of them is counted.
 *   - which declare a `closedByColumn`? That column is permanent conversion
 *     credit (spec §7.1), so it is counted separately from ownership.
 *
 * Create a module tomorrow with an owner column and it appears on this page
 * with no code change, no migration and no deploy. That is the test.
 *
 * EVERY NUMBER IS A SCOPED READ. The counts go through `scopedWhere` — the
 * repository's own scope filter, the same one the list screen uses — ANDed
 * with the owner condition via `combine`. A teleseller who may see only their
 * own leads opening a colleague's page learns nothing about the size of a
 * pipeline they cannot read: they get the count THEY would get from the list.
 * The AND is not optional and not a spread; see `combine` for why.
 *
 * COST. One query for the module list; one per module with an owner column;
 * one per module with a closed-by column (the ledger sum rides along in the
 * same aggregate); one batched status -> tag lookup; one batched lookup of
 * the fields the ledger totals live in. Linear in MODULES, constant in
 * records and in statuses — there is deliberately no query per status and
 * none per record.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import { PermissionEngine } from '@crm/core';
import {
  emptyTagCounts,
  type ClosedCredit,
  type PersonWorkload,
  type StatusTagValue,
  type WorkloadModule,
} from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { canReadModuleConfig } from '@/lib/config/access';
import { ConfigError } from '@/lib/config/service';
import {
  combine,
  scopedWhere,
  storageFor,
  type ModuleRef,
  type Row,
  type Storage,
} from '@/lib/records/list';
import { getRecord } from '@/lib/records/service';

/**
 * The slice of a delegate this file uses. Structural, like `RecordDelegate`
 * in the repository and the ledger reader beside it: the delegate is chosen
 * by name from the storage shape at runtime, so no static Prisma type exists
 * for it.
 */
interface CountingDelegate {
  count(args: { where: Row }): Promise<number>;
  /** ONE statement for a whole pipeline — never one query per status */
  groupBy(args: { by: string[]; where: Row; _count: { _all: true } }): Promise<Row[]>;
  aggregate(args: {
    where: Row;
    _count: { _all: true };
    _sum?: Record<string, true>;
  }): Promise<{ _count: { _all: number }; _sum?: Record<string, unknown> }>;
}

function counting(delegateName: string): CountingDelegate | null {
  return (prisma as unknown as Record<string, CountingDelegate | undefined>)[delegateName] ?? null;
}

/** An enabled module with its storage and the Admin's own labels. */
interface ModuleStorage {
  ref: Required<ModuleRef>;
  label: string;
  labelPlural: string;
  storage: Storage;
}

/**
 * Every ENABLED module — core AND Admin-created — with its storage handle.
 *
 * `coreModuleStorages()` next door answers a different question ("which core
 * table declares a conversion shape") and deliberately excludes the generic
 * table. Workload cannot: an Admin-created module lives in `Record`, which
 * carries a real `ownerId`, so its rows are somebody's work exactly as a
 * lead's are.
 *
 * No field list is passed to `storageFor`. This file counts ROWS by physical
 * column and never resolves a field key, so the resolver has nothing to
 * resolve — and skipping it is what keeps the whole workload at one query per
 * module instead of three.
 */
async function enabledModuleStorages(): Promise<ModuleStorage[]> {
  const modules = await prisma.moduleDefinition.findMany({
    where: { isEnabled: true },
    orderBy: { navOrder: 'asc' },
    select: { id: true, slug: true, isCore: true, label: true, labelPlural: true },
  });
  return modules.map((m) => {
    const ref = { id: m.id, slug: m.slug, isCore: m.isCore };
    return { ref, label: m.label, labelPlural: m.labelPlural, storage: storageFor(ref, []) };
  });
}

/**
 * Which model a column's foreign key POINTS AT, read from the DMMF.
 *
 * The DMMF is the schema Prisma was generated from, so this is the database's
 * own answer rather than a hand-kept list that drifts the first time a
 * migration lands — the same reason `columnIsNullableOn` in the repository
 * reads it. `DelegateShape.entityType` is already the Prisma model name, for
 * exactly this kind of lookup.
 */
function foreignKeyTarget(modelName: string, column: string): string | null {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
  const relation = model?.fields.find(
    (f) => f.kind === 'object' && (f.relationFromFields ?? []).includes(column),
  );
  return relation?.type ?? null;
}

/**
 * The module that IS the people table — resolved from the schema, never from
 * a slug.
 *
 * "Whose workload is this?" is only answerable about a row that can OWN
 * records, and ownership is a FOREIGN KEY: every shape declaring an
 * `ownerColumn` points that column at one table, and that table is where
 * people live. So this asks the schema which model the owner keys target and
 * returns the enabled module whose shape writes that model's audit rows.
 *
 * Rename Users to "Staff" and the answer is unchanged. An Admin-created
 * module can never be mistaken for it: nothing points an owner key at the
 * generic `Record` table.
 *
 * Null means this deployment has no people module (none enabled, or no module
 * carries an owner at all) — an honest 404 for the caller. Two DIFFERENT
 * targets is broken config and fails loudly instead: "which table is a person
 * in" would have no answer, and guessing one is how a permission check ends
 * up run against the wrong rows.
 */
function resolvePeopleModule(modules: ModuleStorage[]): ModuleStorage | null {
  const targets = new Set<string>();
  for (const m of modules) {
    const { ownerColumn, entityType } = m.storage.shape;
    if (!ownerColumn) continue;
    const target = foreignKeyTarget(entityType, ownerColumn);
    if (target) targets.add(target);
  }

  if (targets.size > 1) {
    throw new ConfigError(
      `Owner columns point at more than one table (${[...targets].join(', ')}), so there is no single people module`,
      500,
      'GUARDRAIL',
    );
  }

  const [peopleEntity] = [...targets];
  if (!peopleEntity) return null;
  return modules.find((m) => m.storage.shape.entityType === peopleEntity) ?? null;
}

/**
 * 404 unless `moduleSlug` names the people module.
 *
 * Exported for the route, which must refuse a workload for a lead without
 * ever comparing a slug to a literal. 404 rather than 400: to a caller
 * asking about a module that has no workload, "no such thing here" is the
 * whole truth, and it is the same answer an out-of-scope record gets.
 *
 * It re-reads the module list rather than taking one from the caller, so
 * that the guard cannot be handed a list somebody else already filtered.
 * That is one indexed read of a table with a handful of rows, and the
 * alternative — a gate whose input the caller supplies — is how a gate gets
 * bypassed.
 */
export async function assertPeopleModule(moduleSlug: string): Promise<void> {
  const modules = await enabledModuleStorages();
  const people = resolvePeopleModule(modules);
  const asked = modules.find((m) => m.ref.slug === moduleSlug);
  // Compared by DELEGATE, not by slug: any module whose rows live in the
  // people table answers here, including one an Admin renames or re-slugs.
  if (!people || !asked || asked.storage.delegateName !== people.storage.delegateName) {
    throw new ConfigError('This module has no workload', 404, 'NOT_FOUND');
  }
}

/** Exact decimal digits, never a float — money is reconciled, not estimated. */
function money(value: unknown): string {
  return new Prisma.Decimal(value === null || value === undefined ? 0 : String(value)).toFixed(2);
}

/** A groupBy row's `_count._all`, which arrives as `unknown`. */
function groupCount(row: Row): number {
  const count = row['_count'];
  if (!count || typeof count !== 'object') return 0;
  const all = (count as { _all?: unknown })._all;
  return typeof all === 'number' ? all : 0;
}

/** A row value that is a non-empty string, or null. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** What one module contributes to `owns`, before tags are resolved. */
interface OwnedTally {
  module: ModuleStorage;
  total: number;
  /** statusId -> count; empty when the module has no status column */
  byStatusId: Map<string, number>;
}

/**
 * Count one module's records owned by this person.
 *
 * The status breakdown is ONE `groupBy`, and the total is the sum of its
 * groups rather than a second `count` over the same set — the two could not
 * disagree even by a race that way, and it halves the query count.
 */
async function tallyOwned(
  module: ModuleStorage,
  engine: PermissionEngine,
  userId: string,
): Promise<OwnedTally | null> {
  const { shape, delegateName } = module.storage;
  // Both columns are read into locals before the awaits below: a narrowed
  // PROPERTY does not survive an await under strict null checks, and a `!`
  // here would be asserting away the very thing this file is asking about.
  const ownerColumn = shape.ownerColumn;
  const statusColumn = shape.statusColumn;
  if (!ownerColumn) return null;

  const delegate = counting(delegateName);
  // A module flagged core whose table does not exist is broken config.
  // Counting nothing is wrong but safe; falling through to another table
  // would not be — the same call the repository makes.
  if (!delegate) return null;

  // `scopedWhere` already carries the module discriminator, the soft-delete
  // filter (invariant 4 — a deleted record is not workload) and the reader's
  // scope. `combine` ANDs the owner condition UNDER it: a flat spread would
  // let `ownerId` overwrite the `ownerId` an OWN-scoped reader's filter put
  // there, handing them every record of the person they are looking at.
  const where = combine(scopedWhere(module.storage, engine, module.ref.slug), {
    [ownerColumn]: userId,
  });

  if (!statusColumn) {
    return { module, total: await delegate.count({ where }), byStatusId: new Map() };
  }

  const groups = await delegate.groupBy({
    by: [statusColumn],
    where,
    _count: { _all: true },
  });

  const byStatusId = new Map<string, number>();
  let total = 0;
  for (const row of groups) {
    const n = groupCount(row);
    total += n;
    const statusId = str(row[statusColumn]);
    // A record with no status still counts toward the total; it simply lands
    // on no tag. The generic table's `statusId` is nullable, so this is an
    // ordinary state, not a fault.
    if (statusId) byStatusId.set(statusId, (byStatusId.get(statusId) ?? 0) + n);
  }
  return { module, total, byStatusId };
}

/**
 * Count one module's PERMANENT CREDIT for this person, and sum its ledger.
 *
 * `closedByColumn` is deliberately NOT ownership (spec §7.1): it records the
 * agent who owned the lead at the moment of conversion, is written once and
 * stripped from every update thereafter. A deal handed to back-office the
 * next morning still counts here for whoever closed it, and by then it has
 * left that person's `owns` entry entirely. Counting the two together would
 * erase exactly the distinction commission is paid on.
 *
 * The sum is taken over the PARENT's derived total column, not over the
 * ledger table itself. Two reasons, and the first is the security one: the
 * ledger is its own module with its own view scope, so summing its rows here
 * would answer a deposits question under a deals permission. The second is
 * that spec §8.3 makes the derived column the ledger's own total — "always
 * derived from rows, never typed by hand" — so the two cannot disagree, and
 * this way `_count` and `_sum` ride in ONE aggregate over rows already
 * scoped, rather than a second query through a second table.
 */
async function tallyClosed(
  module: ModuleStorage,
  engine: PermissionEngine,
  userId: string,
  sumLedger: boolean,
): Promise<ClosedCredit | null> {
  const { shape, delegateName } = module.storage;
  const closedByColumn = shape.closedByColumn;
  if (!closedByColumn) return null;

  const delegate = counting(delegateName);
  if (!delegate) return null;

  // Scoped exactly as ownership is: credit for a record this reader may not
  // see is not a number they may have.
  const where = combine(scopedWhere(module.storage, engine, module.ref.slug), {
    [closedByColumn]: userId,
  });

  const totalColumn = shape.ledger?.totalColumn;
  const agg = await delegate.aggregate({
    where,
    _count: { _all: true },
    ...(totalColumn && sumLedger ? { _sum: { [totalColumn]: true } } : {}),
  });

  return {
    slug: module.ref.slug,
    label: module.label,
    labelPlural: module.labelPlural,
    count: agg._count._all,
    ledgerTotal: totalColumn && sumLedger ? money(agg._sum?.[totalColumn]) : null,
  };
}

/**
 * Which of these modules may show their ledger total to this reader.
 *
 * An aggregate is a READ of the field it sums, so the field-level matrix
 * governs it — hiding a column in the UI is not a security control
 * (CLAUDE.md), and a role that cannot see Total Deposited on a deal must not
 * receive the sum of it either. The check is by field KEY, which is what
 * `hiddenFields` speaks, so the column has to be mapped back to the Admin's
 * field first; a column no live field maps to is not readable at all.
 *
 * One query for every module at once, and none when nothing declares a
 * ledger.
 */
async function ledgerVisibility(
  modules: ModuleStorage[],
  engine: PermissionEngine,
): Promise<Set<string>> {
  const withLedger = modules.filter((m) => m.storage.shape.ledger !== null);
  if (withLedger.length === 0) return new Set();

  const totalColumns = withLedger
    .map((m) => m.storage.shape.ledger?.totalColumn)
    .filter((c): c is string => c !== undefined);

  const fields = await prisma.fieldDefinition.findMany({
    where: {
      moduleId: { in: withLedger.map((m) => m.ref.id) },
      isDeleted: false,
      systemColumn: { in: totalColumns },
    },
    select: { moduleId: true, key: true, systemColumn: true },
  });

  const visible = new Set<string>();
  for (const m of withLedger) {
    const totalColumn = m.storage.shape.ledger?.totalColumn;
    const field = fields.find((f) => f.moduleId === m.ref.id && f.systemColumn === totalColumn);
    if (field && !engine.hiddenFields(m.ref.slug).has(field.key)) visible.add(m.ref.slug);
  }
  return visible;
}

/**
 * Everything one person is carrying and everything they have closed.
 *
 * @param userId the id of the row in the people table, i.e. the record id of
 *   the person whose page this is.
 */
export async function personWorkload(
  principal: Principal,
  userId: string,
): Promise<PersonWorkload> {
  const modules = await enabledModuleStorages();
  const people = resolvePeopleModule(modules);
  if (!people) throw new ConfigError('Record not found', 404, 'NOT_FOUND');

  // THE PERMISSION CHECK, and there is only one: can this reader see the
  // person? Resolved through the ordinary scoped record read of the people
  // module, so a workload can never be reachable by a route the record page
  // itself is not. `getRecord` answers 404 for both "no such user" and "out
  // of your scope" — a 403 on a person you may not see confirms they exist.
  // Its result is discarded: the page has already drawn those fields, and
  // re-serialising them here would be a second place to get hiding wrong.
  await getRecord(principal, people.ref.slug, userId);

  const engine = new PermissionEngine(principal.actor, principal.permissions);

  // Modules this reader may not read at all drop out here, exactly as they do
  // for `moduleContext` — the same gate, so a module invisible everywhere
  // else does not reappear as a row of zeros on this page. Row-level scope is
  // still applied per query below; this only decides visibility of the module.
  const readable = modules.filter((m) => canReadModuleConfig(principal, m.ref.slug));

  const ledgerVisible = await ledgerVisibility(readable, engine);

  const [tallies, closed] = await Promise.all([
    Promise.all(readable.map((m) => tallyOwned(m, engine, userId))),
    Promise.all(
      readable.map((m) => tallyClosed(m, engine, userId, ledgerVisible.has(m.ref.slug))),
    ),
  ]);

  const owned = tallies.filter((t): t is OwnedTally => t !== null);

  // Statuses -> tags in ONE lookup across every module, after the counts are
  // in. Soft-deleted statuses are INCLUDED on purpose: an Admin retiring a
  // status does not retire the records sitting on it, and those records are
  // still this person's work. Read by `tag`, never by `name` (CLAUDE.md).
  const statusIds = [...new Set(owned.flatMap((t) => [...t.byStatusId.keys()]))];
  const statuses =
    statusIds.length > 0
      ? await prisma.status.findMany({
          where: { id: { in: statusIds } },
          select: { id: true, tag: true },
        })
      : [];
  const tagById = new Map<string, StatusTagValue>(
    statuses.map((s) => [s.id, s.tag as StatusTagValue]),
  );

  const owns: WorkloadModule[] = owned.map((t) => {
    const byTag = emptyTagCounts();
    for (const [statusId, n] of t.byStatusId) {
      const tag = tagById.get(statusId);
      // A status id with no row left (hard-removed outside the soft-delete
      // path) folds onto no tag but stays in `total`. Dropping the record
      // entirely would understate the person's workload.
      if (tag) byTag[tag] += n;
    }
    return {
      slug: t.module.ref.slug,
      label: t.module.label,
      labelPlural: t.module.labelPlural,
      total: t.total,
      byTag,
      hasStatuses: t.module.storage.shape.statusColumn !== null,
    };
  });

  return {
    owns,
    closed: closed.filter((c): c is ClosedCredit => c !== null),
    generatedAt: new Date().toISOString(),
  };
}
