/**
 * The ARK webhook consumer — where a stored account event becomes one of
 * spec §7's four outcomes, or a FAILED event that says why.
 *
 * THE ONE RULE THIS FILE KEEPS, same as intake and imports: nothing here
 * writes a lead, a deal, a deposit or an audit row itself. Every mutation
 * goes THROUGH `@crm/records` — `convertLead`, `recordDeposit`,
 * `createRecord`, `updateRecord` — so the invariants hold for webhook data
 * without anyone remembering them here: Closed By is set once by the
 * conversion service and never again; totals are recomputed from ledger
 * rows; the new-lead path runs the assignment engine (which already routes
 * `ARK_TERMINAL` to the senior pool) so NOTHING IS EVER UNASSIGNED; every
 * row is logged in the same transaction as its write, stamped
 * `SYSTEM_ARK_WEBHOOK`, so the timeline reads "System (ARK Webhook)".
 *
 * NO MODULE IS NAMED. The lead-side and deal-side modules come from
 * `resolveConversionModules`, which asks the storage shapes which table
 * carries a Closed By column and a ledger, and which table that one inherits
 * its timeline from. Every column this file touches is read off those shapes
 * and every field key off the modules' live definitions. If a future edit is
 * tempted to write `'leads'` or `'deals'` here: that is the defect CLAUDE.md
 * opens with.
 *
 * THE SPACE. Nothing in this file knows what an ARK payload looks like — no
 * technical spec exists. The shape lives in `WebhookSource.fieldMapping`
 * (an `arkMappingSchema`), edited by the Admin; this job only EXECUTES that
 * mapping over the stored body through `parseArkPayload`. A source with no
 * mapping yet produces a FAILED event saying exactly that, and replay re-runs
 * it the day the mapping exists.
 *
 * WHAT IS NOT A SPACE — what this file fixes because the spec fixes it:
 *
 *   MATCH (spec §7 step 3), through scoped reads as the system principal:
 *     1. deals first — by account number, else by the linked lead's
 *        normalised phone;
 *     2. then ACTIVE leads — not soft-deleted and NOT already converted
 *        (status tag ≠ CONVERTED) — by normalised phone.
 *
 *   CONFIDENCE: a phone match whose name agrees (case- and whitespace-
 *   insensitive; a missing name on either side counts as agreement) is
 *   processed silently. A phone match with a CONFLICTING name is processed
 *   anyway — the phone is the primary key (spec §6.2) and blocking would
 *   lose a deposit — AND flagged for review: a `DuplicateFlag` with
 *   `matchReason: 'ark_name_conflict'` and the lowest confidence, so it
 *   lands in the same review queue as every other duplicate (spec §6.6).
 *
 *   THE FOUR OUTCOMES, each settled with its event in ONE transaction:
 *     REDEPOSIT       existing deal matched → one more ledger row. No new deal.
 *                     With no deposit on the event: IGNORED, nothing to record.
 *     CONVERTED       lead matched + deposit → `convertLead`. THE conversion.
 *     SIGNED_UP       lead matched, account only → account number written,
 *                     status moved to the SIGNED_UP tag. Stays a lead.
 *     NEW_LEAD        no match → `createRecord`, Source = ARK Terminal, with
 *                     the referral; and if a deposit came with it, converted
 *                     in the same run (the event then records CONVERTED, with
 *                     both ids) — a brand-new account that deposited is a deal.
 *
 * ONE ATTEMPT. Every outcome is written onto the event row, and a payload the
 * mapping cannot digest is the same payload on the fifth retry — see the
 * queue options in `apps/web/src/lib/ark/queue.ts`. Replay is the retry, and
 * it is SAFE on a processed event: `recordDeposit` dedupes on the event id,
 * a replayed conversion finds its deal first and takes the re-deposit path,
 * and a replayed account-only event diffs to nothing.
 */
