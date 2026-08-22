/**
 * THE conversion moment (spec §7, outcome "lead matched, deposit present").
 *
 * A lead becomes a deal here and nowhere else. There is no manual Convert
 * button and there must never be one: `convertLeadInputSchema` REQUIRES a
 * `webhookEventId`, so there is no valid input to this function without a
 * raw ARK payload already persisted behind it.
 *
 * What one call does, in one transaction the caller owns:
 *
 *   1. loads the lead through the scoped read for the principal;
 *   2. refuses if a deal already exists for it (the link column is unique);
 *   3. creates the deal — Closed By = the lead's CURRENT owner, Deal Owner
 *      from the handover rule, language carried over, shared record links
 *      (the campaign) carried over, status = the first live deal status;
 *   4. writes the account number onto the lead and moves it to the
 *      CONVERTED tag, failing loudly if no live status carries that tag;
 *   5. records the FTD through the ledger when a deposit came with it;
 *   6. logs every step as the principal — `SYSTEM_ARK_WEBHOOK` in the
 *      pipeline — on BOTH records, so the deal's inherited timeline reads
 *      "converted" on the lead's side and "created" on its own.
 *
 * Nothing here names a module. Every column comes from the storage shapes
 * (`closedByColumn`, `accountNumberColumn`, `ledger`, `inheritsTimelineFrom`)
 * and every field key from the modules' live definitions.
 */
import { pickStatusByTag, type AuditEntry, type StatusRow } from '@crm/core';
import { convertLeadInputSchema, type ConversionResultDto, type ConvertLeadInput } from '@crm/shared';
import type { Principal } from '../principal.js';
import { ASSIGNMENT_REASON_KEY } from '../assignment/index.js';
import { auditWithin } from '../audit.js';
import { ConfigError, type Tx } from '../config/service.js';
import { findRecordById, selectFor, type Row } from '../records/list.js';
import {
  actorIdentity,
  auditValue,
  auditValues,
  defaultStatusId,
  delegateOrThrow,
  fieldForColumn,
  notFound,
  writing,
  type AuditMeta,
  type FieldRow,
  type ModuleContext,
} from '../records/service.js';
import { recordDeposit } from './deposit.js';
import { resolveHandoverOwner } from './handover.js';
import { CONVERTED_DEAL_KEY, WEBHOOK_EVENT_KEY } from './keys.js';
import { resolveConversionModules, type ConversionModules } from './modules.js';

/** A non-empty string, or null. Row values arrive as `unknown`. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The key a column's change is logged under: the Admin's field key when a
 *  field maps to the column (so the hidden-field strip applies), else the
 *  column itself. */
function auditKey(fields: FieldRow[], column: string): string {
  return fieldForColumn(fields, column)?.key ?? column;
}

/**
 * The status the originating record moves to — the one carrying the
 * CONVERTED tag, by the Admin's order. Read by TAG, never by name: the Admin
 * may rename "Converted" to "Funded" this afternoon.
 *
 * GUARDRAIL, 422, when no live status carries the tag. `guardTagChange`
 * exists so the Admin cannot delete or re-tag the last one, but a pipeline
 * that trusted the guard and silently left a converted lead in "Interested"
 * would be a lead the agent keeps calling about an account that exists. The
 * event stays FAILED and replayable; the fix is a status, not a deploy.
 */
async function convertedStatusFor(tx: Tx, source: ModuleContext): Promise<StatusRow> {
  const rows = await tx.status.findMany({
    where: { moduleId: source.module.id },
    select: { id: true, name: true, tag: true, displayOrder: true, isDeleted: true },
  });
  const converted = pickStatusByTag(rows, 'CONVERTED');
  if (!converted) {
    throw new ConfigError(
      'No active status is tagged CONVERTED, so a converted lead has nowhere to go. Add one, then replay the event.',
      422,
      'GUARDRAIL',
    );
  }
  return converted;
}

/**
 * Values the deal CARRIES OVER from the lead, found by what the two modules
 * share rather than by name: for every record-link field on the target that
 * points at a third module, the source's link field pointing at the SAME
 * module supplies the value. That is how "Campaign of origin" follows the
 * lead's campaign without either module being named — and how a link to a
 * module an Admin invents next year follows too.
 */
function carriedLinks(modules: ConversionModules, leadValues: Row): Row {
  const { source, target } = modules;
  const out: Row = {};
  for (const field of target.fields) {
    if (field.type !== 'RECORD_LINK' || field.relatedModuleId === null) continue;
    // The link back to the source itself is the parent column, written explicitly.
    if (field.relatedModuleId === source.module.id) continue;
    const twin = source.fields.find(
      (f) => f.type === 'RECORD_LINK' && f.relatedModuleId === field.relatedModuleId,
    );
    const value = twin ? str(leadValues[twin.key]) : null;
    if (value && field.systemColumn) out[field.systemColumn] = value;
  }
  return out;
}

