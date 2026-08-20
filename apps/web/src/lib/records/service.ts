/**
 * THE record engine.
 *
 * One service creates, reads, updates, deletes and narrates a record for EVERY
 * module. There is no leads service and there never will be: Leads is the
 * module whose `ModuleDefinition`, `FieldDefinition` and `Status` rows this
 * code renders into a write. Adding a module — or a field, or a status — is an
 * insert in the config tables, not a change in this file.
 *
 * Four rules shape almost every decision below:
 *
 *  1. **Validation is generated, never written.** `buildRecordSchema(fields)`
 *     in `packages/shared` is the ONLY validation path, so the form, this
 *     service and the worker cannot disagree about what a field accepts.
 *  2. **Everything is logged, in the same transaction as the write.** The
 *     timeline IS `AuditLog` rendered — never a second store — so a log row
 *     that could commit without its record (or vice versa) would be a lie.
 *  3. **Reads by id go through the same scope filter as the list.** Fetching
 *     by id is the classic way a permission check gets skipped, so this file
 *     has no route to a row except `findRecordById`, which applies it.
 *  4. **Storage is invisible here.** Which table a module lives in, which
 *     columns it carries, whether it can be soft-deleted — all of it arrives
 *     as a `Storage` handle from `records/list.ts`. Nothing in this file
 *     branches on a module slug.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import { PermissionEngine, type AuditEntry, type FieldMeta } from '@crm/core';
import {
  FIELD_TYPE_SPECS,
  buildRecordSchema,
  normalisePhone,
  type FieldDef,
  type FieldType,
  type FieldValidation,
} from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { auditWithin } from '@/lib/audit';
import { assertModuleReadAccess } from '@/lib/config/access';
import { ConfigError, requireModule, type Tx } from '@/lib/config/service';
import {
  findRecordById,
  listRecords,
  recordDelegate,
  selectFor,
  storageFor,
  type ModuleRef,
  type RecordRow,
  type Row,
  type Storage,
} from '@/lib/records/list';
import { NEVER_SERIALISED, plain, serialiseRecord } from '@/lib/records/serialise';

/** Client IP and user agent, as `requestMeta(req)` returns them. Optional
 *  because the worker's writers (webhook, import) have no HTTP request. */
export interface AuditMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

// ── module context ────────────────────────────────────────────────────────

/** A live field definition, as every path below needs it. */
interface FieldRow {
  key: string;
  label: string;
  type: FieldType;
  systemColumn: string | null;
  isRequired: boolean;
  isSystem: boolean;
  validation: unknown;
  defaultValue: unknown;
  options: { value: string }[];
}

interface ModuleContext {
  module: {
    id: string;
    slug: string;
    isCore: boolean;
    hasOwner: boolean;
    hasTimeline: boolean;
    recordTitleField: string;
  };
  /** every LIVE field of the module, in the Admin's order */
  fields: FieldRow[];
  /** the same fields as the storage layer wants them */
  metas: FieldMeta[];
  engine: PermissionEngine;
  storage: Storage;
}

/**
 * Resolve a module slug into everything a record operation needs.
 *
 * The read gate comes FIRST and before the module is resolved: to an actor
 * with no access, an unknown module and a forbidden one must be
 * indistinguishable. Row-level scope is still applied in the repository — this
 * only decides whether the module is visible at all.
 */
async function moduleContext(principal: Principal, moduleSlug: string): Promise<ModuleContext> {
  assertModuleReadAccess(principal, moduleSlug);
  const module = await requireModule(moduleSlug);

  // Soft-deleted fields keep their stored values (invariant 4) but are no
  // longer part of the contract: they cannot be written, and they are not
  // required. Retired picklist options are excluded for the same reason —
  // historical values keep rendering, new writes may not choose them.
  const fields = await prisma.fieldDefinition.findMany({
    where: { moduleId: module.id, isDeleted: false },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    select: {
      key: true,
      label: true,
      type: true,
      systemColumn: true,
      isRequired: true,
      isSystem: true,
      validation: true,
      defaultValue: true,
      options: { where: { isDeleted: false }, select: { value: true } },
    },
  });

  const ref: ModuleRef = { id: module.id, slug: module.slug, isCore: module.isCore };
  const metas: FieldMeta[] = fields.map((f) => ({
    key: f.key,
    type: f.type,
    systemColumn: f.systemColumn,
  }));

  return {
    module: {
      id: module.id,
      slug: module.slug,
      isCore: module.isCore,
      hasOwner: module.hasOwner,
      hasTimeline: module.hasTimeline,
      recordTitleField: module.recordTitleField,
    },
    fields,
    metas,
    engine: new PermissionEngine(principal.actor, principal.permissions),
    storage: storageFor(ref, metas),
  };
}