import { Worker, type Job } from 'bullmq';
import { ZodError } from 'zod';
import { prisma, type Prisma } from '@crm/db';
import { pickStatusByTag, type AuditEntry, type StatusRow } from '@crm/core';
import {
  ARK_CONFLICT_NAME_KEY,
  ARK_NAME_CONFLICT_CONFIDENCE,
  ARK_NAME_CONFLICT_REASON,
  ARK_OUTCOME_KEY,
  ARK_SOURCE_KIND,
  ARK_WEBHOOK_QUEUE,
  arkWebhookJobSchema,
  depositOf,
  namesAgree,
  parseArkMapping,
  parseArkPayload,
  type ArkMapping,
  type ArkOutcome,
  type ArkParsedEvent,
} from '@crm/shared';
import {
  ConfigError,
  WEBHOOK_EVENT_KEY,
  actorIdentity,
  auditWithin,
  convertLead,
  createRecord,
  delegateOrThrow,
  fieldForColumn,
  findRecordById,
  matchOn,
  primaryPhoneField,
  recordDeposit,
  resolveConversionModules,
  scopedWhere,
  selectFor,
  systemPrincipal,
  updateRecord,
  type ConversionModules,
  type FieldRow,
  type ModuleContext,
  type Principal,
  type Row,
  type Tx,
} from '@crm/records';
import { connection } from '../lib/redis.js';

/**
 * The Source stamp a lead created by this pipeline carries. Read as an OPAQUE
 * MARKER, exactly as `routeFor` in the assignment engine reads it: `LeadSource`
 * is a database enum (spec §6.1, "a permanent, immutable Source stamp"), not
 * an Admin-editable picklist. This is the value the assignment engine routes
 * to the senior pool. Nothing else in this file names a field, a status or
 * an option.
 */
const ARK_SOURCE_STAMP = 'ARK_TERMINAL';

/** The honest state while ARK is unknown — quoted by the events screen, so
 *  it has to tell the Admin what to do next. */
const NO_MAPPING_ERROR = 'No ARK payload mapping configured yet';

/** Event-row error cap: a Zod error runs to kilobytes, and the events screen
 *  shows the first line. */
const ERROR_MAX_CHARS = 1000;

/**
 * Every outcome transaction: the conversion advances the handover rota under
 * a row lock and writes a handful of audit rows across a pooled, cross-region
 * connection. Prisma's 5s default is sized for a single-row write.
 */
const TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

// ── what one run needs ────────────────────────────────────────────────────

interface RunContext {
  eventId: string;
  principal: Principal;
  modules: ConversionModules;
  mapping: ArkMapping;
  event: ArkParsedEvent;
  /** the deposit the event carried, or null for an account-only event */
  deposit: { amount: number; depositedAt: Date } | null;
}

type Settled =
  | { status: 'PROCESSED'; outcome: ArkOutcome; leadId: string | null; dealId: string | null }
  | { status: 'FAILED' | 'IGNORED'; error: string };

/** An existing deal, with the lead it came from (for the name to agree on). */
interface DealMatch {
  kind: 'deal';
  dealId: string;
  leadId: string | null;
  leadName: string | null;
}

/** An active, not-yet-converted lead. */
interface LeadMatch {
  kind: 'lead';
  leadId: string;
  leadName: string | null;
  statusTag: string | null;
}

/** A non-empty string, or null. Row values arrive as `unknown`. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ── error text ────────────────────────────────────────────────────────────

/** Whatever went wrong, as one line the Admin can act on from the events
 *  screen: the parsed-event schema names the concept, the conversion service
 *  names its refusal, anything else is quoted as it came. */
function describeError(err: unknown): string {
  let text: string;
  if (err instanceof ZodError) {
    text = err.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
  } else if (err instanceof ConfigError || err instanceof Error) {
    text = err.message;
  } else {
    text = String(err);
  }
  return text.length > ERROR_MAX_CHARS ? `${text.slice(0, ERROR_MAX_CHARS - 1)}…` : text;
}

// ── settlement ────────────────────────────────────────────────────────────

type SettleClient = Pick<Prisma.TransactionClient, 'webhookEvent'>;

/**
 * Write the outcome onto the event row. Takes the OUTCOME's transaction when
 * there is one, so a deal can never exist whose event still says RECEIVED
 * and an event can never say PROCESSED for a deposit that rolled back.
 */
async function settle(client: SettleClient, eventId: string, outcome: Settled): Promise<void> {
  await client.webhookEvent.update({
    where: { id: eventId },
    data:
      outcome.status === 'PROCESSED'
        ? {
            status: 'PROCESSED',
            error: null,
            outcome: outcome.outcome,
            leadId: outcome.leadId,
            dealId: outcome.dealId,
            processedAt: new Date(),
          }
        : {
            status: outcome.status,
            error: outcome.error,
            outcome: null,
            processedAt: new Date(),
          },
    select: { id: true },
  });
}