/**
 * Convert a lead into a deal. See the file header for the sequence.
 *
 * `tx` is the caller's transaction: the webhook worker wraps the whole
 * outcome — this conversion and the event row's settlement — in one, so a
 * deal can never exist whose event still says RECEIVED, and vice versa.
 */
export async function convertLead(
  principal: Principal,
  tx: Tx,
  input: ConvertLeadInput,
  meta: AuditMeta = {},
): Promise<ConversionResultDto> {
  const parsed = convertLeadInputSchema.parse(input);
  const modules = await resolveConversionModules(principal);
  const { source, target, ledger, link } = modules;

  return writing(async () => {
    // ── the lead, through the same scope filter as every other read ──────
    const lead = await findRecordById({
      module: source.module,
      fields: source.metas,
      engine: source.engine,
      actor: principal.actor,
      id: parsed.leadId,
      client: tx,
    });
    if (!lead) throw notFound();

    // ── once, ever. The link column is unique; say so before the insert does ──
    const existing = await delegateOrThrow(tx, target).findFirst({
      where: { [link.column]: parsed.leadId },
      select: { id: true },
    });
    if (existing) {
      throw new ConfigError(
        'This lead has already been converted',
        409,
        'CONFLICT',
        { dealId: String(existing['id']) },
      );
    }

    // ── what the deal is made of ─────────────────────────────────────────
    const sourceShape = source.storage.shape;
    const targetShape = target.storage.shape;
    const closedByColumn = targetShape.closedByColumn;
    const ownerColumn = targetShape.ownerColumn;
    const statusColumn = targetShape.statusColumn;
    const accountColumn = targetShape.accountNumberColumn;
    if (!closedByColumn || !ownerColumn || !statusColumn || !accountColumn) {
      throw new ConfigError('The conversion target is missing a required column', 500, 'GUARDRAIL');
    }

    /**
     * CLOSED BY — IMMUTABLE.
     *
     * The lead's owner AT THIS MOMENT, and never anything else afterwards
     * (spec §7.1: "the telesales agent who owned the lead at conversion.
     * Immutable. Permanent credit — this is what performance reports count").
     * This is the only write to the column in the codebase. `updateRecord`
     * strips it from every update through `closedByColumn`, and
     * `transferDealOwnership` writes the owner column alone. If a report ever
     * disagrees with this value, the report is wrong.
     */
    const closedById = str(lead.raw[sourceShape.ownerColumn ?? '']);
    if (!closedById) {
      // Invariant 1 says this cannot happen; if it did, a deal with no credit
      // is worse than no deal.
      throw new ConfigError('The lead has no owner to credit the conversion to', 500, 'GUARDRAIL');
    }

    const language = sourceShape.languageColumn ? str(lead.raw[sourceShape.languageColumn]) : null;
    const handover = await resolveHandoverOwner(tx, { language });

    // The first live deal status by the Admin's order. The seeded deal
    // statuses carry NO system tag (New FTD is HOT, like Active), so there is
    // no tag to pick by; "first in order" is the same rule `createRecord`
    // opens every record with. A later slice may tag them — see the TODO in
    // ./deposit.ts — and this line then becomes a `pickStatusByTag`.
    const dealStatusId = await defaultStatusId(target.module.id);
    if (!dealStatusId) {
      throw new ConfigError('The deals module has no live status to open a deal in', 422, 'GUARDRAIL');
    }

    // Resolved BEFORE anything is written: a missing CONVERTED status must
    // fail the whole conversion, not leave a deal behind a lead still "open".
    const convertedStatus = await convertedStatusFor(tx, source);

    const data: Row = {
      [link.column]: parsed.leadId,
      [accountColumn]: parsed.arkAccountNo,
      [closedByColumn]: closedById,
      [ownerColumn]: handover.ownerId,
      [statusColumn]: dealStatusId,
      ...(targetShape.languageColumn && language ? { [targetShape.languageColumn]: language } : {}),
      ...carriedLinks(modules, lead.values),
      // The FTD snapshot lives on the deal (spec §8.1 "FTD Amount / FTD Date");
      // the ledger row itself is written by `recordDeposit` below.
      ...(parsed.deposit
        ? {
            [ledger.firstAmountColumn]: parsed.deposit.amount,
            [ledger.firstAtColumn]: parsed.deposit.depositedAt,
          }
        : {}),
    };

    const select = selectFor(target.storage, target.metas);
    const created = await delegateOrThrow(tx, target).create({ data, select });
    const dealId = String(created['id']);

    // ── the log: both records, same actor, same transaction ──────────────
    const logger = auditWithin(tx);
    const identity = actorIdentity(principal);
    const stamp = { ipAddress: meta.ipAddress ?? null, userAgent: meta.userAgent ?? null };

    const opening = target.storage.resolver.flatten(created);
    const snapshot: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, value] of Object.entries(auditValues(target.fields, opening))) {
      snapshot[key] = { from: null, to: value };
    }

    // ── the lead: account number filled, status to CONVERTED ─────────────
    const sourceAccountColumn = sourceShape.accountNumberColumn;
    const sourceStatusColumn = sourceShape.statusColumn;
    if (!sourceAccountColumn || !sourceStatusColumn) {
      throw new ConfigError('The conversion source is missing a required column', 500, 'GUARDRAIL');
    }
    const accountBefore = str(lead.raw[sourceAccountColumn]);
    const statusBefore = str(lead.raw[sourceStatusColumn]);

    await delegateOrThrow(tx, source).update({
      where: { id: parsed.leadId },
      data: { [sourceAccountColumn]: parsed.arkAccountNo, [sourceStatusColumn]: convertedStatus.id },
      select: { id: true },
    });

    const leadEntries: AuditEntry[] = [];
    if (accountBefore !== parsed.arkAccountNo) {
      const field = fieldForColumn(source.fields, sourceAccountColumn);
      leadEntries.push({
        entityType: sourceShape.entityType,
        entityId: parsed.leadId,
        action: 'FIELD_CHANGED',
        ...identity,
        changes: {
          [field?.key ?? sourceAccountColumn]: {
            from: field ? auditValue(field.type, accountBefore) : accountBefore,
            to: parsed.arkAccountNo,
          },
        },
        ...stamp,
      });
    }
    if (statusBefore !== convertedStatus.id) {
      leadEntries.push({
        entityType: sourceShape.entityType,
        entityId: parsed.leadId,
        action: 'STATUS_CHANGED',
        ...identity,
        changes: { [auditKey(source.fields, sourceStatusColumn)]: { from: statusBefore, to: convertedStatus.id } },
        ...stamp,
      });
    }
    leadEntries.push({
      entityType: sourceShape.entityType,
      entityId: parsed.leadId,
      action: 'CONVERTED',
      ...identity,
      changes: {
        [CONVERTED_DEAL_KEY]: { from: null, to: dealId },
        [WEBHOOK_EVENT_KEY]: { from: null, to: parsed.webhookEventId },
      },
      ...stamp,
    });
    await logger.logMany(leadEntries);

    // The deal's OWN entries are written AFTER the lead's closing ones on
    // purpose: the deal's timeline interleaves both histories by createdAt
    // (`getTimeline`), and `@default(now())` is stamped per write, so write
    // order IS display order. Lead-era rows must all precede the deal's first
    // row or the rendered history breaks into multiple "as a lead" eras
    // around the conversion instant instead of one unbroken hand-off.
    const createdEntry: AuditEntry = {
      entityType: targetShape.entityType,
      entityId: dealId,
      action: 'RECORD_CREATED',
      ...identity,
      changes: snapshot,
      ...stamp,
    };
    const assignedEntry: AuditEntry = {
      entityType: targetShape.entityType,
      entityId: dealId,
      action: 'ASSIGNED',
      ...identity,
      changes: {
        [auditKey(target.fields, ownerColumn)]: { from: null, to: handover.ownerId },
        [ASSIGNMENT_REASON_KEY]: { from: null, to: handover.reason },
      },
      ...stamp,
    };
    // Two writes, not one batch: a batch shares one timestamp and the
    // timeline's tie-break is the row id (a uuid — random), so "created then
    // assigned" would render in either order. Sequential writes get
    // sequential stamps.
    await logger.log(createdEntry);
    await logger.log(assignedEntry);

    // ── the FTD, as its own ledger row ───────────────────────────────────
    if (parsed.deposit) {
      await recordDeposit(
        principal,
        tx,
        {
          dealId,
          amount: parsed.deposit.amount,
          depositedAt: parsed.deposit.depositedAt,
          // The deposit's evidence is the conversion's event unless the
          // caller says the deposit came on a different one.
          webhookEventId: parsed.deposit.webhookEventId ?? parsed.webhookEventId,
          isFtd: true,
        },
        meta,
      );
    }

    return { dealId };
  });
}