const notFound = (): ConfigError => new ConfigError('Record not found', 404, 'NOT_FOUND');

/** A non-empty string, or null. Payload values arrive as `unknown`. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The field mapped to a physical column, if the module configured one. */
function fieldForColumn(fields: FieldRow[], column: string | null): FieldRow | null {
  if (!column) return null;
  return fields.find((f) => f.systemColumn === column) ?? null;
}

// ── the write contract ────────────────────────────────────────────────────

/**
 * The fields this actor may WRITE.
 *
 * Three exclusions, all of which must hold on the SERVER because a client can
 * post any key it likes:
 *  - hidden fields: the value never leaves the server on the way out, so it
 *    must not be settable on the way in either — a role that cannot see a
 *    field cannot silently overwrite it;
 *  - readonly fields: the permission matrix says look, do not touch;
 *  - derived types (FORMULA, AUTONUMBER): computed server-side by definition.
 *
 * The generated schema is built from exactly this list, which is what makes
 * the strip structural: an excluded key is not "ignored", it is not part of
 * the contract, so `z.object` drops it.
 */
function writableFields(ctx: ModuleContext, moduleSlug: string): FieldRow[] {
  const hidden = ctx.engine.hiddenFields(moduleSlug);
  const readonly = ctx.engine.readonlyFields(moduleSlug);
  return ctx.fields.filter(
    (f) =>
      !hidden.has(f.key) &&
      !readonly.has(f.key) &&
      !NEVER_SERIALISED.has(f.key) &&
      !FIELD_TYPE_SPECS[f.type].isDerived,
  );
}

/**
 * A field's shape for validation.
 *
 * `referenceOptions` covers the picklists whose values do NOT live in
 * `PicklistOption`: the status column reads the `Status` table, and lookups
 * point at other rows entirely. Handing those values in keeps validation
 * strict — a picklist with no options at all rejects everything, which is the
 * only honest answer for a control with nothing selectable, but it would be
 * the wrong answer here.
 */
function toFieldDef(f: FieldRow, referenceOptions?: Map<string, { value: string }[]>): FieldDef {
  const supplied = referenceOptions?.get(f.key);
  return {
    key: f.key,
    label: f.label,
    type: f.type,
    isRequired: f.isRequired,
    validation: (f.validation ?? null) as FieldValidation | null,
    options: supplied ?? f.options,
  };
}

/**
 * Values for the reference-backed picklists on this module. Keyed by field
 * key, resolved from the tables that actually own them.
 */
async function referenceOptionsFor(
  ctx: ModuleContext,
  writable: FieldRow[],
): Promise<Map<string, { value: string }[]>> {
  const out = new Map<string, { value: string }[]>();
  const statusColumn = ctx.storage.shape.statusColumn;
  if (!statusColumn) return out;

  const statusField = writable.find((f) => f.systemColumn === statusColumn);
  if (!statusField) return out;

  const statuses = await prisma.status.findMany({
    where: { moduleId: ctx.module.id, isDeleted: false },
    select: { id: true },
  });
  out.set(statusField.key, statuses.map((s) => ({ value: s.id })));
  return out;
}

/**
 * Normalise phone-typed values to the matching key BEFORE validation.
 *
 * Order matters twice over: `normalisePhone` is what the ARK webhook and the
 * duplicate scan match on (spec §6.6, §7), so a raw "98765 43210" stored as
 * typed would never match its own webhook; and the generated PHONE schema
 * checks E.164, which that same raw string fails. Normalising first makes
 * local input acceptable AND storable in the one form everything matches on.
 */
function normalisePhones(fields: FieldRow[], values: Row): Row {
  const out: Row = { ...values };
  for (const f of fields) {
    if (f.type !== 'PHONE') continue;
    const raw = out[f.key];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    out[f.key] = normalisePhone(raw);
  }
  return out;
}