// ── the lead-side module, read ────────────────────────────────────────────

/** The record's name: the lead-side module's own title field — the same rule
 *  the duplicate scan matches names on. */
function titleOf(ctx: ModuleContext, values: Row): string | null {
  const field = ctx.fields.find((f) => f.key === ctx.module.recordTitleField);
  return field ? str(values[field.key]) : null;
}

/** THE matching key (spec §7 step 3): the module's primary phone field, by
 *  the record engine's own definition. A module without one cannot be
 *  matched on, which is broken config rather than a bad payload. */
function phoneFieldOf(ctx: ModuleContext): FieldRow {
  const field = primaryPhoneField(ctx.fields);
  if (!field) {
    throw new ConfigError('The lead-side module has no phone field to match on', 500, 'GUARDRAIL');
  }
  return field;
}

/** Every status of a module, deleted ones included: a lead parked on a
 *  retired CONVERTED status is still converted. */
async function statusesOf(moduleId: string): Promise<StatusRow[]> {
  return prisma.status.findMany({
    where: { moduleId },
    select: { id: true, name: true, tag: true, displayOrder: true, isDeleted: true },
  });
}

/** Load one record through the scope filter — the system principal sees
 *  everything, which is the point: a match outside anyone's scope is still
 *  the match. */
async function loadRecord(principal: Principal, ctx: ModuleContext, id: string) {
  return findRecordById({
    module: ctx.module,
    fields: ctx.metas,
    engine: ctx.engine,
    actor: principal.actor,
    id,
  });
}

/**
 * Ids of the live lead-side records carrying this phone, newest first. Used
 * to reach a deal through its linked lead: the deal-side table has no phone
 * of its own (a deal's origin is its lead, one hop away), so the hop is made
 * explicitly here rather than through a relation name the shape does not
 * declare.
 */