/** Configured defaults for keys the payload did not mention. */
function applyDefaults(fields: FieldRow[], values: Row): Row {
  const out: Row = { ...values };
  for (const f of fields) {
    if (f.defaultValue === null || f.defaultValue === undefined) continue;
    if (out[f.key] === undefined) out[f.key] = f.defaultValue;
  }
  return out;
}

/** The payload reduced to a plain object. Anything else fails the module's
 *  own schema a moment later; this only keeps the spread below honest. */
function asObject(input: unknown): Row {
  return input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Row) } : {};
}

// ── audit shaping ─────────────────────────────────────────────────────────

/**
 * One field value, reduced to the JSON form the audit log stores and the diff
 * compares.
 *
 * Keyed off the TYPE REGISTRY's storage kind, never off a field name. Two
 * things go wrong without it: `AuditLog.changes` is a Json column, so a `Date`
 * or a Prisma `Decimal` written into it throws at insert time; and a diff that
 * compared a stored `Decimal(100)` against a submitted `100` would log a field
 * change that never happened, on every save.
 */
function auditValue(type: FieldType, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  switch (FIELD_TYPE_SPECS[type].storage) {
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : plain(value);
    }
    case 'date': {
      const d = value instanceof Date ? value : new Date(String(value));
      return Number.isNaN(d.getTime()) ? plain(value) : d.toISOString();
    }
    default:
      return plain(value);
  }
}

/** `auditValue` across a whole record, for the fields given. */
function auditValues(fields: FieldRow[], values: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f.key] = auditValue(f.type, values[f.key]);
  return out;
}

/**
 * Which action a changed key logs as.
 *
 * This mapping is what makes a timeline readable: "Status changed New →
 * Contacted" and "Reassigned Asha → Vikram" are the two entries a floor
 * manager scans for, and writing them as FIELD_CHANGED buries them among
 * twenty edits. Keyed on the physical column the storage layer reports, so an
 * Admin renaming the "Lead Status" field or the "Owner" field changes nothing.
 */
function actionFor(storage: Storage, field: FieldRow): AuditEntry['action'] {
  if (field.systemColumn && field.systemColumn === storage.shape.statusColumn) {
    return 'STATUS_CHANGED';
  }
  if (field.systemColumn && field.systemColumn === storage.shape.ownerColumn) {
    return 'REASSIGNED';
  }
  return 'FIELD_CHANGED';
}

// ── Prisma error translation ──────────────────────────────────────────────

/**
 * A constraint violation is user input reaching the database, not a fault:
 * a duplicate email on a unique field or an owner id that names no user must
 * come back as a 409/422 the form can render, never a 500.
 */
function translateWriteError(err: unknown): unknown {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return err;
  switch (err.code) {
    case 'P2002':
      return new ConfigError('A record with this value already exists', 409, 'CONFLICT');
    case 'P2003':
      return new ConfigError(
        'This record references something that does not exist',
        422,
        'VALIDATION',
      );
    case 'P2025':
      return notFound();
    case 'P2000':
      return new ConfigError('A value is too long for its field', 422, 'VALIDATION');
    default:
      return err;
  }
}

async function writing<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    throw translateWriteError(err);
  }
}

/** The delegate for this module, or a loud failure. A module flagged core
 *  whose table does not exist is broken config, not a user error. */
function delegateOrThrow(client: unknown, ctx: ModuleContext) {
  const delegate = recordDelegate(client, ctx.storage.delegateName);
  if (!delegate) {
    throw new ConfigError(`Module "${ctx.module.slug}" has no record storage`, 500);
  }
  return delegate;
}

// ── status resolution ─────────────────────────────────────────────────────

/**
 * The status a new record opens in: the FIRST live status in the Admin's own
 * order. Deterministic (id breaks a tie) and read from `displayOrder`, never
 * from a name — every status in the product is renameable, and the seeded
 * "New" is data, not code.
 */
async function defaultStatusId(moduleId: string): Promise<string | null> {
  const status = await prisma.status.findFirst({
    where: { moduleId, isDeleted: false },
    orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return status?.id ?? null;
}

/**
 * A status id is a foreign key to a GLOBAL table, so the database would
 * happily accept another module's status and quietly break every report that
 * groups by tag. Membership is checked here, and retired statuses are refused
 * on new writes while records already carrying them keep rendering.
 */
async function assertStatusBelongs(moduleId: string, statusId: string): Promise<void> {
  const status = await prisma.status.findFirst({
    where: { id: statusId, moduleId, isDeleted: false },
    select: { id: true },
  });
  if (!status) throw new ConfigError('Unknown status for this module', 422, 'VALIDATION');
}

/**
 * May this actor decide who owns a record, or only own it themselves?
 *
 * `REASSIGN_LEADS` is a fixed entry in the permission vocabulary, not a module
 * slug — it governs "may set an owner other than yourself" on every module.
 * Without it a supplied owner is ignored rather than rejected: the create must
 * not fail because a form posted the field it was shown.
 */
function mayChooseOwner(ctx: ModuleContext): boolean {
  return ctx.engine.hasSpecial('REASSIGN_LEADS');
}

// ── read ──────────────────────────────────────────────────────────────────

/** The list, for a module named by slug. Storage, scope and serialisation all
 *  live in `records/list.ts`; this only resolves the config it needs. */
export async function listModuleRecords(
  principal: Principal,
  moduleSlug: string,
  opts: { take: number; skip?: number },
): Promise<{ records: RecordRow[]; total: number }> {
  const ctx = await moduleContext(principal, moduleSlug);
  const { rows, total } = await listRecords({
    module: ctx.module,
    fields: ctx.metas,
    engine: ctx.engine,
    take: opts.take,
    skip: opts.skip ?? 0,
  });
  return { records: rows, total };
}

/**
 * One record by id.
 *
 * Out of scope and non-existent give the same answer — a 404 — because a 403
 * on a record you may not see confirms that it exists.
 */
export async function getRecord(
  principal: Principal,
  moduleSlug: string,
  id: string,
): Promise<RecordRow> {
  const ctx = await moduleContext(principal, moduleSlug);
  const found = await findRecordById({
    module: ctx.module,
    fields: ctx.metas,
    engine: ctx.engine,
    actor: principal.actor,
    id,
  });
  if (!found) throw notFound();
  return serialiseRecord(ctx.engine, moduleSlug, found.values, ctx.metas);
}

// ── create ────────────────────────────────────────────────────────────────

export async function createRecord(
  principal: Principal,
  moduleSlug: string,
  input: unknown,
  meta: AuditMeta = {},
): Promise<RecordRow> {
  const ctx = await moduleContext(principal, moduleSlug);
  if (!ctx.engine.can('create', moduleSlug)) {
    throw new ConfigError('You cannot create records in this module', 403, 'FORBIDDEN');
  }

  const { storage, module } = ctx;
  const writable = writableFields(ctx, moduleSlug);
  let values = applyDefaults(writable, asObject(input));

  // Owner: nothing is EVER unassigned (invariant 1). A module that declares an
  // owner and lives in a table that carries one always gets a real user id —
  // the actor's own, unless they hold the reassignment permission and named
  // someone else.
  //
  // TODO(assignment engine): this is the placeholder for `AssignmentStrategy`
  // (spec §6.7) — round-robin within the matching language group, Seniors of
  // that language for ARK leads, default pool, then Admin. That engine is its
  // own slice; until it lands the creating user is the fallback, and the one
  // thing that must never change is that this writes a null.
  const ownerField = fieldForColumn(writable, storage.shape.ownerColumn);
  if (module.hasOwner && ownerField) {
    const supplied = str(values[ownerField.key]);
    values[ownerField.key] =
      supplied && mayChooseOwner(ctx) ? supplied : principal.actor.userId;
  }

  // Status: the module's first live status, unless one was chosen. Set before
  // validation because a module's status field is typically required — the
  // form does not have to send what the engine already knows.
  const statusField = fieldForColumn(writable, storage.shape.statusColumn);
  if (statusField) {
    const supplied = str(values[statusField.key]);
    if (supplied) await assertStatusBelongs(module.id, supplied);
    else {
      const fallback = await defaultStatusId(module.id);
      if (fallback) values[statusField.key] = fallback;
    }
  }

  values = normalisePhones(writable, values);

  // The ONE validation path. Everything above only decided what to hand it.
  const refOptions = await referenceOptionsFor(ctx, writable);
  const parsed = buildRecordSchema(
    writable.map((f) => toFieldDef(f, refOptions)),
  ).parse(values) as Row;

  const { columns, json } = storage.resolver.partition(parsed);
  if (!storage.shape.hasJsonContainer && Object.keys(json).length > 0) {
    // The table has no JSONB container, so a field not mapped to a column has
    // nowhere to go. Silently dropping it would lose data on save.
    throw new ConfigError(
      'This module cannot store custom fields — every field must map to a column',
      422,
      'GUARDRAIL',
    );
  }

  const data: Row = {
    ...storage.writeDiscriminator(),
    ...columns,
    ...(storage.shape.hasJsonContainer
      ? { [storage.resolver.jsonColumn]: plain(json) }
      : {}),
    ...(storage.shape.createdByColumn
      ? { [storage.shape.createdByColumn]: principal.actor.userId }
      : {}),
  };

  const select = selectFor(storage, ctx.metas);

  // The row, its RECORD_CREATED entry and any duplicate flag commit together
  // or not at all: a record with no creation entry has no timeline origin, and
  // an entry for a row that rolled back is a lie the log can never correct.
  const row = await writing(() =>
    prisma.$transaction(async (tx) => {
      const created = await delegateOrThrow(tx, ctx).create({ data, select });
      const id = String(created['id']);
      const logger = auditWithin(tx);

      // The whole field set as `null -> value`, so the first timeline entry is
      // also the record's opening snapshot.
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const [key, value] of Object.entries(auditValues(writable, parsed))) {
        changes[key] = { from: null, to: value };
      }

      await logger.log({
        entityType: storage.shape.entityType,
        entityId: id,
        action: 'RECORD_CREATED',
        actorType: 'USER',
        actorId: principal.actor.userId,
        changes,
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });

      await flagDuplicates(tx, ctx, { id, values: parsed, meta, actorId: principal.actor.userId });
      return created;
    }),
  );

  const flat = storage.resolver.flatten(row);
  flat['id'] = row['id'];
  return serialiseRecord(ctx.engine, moduleSlug, flat, ctx.metas);
}

// ── duplicate flagging (spec §6.6) ────────────────────────────────────────

/** What matched, as `DuplicateFlag.matchReason` records it. */
type MatchReason = 'phone' | 'name_language';

/**
 * The module's primary matching key: the first live PHONE field the Admin
 * marked system. System fields are exactly the ones "assignment, matching and
 * logging depend on" (spec §4.3), which is why Leads matches on `phone` and
 * not on the alternate or WhatsApp numbers sitting beside it. With no system
 * phone field, the first phone field is the only sensible candidate.
 */
function primaryPhoneField(fields: FieldRow[]): FieldRow | null {
  const phones = fields.filter((f) => f.type === 'PHONE');
  return phones.find((f) => f.isSystem) ?? phones[0] ?? null;
}

/** An equality condition against wherever a field physically lives. */
function matchOn(storage: Storage, key: string, value: unknown): Row {
  const loc = storage.resolver.resolve(key);
  return loc.column
    ? { [loc.column]: value }
    : { [loc.jsonColumn]: { path: [loc.key], equals: value } };
}

/**
 * Flag a probable duplicate — never block one, never merge one.
 *
 * A lead matching an existing record on normalised phone, or on name plus
 * language, is CREATED and flagged for review (spec §6.6). The review queue
 * shows the pair side by side and a permitted user decides; nothing here is
 * allowed to reject the write or touch the other record.
 *
 * The scan deliberately runs OUTSIDE the actor's view scope: a duplicate the
 * actor cannot see is still a duplicate, and a scan that missed it would let
 * the same customer be worked twice by two teams. Nothing about the matched
 * record leaves this function except its id, written into a flag row that the
 * review queue serves under its own permissions.
 */
async function flagDuplicates(
  tx: Tx,
  ctx: ModuleContext,
  record: { id: string; values: Row; meta: AuditMeta; actorId: string },
): Promise<void> {
  const { storage } = ctx;
  // `DuplicateFlag` FKs point at one table only — see `canFlagDuplicates`.
  // Scanning without being able to record the result would cost a query and
  // produce a timeline entry pointing at a queue that has no such row.
  if (!storage.shape.canFlagDuplicates) return;

  const phoneField = primaryPhoneField(ctx.fields);
  const nameField = ctx.fields.find((f) => f.key === ctx.module.recordTitleField) ?? null;
  const languageField = fieldForColumn(ctx.fields, storage.shape.languageColumn);

  const phone = phoneField ? str(record.values[phoneField.key]) : null;
  const name = nameField ? str(record.values[nameField.key]) : null;
  const language = languageField ? str(record.values[languageField.key]) : null;

  // Strongest match first, so the flag records the reason a human trusts most.
  const probes: { reason: MatchReason; confidence: string; where: Row }[] = [];
  if (phoneField && phone) {
    probes.push({
      reason: 'phone',
      confidence: 'HIGH',
      where: matchOn(storage, phoneField.key, phone),
    });
  }
  if (nameField && name && languageField && language) {
    probes.push({
      reason: 'name_language',
      confidence: 'MEDIUM',
      // AND, not a merged object: both halves can resolve to the SAME JSONB
      // container, and one key would silently overwrite the other.
      where: {
        AND: [
          matchOn(storage, nameField.key, name),
          matchOn(storage, languageField.key, language),
        ],
      },
    });
  }
  if (probes.length === 0) return;

  const delegate = delegateOrThrow(tx, ctx);
  const base: Row = {
    ...storage.resolver.discriminator,
    ...(storage.shape.softDeleteColumn === null
      ? {}
      : { [storage.shape.softDeleteColumn]: false }),
    // The record that was just written is not its own duplicate.
    id: { not: record.id },
  };

  for (const probe of probes) {
    const hit = await delegate.findFirst({
      where: { ...base, ...probe.where },
      // The id and nothing else: this scan is not a read of someone else's row.
      select: { id: true },
    });
    if (!hit) continue;

    const candidateId = String(hit['id']);
    await tx.duplicateFlag.create({
      data: {
        moduleSlug: ctx.module.slug,
        // The NEW record is the primary — it is the one under review.
        primaryLeadId: record.id,
        candidateLeadId: candidateId,
        matchReason: probe.reason,
        confidence: probe.confidence,
      },
    });

    await auditWithin(tx).log({
      entityType: storage.shape.entityType,
      entityId: record.id,
      action: 'DUPLICATE_FLAGGED',
      actorType: 'USER',
      actorId: record.actorId,
      changes: {
        duplicateOf: { from: null, to: candidateId },
        matchReason: { from: null, to: probe.reason },
      },
      ipAddress: record.meta.ipAddress ?? null,
      userAgent: record.meta.userAgent ?? null,
    });
    // One flag per create: the review queue resolves a PAIR, and a second
    // weaker match on the same record is noise until that pair is settled.
    return;
  }
}

// ── update ────────────────────────────────────────────────────────────────

export async function updateRecord(
  principal: Principal,
  moduleSlug: string,
  id: string,
  input: unknown,
  meta: AuditMeta = {},
): Promise<RecordRow> {
  const ctx = await moduleContext(principal, moduleSlug);
  const { storage, module } = ctx;

  const writable = writableFields(ctx, moduleSlug);
  let submitted = asObject(input);

  // An owner change is a reassignment, which is its own permission. Dropping
  // the key rather than rejecting it keeps a form that renders the owner field
  // from failing every save for a role that may not change it.
  const ownerField = fieldForColumn(writable, storage.shape.ownerColumn);
  if (ownerField && !mayChooseOwner(ctx)) delete submitted[ownerField.key];

  const statusField = fieldForColumn(writable, storage.shape.statusColumn);
  if (statusField) {
    const supplied = str(submitted[statusField.key]);
    if (supplied) await assertStatusBelongs(module.id, supplied);
  }

  submitted = normalisePhones(writable, submitted);

  // `.partial()` on the generated schema: a PATCH says what changed, so a
  // required field that is simply absent is not a validation failure — but a
  // field that IS present still faces the same rules as on create.
  const refOptions = await referenceOptionsFor(ctx, writable);
  const parsed = buildRecordSchema(writable.map((f) => toFieldDef(f, refOptions)))
    .partial()
    .parse(submitted) as Row;

  // Only the keys the payload actually carried. Zod's `.partial()` leaves
  // absent keys undefined, and treating those as "set to null" would wipe
  // every field the form did not render.
  const changesIn: Row = {};
  for (const f of writable) {
    if (f.key in parsed && parsed[f.key] !== undefined) changesIn[f.key] = parsed[f.key];
  }

  const select = selectFor(storage, ctx.metas);

  const row = await writing(() =>
    prisma.$transaction(async (tx) => {
      // Loaded through the SAME scope filter as the list, inside the same
      // transaction as the write — and the permission check runs against the
      // loaded row, so OWN / GROUP / DEPARTMENT are checked against THIS
      // record rather than against the module in the abstract.
      const before = await findRecordById({
        module,
        fields: ctx.metas,
        engine: ctx.engine,
        actor: principal.actor,
        id,
        client: tx,
      });
      if (!before) throw notFound();
      if (!ctx.engine.can('edit', moduleSlug, before.owned)) {
        throw new ConfigError('You cannot edit this record', 403, 'FORBIDDEN');
      }

      const logger = auditWithin(tx);
      // Compare the JSON forms of both sides: a stored Decimal against a
      // submitted number, or a Date against an ISO string, are not changes.
      // The ignore set is empty on purpose — every key here is a configured
      // field key, and `updatedAt` is not one of them.
      const diff = logger.diff(
        auditValues(writable, before.values),
        auditValues(writable, { ...before.values, ...changesIn }),
        new Set<string>(),
      );

      const changedKeys = Object.keys(diff);
      // No changes means no write and NO audit rows: a save that changed
      // nothing must not add a line to the timeline (and must not bump
      // `updatedAt`, which is what "last touched" reporting reads).
      if (changedKeys.length === 0) return before.raw;

      const changedFields = writable.filter((f) => changedKeys.includes(f.key));
      const { columns, json } = storage.resolver.partition(
        Object.fromEntries(changedFields.map((f) => [f.key, changesIn[f.key]])),
      );

      const data: Row = { ...columns };
      if (Object.keys(json).length > 0) {
        if (!storage.shape.hasJsonContainer) {
          throw new ConfigError(
            'This module cannot store custom fields — every field must map to a column',
            422,
            'GUARDRAIL',
          );
        }
        // Prisma REPLACES a Json column, it does not merge: writing `json`
        // alone would delete every custom field the payload did not mention.
        const container = (before.raw[storage.resolver.jsonColumn] ?? {}) as Row;
        data[storage.resolver.jsonColumn] = plain({ ...container, ...json });
      }

      const updated = await delegateOrThrow(tx, ctx).update({ where: { id }, data, select });

      // ONE entry per changed field, each carrying only its own before/after —
      // that is what the timeline renders as a line. Status and owner changes
      // get their own actions so they stand out among ordinary edits.
      const entries: AuditEntry[] = changedFields.map((f) => ({
        entityType: storage.shape.entityType,
        entityId: id,
        action: actionFor(storage, f),
        actorType: 'USER',
        actorId: principal.actor.userId,
        changes: { [f.key]: diff[f.key]! },
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      }));
      await logger.logMany(entries);

      return updated;
    }),
  );

  const flat = storage.resolver.flatten(row);
  flat['id'] = row['id'];
  return serialiseRecord(ctx.engine, moduleSlug, flat, ctx.metas);
}

// ── delete ────────────────────────────────────────────────────────────────

/**
 * Soft delete, always (invariant 4). The row stays, its audit history stays
 * readable, and every scoped read filters it out through the same column.
 */
export async function softDeleteRecord(
  principal: Principal,
  moduleSlug: string,
  id: string,
  meta: AuditMeta = {},
): Promise<void> {
  const ctx = await moduleContext(principal, moduleSlug);
  const { storage } = ctx;

  await writing(() =>
    prisma.$transaction(async (tx) => {
      const found = await findRecordById({
        module: ctx.module,
        fields: ctx.metas,
        engine: ctx.engine,
        actor: principal.actor,
        id,
        client: tx,
      });
      if (!found) throw notFound();
      if (!ctx.engine.can('delete', moduleSlug, found.owned)) {
        throw new ConfigError('You cannot delete this record', 403, 'FORBIDDEN');
      }

      // Some tables have NO delete path at all, by design: a user is
      // deactivated rather than deleted, and a deposit is an immutable ledger
      // row. Assuming an `isDeleted` column exists would throw at query time;
      // saying so is the honest answer.
      const column = storage.shape.softDeleteColumn;
      if (column === null) {
        throw new ConfigError('Records in this module cannot be deleted', 422, 'GUARDRAIL');
      }

      await delegateOrThrow(tx, ctx).update({
        where: { id },
        data: { [column]: true },
        select: { id: true },
      });

      await auditWithin(tx).log({
        entityType: storage.shape.entityType,
        entityId: id,
        action: 'RECORD_DELETED',
        actorType: 'USER',
        actorId: principal.actor.userId,
        changes: { [column]: { from: false, to: true } },
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });
    }),
  );
}

// ── timeline ──────────────────────────────────────────────────────────────

export interface TimelineEntry {
  id: string;
  action: string;
  actorType: string;
  actorId: string | null;
  /** null for system actors — the client labels those from `actorType` */
  actorName: string | null;
  changes: Record<string, unknown> | null;
  createdAt: string;
}

export interface TimelineResult {
  entries: TimelineEntry[];
  nextCursor: string | null;
}

const TIMELINE_DEFAULT_TAKE = 50;
const TIMELINE_MAX_TAKE = 200;

/**
 * The record's timeline: `AuditLog` for this entity, newest first.
 *
 * There is no timeline table and there must never be one (invariant 2). Every
 * line rendered on a record — created, reassigned, status changed, each field
 * edit with before → after — is a row this service wrote at mutation time.
 *
 * `entityType` is the PRISMA MODEL NAME the storage layer reports, the same
 * value every write above uses. It is deliberately not the module slug: slugs
 * are Admin-editable, and a rename would orphan the entire history.
 */
export async function getTimeline(
  principal: Principal,
  moduleSlug: string,
  id: string,
  opts: { take?: number; cursor?: string | null } = {},
): Promise<TimelineResult> {
  const ctx = await moduleContext(principal, moduleSlug);

  // The scope check for the timeline is the scope check for the record: an
  // actor who cannot load the row cannot read its history either.
  const found = await findRecordById({
    module: ctx.module,
    fields: ctx.metas,
    engine: ctx.engine,
    actor: principal.actor,
    id,
  });
  if (!found) throw notFound();

  // A module can be configured without a timeline; the log rows still exist
  // for the admin viewer, they are simply not part of that module's screen.
  if (!ctx.module.hasTimeline) return { entries: [], nextCursor: null };

  const take = Math.min(Math.max(opts.take ?? TIMELINE_DEFAULT_TAKE, 1), TIMELINE_MAX_TAKE);
  const cursor = str(opts.cursor ?? null);

  const rows = await prisma.auditLog.findMany({
    where: { entityType: ctx.storage.shape.entityType, entityId: id },
    // `id` breaks ties: several entries of one save share a timestamp, and an
    // unstable order would repeat or skip rows across a cursor page.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: take + 1,
    select: {
      id: true,
      action: true,
      actorType: true,
      actorId: true,
      changes: true,
      createdAt: true,
    },
  });

  const page = rows.slice(0, take);
  const nextCursor = rows.length > take ? (page[page.length - 1]?.id ?? null) : null;

  const actorIds = [...new Set(page.map((r) => r.actorId).filter((v): v is string => !!v))];
  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, fullName: true },
      })
    : [];
  const nameById = new Map(actors.map((a) => [a.id, a.fullName]));

  // A diff can carry the value of a field this actor may not see, so the same
  // strip that governs a record governs its history — hiding a field in the UI
  // is not a security control, and a timeline is a read like any other.
  const hidden = ctx.engine.hiddenFields(moduleSlug);

  return {
    entries: page.map((r) => ({
      id: r.id,
      action: r.action,
      actorType: r.actorType,
      actorId: r.actorId,
      actorName: r.actorId ? (nameById.get(r.actorId) ?? null) : null,
      changes: visibleChanges(r.changes, hidden),
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

/** Drop hidden and never-serialised keys from a stored diff. An entry left
 *  with no visible key still renders — "something changed", by whom and when
 *  is exactly what the actor is allowed to know. */
function visibleChanges(
  changes: unknown,
  hidden: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes as Row)) {
    if (hidden.has(key) || NEVER_SERIALISED.has(key)) continue;
    out[key] = plain(value);
  }
  return out;
}