async function leadIdsByPhone(run: RunContext, ctx: ModuleContext): Promise<string[]> {
  const phoneField = phoneFieldOf(ctx);
  const rows = await delegateOrThrow(prisma, ctx).findMany({
    // AND, never a flat merge — the same reasoning as `combine()` in the
    // repository: a probe key must never overwrite a scope key.
    where: {
      AND: [
        scopedWhere(ctx.storage, ctx.engine, ctx.module.slug),
        matchOn(ctx.storage, phoneField.key, run.event.phone),
      ],
    },
    select: { id: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: 100,
    skip: 0,
  });
  return rows.map((row) => String(row['id']));
}

// ── match (spec §7 step 3) ────────────────────────────────────────────────

/** Deals first: by account number, else by the linked lead's phone. */
async function matchDeal(run: RunContext): Promise<DealMatch | null> {
  const { source, target, link } = run.modules;
  const accountColumn = target.storage.shape.accountNumberColumn;
  if (!accountColumn) {
    throw new ConfigError('The conversion target has no account-number column to match on', 500, 'GUARDRAIL');
  }

  const delegate = delegateOrThrow(prisma, target);
  const scoped = scopedWhere(target.storage, target.engine, target.module.slug);
  const select: Row = { id: true, [link.column]: true };

  let deal = await delegate.findFirst({
    where: { AND: [scoped, { [accountColumn]: run.event.accountNumber }] },
    select,
  });
  if (!deal) {
    const leadIds = await leadIdsByPhone(run, source);
    if (leadIds.length > 0) {
      deal = await delegate.findFirst({
        where: { AND: [scoped, { [link.column]: { in: leadIds } }] },
        select,
      });
    }
  }
  if (!deal) return null;

  // The name to agree on lives on the lead the deal came from.
  const leadId = str(deal[link.column]);
  const lead = leadId ? await loadRecord(run.principal, source, leadId) : null;
  return {
    kind: 'deal',
    dealId: String(deal['id']),
    leadId,
    leadName: lead ? titleOf(source, lead.values) : null,
  };
}

/**
 * Then ACTIVE leads: live (the scope filter applies the soft-delete column)
 * and not already converted — read by TAG, never by name. Newest first when
 * several carry the phone: the one the agent is working is the one that was
 * created last, and the older ones are the duplicate queue's business.
 */
async function matchActiveLead(run: RunContext): Promise<LeadMatch | null> {
  const { source } = run.modules;
  const phoneField = phoneFieldOf(source);
  const statusColumn = source.storage.shape.statusColumn;

  const statuses = await statusesOf(source.module.id);
  const convertedIds = statuses.filter((s) => s.tag === 'CONVERTED').map((s) => s.id);

  const rows = await delegateOrThrow(prisma, source).findMany({
    where: {
      AND: [
        scopedWhere(source.storage, source.engine, source.module.slug),
        matchOn(source.storage, phoneField.key, run.event.phone),
        ...(statusColumn && convertedIds.length > 0 ? [{ [statusColumn]: { notIn: convertedIds } }] : []),
      ],
    },
    select: selectFor(source.storage, source.metas),
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: 1,
    skip: 0,
  });
  const row = rows[0];
  if (!row) return null;

  const values = source.storage.resolver.flatten(row);
  const statusId = statusColumn ? str(row[statusColumn]) : null;
  return {
    kind: 'lead',
    leadId: String(row['id']),
    leadName: titleOf(source, values),
    statusTag: statuses.find((s) => s.id === statusId)?.tag ?? null,
  };
}

// ── confidence (spec §7) ──────────────────────────────────────────────────

/**
 * A phone hit whose name does not agree: processed anyway, AND flagged.
 *
 * `DuplicateFlag` is a PAIR of lead-side rows, and the other side of this
 * conflict is not a row but a payload — so the flag pairs the record with
 * itself, under its own reason, and the name ARK sent travels on the
 * DUPLICATE_FLAGGED timeline entry beside the event id. The review queue
 * lists it like any other pending pair; a reviewer opens the record, reads
 * the conflicting name off its timeline, and settles it through the same
 * three resolutions. A flag that was already settled for this record is
 * reopened — a fresh conflicting event is new evidence, not the old case.
 *
 * TODO(dedupe): the honest model is a flag whose second side can be a
 * webhook event. That is a MIGRATION on `DuplicateFlag` (see the
 * `canFlagDuplicates` note in the storage shapes), not a branch here.
 */
async function flagNameConflict(
  tx: Tx,
  run: RunContext,
  leadId: string | null,
  recordName: string | null,
): Promise<void> {
  if (!leadId || namesAgree(run.event.name, recordName)) return;
  const { source } = run.modules;
  // The flag's foreign keys point at one table only; a module stored
  // elsewhere cannot be flagged, and a flag that cannot be written must not
  // leave a timeline entry pointing at a queue with no such row.
  if (!source.storage.shape.canFlagDuplicates) return;

  const pair = { primaryLeadId: leadId, candidateLeadId: leadId };
  const existing = await tx.duplicateFlag.findUnique({
    where: { primaryLeadId_candidateLeadId: pair },
    select: { id: true, status: true },
  });
  if (!existing) {
    await tx.duplicateFlag.create({
      data: {
        moduleSlug: source.module.slug,
        ...pair,
        matchReason: ARK_NAME_CONFLICT_REASON,
        confidence: ARK_NAME_CONFLICT_CONFIDENCE,
      },
    });
  } else if (existing.status !== 'PENDING') {
    await tx.duplicateFlag.update({
      where: { id: existing.id },
      data: {
        status: 'PENDING',
        resolvedById: null,
        resolvedAt: null,
        matchReason: ARK_NAME_CONFLICT_REASON,
        confidence: ARK_NAME_CONFLICT_CONFIDENCE,
      },
    });
  }

  await auditWithin(tx).log({
    entityType: source.storage.shape.entityType,
    entityId: leadId,
    action: 'DUPLICATE_FLAGGED',
    ...actorIdentity(run.principal),
    changes: {
      duplicateOf: { from: null, to: leadId },
      matchReason: { from: null, to: ARK_NAME_CONFLICT_REASON },
      [ARK_CONFLICT_NAME_KEY]: { from: null, to: run.event.name ?? null },
      [WEBHOOK_EVENT_KEY]: { from: null, to: run.eventId },
    },
    ipAddress: null,
    userAgent: null,
  });
}

// ── the log line every outcome leaves ─────────────────────────────────────

/** Spec §7 step 5: "every step written with actor System (ARK Webhook),
 *  appearing on the record's timeline" — one WEBHOOK_RECEIVED entry on the
 *  record the event landed on, naming the event and the outcome it took. */
function receipt(run: RunContext, ctx: ModuleContext, recordId: string, outcome: ArkOutcome): AuditEntry {
  return {
    entityType: ctx.storage.shape.entityType,
    entityId: recordId,
    action: 'WEBHOOK_RECEIVED',
    ...actorIdentity(run.principal),
    changes: {
      [WEBHOOK_EVENT_KEY]: { from: null, to: run.eventId },
      [ARK_OUTCOME_KEY]: { from: null, to: outcome },
    },
    ipAddress: null,
    userAgent: null,
  };
}

// ── the four outcomes ─────────────────────────────────────────────────────

/** Outcome 1 — existing deal matched (re-deposit). NO new deal. */
async function redeposit(run: RunContext, match: DealMatch): Promise<Settled> {
  if (!run.deposit) {
    return {
      status: 'IGNORED',
      error: 'An account event for an existing deal carried no deposit, so there is nothing to record',
    };
  }
  const { target } = run.modules;
  const deposit = run.deposit;

  return prisma.$transaction(async (tx) => {
    await flagNameConflict(tx, run, match.leadId, match.leadName);
    // Idempotent on the event id: a replay returns the existing row.
    await recordDeposit(run.principal, tx, {
      dealId: match.dealId,
      amount: deposit.amount,
      depositedAt: deposit.depositedAt,
      webhookEventId: run.eventId,
      isFtd: false,
    });
    await auditWithin(tx).log(receipt(run, target, match.dealId, 'REDEPOSIT'));

    const settled: Settled = { status: 'PROCESSED', outcome: 'REDEPOSIT', leadId: match.leadId, dealId: match.dealId };
    await settle(tx, run.eventId, settled);
    return settled;
  }, TX_OPTIONS);
}

/**
 * Outcome 2 — lead matched, deposit present: THE conversion. Also the second
 * half of outcome 4 when a brand-new account arrived funded.
 */
async function convert(run: RunContext, leadId: string, leadName: string | null): Promise<Settled> {
  const deposit = run.deposit;
  if (!deposit) throw new ConfigError('A conversion needs a deposit', 500, 'GUARDRAIL');
  const { source } = run.modules;

  return prisma.$transaction(async (tx) => {
    await flagNameConflict(tx, run, leadId, leadName);
    // The lead's receipt is written BEFORE the conversion, not after: the
    // deal's timeline interleaves both histories by createdAt, and every
    // lead-era row must precede the deal's first own row or the rendered
    // history splits into several "as a lead" eras around one instant.
    // Chronologically it is also the truth — the webhook arrived, then the
    // conversion happened because of it.
    await auditWithin(tx).log(receipt(run, source, leadId, 'CONVERTED'));
    const { dealId } = await convertLead(run.principal, tx, {
      leadId,
      arkAccountNo: run.event.accountNumber,
      deposit: { amount: deposit.amount, depositedAt: deposit.depositedAt, webhookEventId: run.eventId },
      webhookEventId: run.eventId,
    });

    const settled: Settled = { status: 'PROCESSED', outcome: 'CONVERTED', leadId, dealId };
    await settle(tx, run.eventId, settled);
    return settled;
  }, TX_OPTIONS);
}

/**
 * Outcome 3 — lead matched, account only: account number filled, status
 * moved to the SIGNED_UP tag, still a lead. Through `updateRecord`, so the
 * write is validated by the module's generated schema and logged as
 * FIELD_CHANGED / STATUS_CHANGED exactly like an agent's edit would be.
 * `updateRecord` owns its own transaction, so the flag, the receipt and the
 * settlement follow in a second one; a replay diffs the update to nothing.
 */
async function signUp(run: RunContext, match: LeadMatch): Promise<Settled> {
  const { source } = run.modules;
  const shape = source.storage.shape;

  const accountField = fieldForColumn(source.fields, shape.accountNumberColumn);
  if (!accountField) {
    throw new ConfigError(
      'The lead-side module has no live field on its account-number column, so the account number cannot be written. Restore the field, then replay the event.',
      422,
      'GUARDRAIL',
    );
  }
  const statusField = fieldForColumn(source.fields, shape.statusColumn);
  if (!statusField) {
    throw new ConfigError('The lead-side module has no live status field', 422, 'GUARDRAIL');
  }

  // By TAG, never by name — the Admin may rename "Signed Up" this afternoon.
  // Loud when absent: `guardTagChange` stops the last SIGNED_UP status being
  // deleted, but a pipeline that trusted the guard and silently left the
  // lead where it was would hide the account from the agent working it.
  const signedUp = pickStatusByTag(await statusesOf(source.module.id), 'SIGNED_UP');
  if (!signedUp) {
    throw new ConfigError(
      'No active status is tagged SIGNED_UP, so an account-only event has nowhere to move the lead. Add one, then replay the event.',
      422,
      'GUARDRAIL',
    );
  }

  await updateRecord(run.principal, source.module.slug, match.leadId, {
    [accountField.key]: run.event.accountNumber,
    // A lead already on a SIGNED_UP-tagged status stays on it: two statuses
    // may share the tag and the Admin's choice between them is not ours.
    ...(match.statusTag === 'SIGNED_UP' ? {} : { [statusField.key]: signedUp.id }),
  });

  return prisma.$transaction(async (tx) => {
    await flagNameConflict(tx, run, match.leadId, match.leadName);
    await auditWithin(tx).log(receipt(run, source, match.leadId, 'SIGNED_UP'));

    const settled: Settled = { status: 'PROCESSED', outcome: 'SIGNED_UP', leadId: match.leadId, dealId: null };
    await settle(tx, run.eventId, settled);
    return settled;
  }, TX_OPTIONS);
}

/**
 * Which field on the lead-side module carries the referral (spec §7: "creates
 * a new Lead … with referral info"). The Admin's `referralField` override
 * wins; otherwise the module's SINGLE field whose key or label mentions
 * "referral". A heuristic over Admin vocabulary, stated as one: zero or
 * several candidates means the referral is not written rather than guessed,
 * and the override is the real answer.
 */
function referralFieldFor(run: RunContext): FieldRow | null {
  const { source } = run.modules;
  const override = run.mapping.referralField;
  if (override !== undefined) {
    const field = source.fields.find((f) => f.key === override);
    if (!field) {
      throw new ConfigError(`The referral field "${override}" does not exist on the lead-side module`, 422, 'VALIDATION');
    }
    return field;
  }
  const candidates = source.fields.filter((f) => /referral/i.test(f.key) || /referral/i.test(f.label));
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/**
 * Outcome 4 — no match: a new lead, through `createRecord`, so it is
 * validated, assigned (Source = ARK Terminal routes to the seniors of its
 * language), logged and duplicate-scanned exactly like any other create.
 *
 * The payload is written through FIELD KEYS resolved from the module's own
 * definitions and storage shape — never a key typed here. A required field
 * the payload did not carry (a module whose Language is required, a platform
 * that sends none) fails the generated schema with its own name, which is
 * the honest FAILED reason; the Admin's fix is a default on the field or a
 * mapping rule, not a deploy.
 */
async function createLead(run: RunContext): Promise<Settled> {
  const { source } = run.modules;
  const shape = source.storage.shape;
  const values: Row = {};

  const titleField = source.fields.find((f) => f.key === source.module.recordTitleField);
  if (titleField && run.event.name) values[titleField.key] = run.event.name;

  values[phoneFieldOf(source).key] = run.event.phone;

  const languageField = fieldForColumn(source.fields, shape.languageColumn);
  if (languageField && run.event.language) values[languageField.key] = run.event.language;

  const sourceField = fieldForColumn(source.fields, shape.sourceColumn);
  if (sourceField) values[sourceField.key] = ARK_SOURCE_STAMP;

  const accountField = fieldForColumn(source.fields, shape.accountNumberColumn);
  if (!accountField) {
    throw new ConfigError(
      'The lead-side module has no live field on its account-number column, so a new lead cannot carry its account number. Restore the field, then replay the event.',
      422,
      'GUARDRAIL',
    );
  }
  values[accountField.key] = run.event.accountNumber;

  const referralField = referralFieldFor(run);
  if (referralField && run.event.referral) values[referralField.key] = run.event.referral;

  const created = await createRecord(run.principal, source.module.slug, values);

  // A brand-new account that deposited is a deal: the same conversion as
  // outcome 2, on the lead that exists as of a moment ago, and the event
  // records CONVERTED with both ids. No name conflict is possible — the name
  // on the record IS the payload's.
  if (run.deposit) return convert(run, created.id, null);

  return prisma.$transaction(async (tx) => {
    await auditWithin(tx).log(receipt(run, source, created.id, 'NEW_LEAD'));
    const settled: Settled = { status: 'PROCESSED', outcome: 'NEW_LEAD', leadId: created.id, dealId: null };
    await settle(tx, run.eventId, settled);
    return settled;
  }, TX_OPTIONS);
}

// ── one event ─────────────────────────────────────────────────────────────

async function processEvent(run: RunContext): Promise<Settled> {
  const deal = await matchDeal(run);
  if (deal) return redeposit(run, deal);

  const lead = await matchActiveLead(run);
  if (lead) {
    return run.deposit ? convert(run, lead.leadId, lead.leadName) : signUp(run, lead);
  }

  return createLead(run);
}

/**
 * Everything a run needs, or the reason it cannot run. A `Settled` here is
 * a settlement decided before any matching happened; null means "nothing to
 * do" (the event is gone, or already PROCESSED — a job that somehow runs
 * twice must not act twice).
 */
async function buildContext(eventId: string): Promise<RunContext | Settled | null> {
  const event = await prisma.webhookEvent.findUnique({
    where: { id: eventId },
    include: { source: true },
  });
  if (!event) return null;
  if (event.status === 'PROCESSED') return null;

  if (!event.source) {
    return { status: 'IGNORED', error: 'The source this event arrived on no longer exists' };
  }
  if (event.source.kind !== ARK_SOURCE_KIND) {
    return { status: 'FAILED', error: 'This event arrived on a campaign-intake source, not an ARK source' };
  }
  if (!event.source.isActive) {
    return { status: 'IGNORED', error: 'This source is paused — resume it and replay the event' };
  }

  const mapping = parseArkMapping(event.source.fieldMapping);
  if (mapping === null) return { status: 'FAILED', error: NO_MAPPING_ERROR };

  const principal = systemPrincipal('SYSTEM_ARK_WEBHOOK');
  // Throws a ConfigError when the product has no conversion path — broken
  // config, which the caller turns into a FAILED (replayable) event.
  const modules = await resolveConversionModules(principal);
  // Throws a ZodError naming the missing or malformed concept.
  const parsed = parseArkPayload(event.raw, mapping);

  return { eventId, principal, modules, mapping, event: parsed, deposit: depositOf(parsed) };
}

async function processArkJob(job: Job): Promise<{ status: string; outcome?: string; error?: string }> {
  const { eventId } = arkWebhookJobSchema.parse(job.data);

  let outcome: Settled;
  try {
    const ctx = await buildContext(eventId);
    if (ctx === null) return { status: 'SKIPPED' };
    outcome = 'status' in ctx ? ctx : await processEvent(ctx);
  } catch (err) {
    // The wrap that keeps this job out of retry loops: a payload the mapping
    // cannot read, a status tag nobody seeded, a lead already converted, a
    // database that blinked — all land on the EVENT with a message, where
    // replay can reach them. Every transactional outcome rolled back whole.
    outcome = { status: 'FAILED', error: describeError(err) };
  }

  // PROCESSED outcomes settled themselves inside their own transaction;
  // a refusal is written here, on its own.
  if (outcome.status !== 'PROCESSED') await settle(prisma, eventId, outcome);

  if (outcome.status === 'PROCESSED') {
    console.log(
      `[ark] event ${eventId}: ${outcome.outcome}` +
        (outcome.dealId ? ` deal ${outcome.dealId}` : '') +
        (outcome.leadId ? ` lead ${outcome.leadId}` : ''),
    );
    return { status: outcome.status, outcome: outcome.outcome };
  }
  console.warn(`[ark] event ${eventId}: ${outcome.status} — ${outcome.error}`);
  return { status: outcome.status, error: outcome.error };
}

export function startArkWebhookWorker(): Worker {
  const worker = new Worker(ARK_WEBHOOK_QUEUE, processArkJob, {
    connection,
    // One event at a time, and not only for the rota lock: two events for
    // the SAME new account arriving together must not both miss the match
    // and create two leads. Serialising the consumer is what makes "deals
    // first, then leads, then create" a sequence rather than a race.
    concurrency: 1,
  });

  worker.on('failed', (job, err) => {
    // Only reachable when `processArkJob` itself threw — malformed job data,
    // or the settle write failing. The event row, if any, still holds
    // whatever status it had, and replay can reach it.
    console.error(`[ark] job ${job?.id ?? 'unknown'} failed:`, err.message);
  });

  return worker;
}
