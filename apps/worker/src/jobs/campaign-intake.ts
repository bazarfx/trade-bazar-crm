/**
 * The campaign-intake consumer — where a stored webhook payload becomes a
 * record, or a FAILED event that says why.
 *
 * THE ONE RULE THIS FILE KEEPS, same as the import job: a lead posted by a
 * campaign platform takes the SAME path as a lead typed into the create form.
 * It calls `createRecord` from `@crm/records` and may never write a lead, a
 * campaign or a generic record itself. That is what makes the invariants hold
 * for intake data without anyone remembering them here:
 *
 *   - validation is the module's generated schema, so intake cannot accept
 *     what the form rejects;
 *   - assignment runs inside the create, so an intake lead is routed by the
 *     same four tiers and NOTHING IS EVER UNASSIGNED;
 *   - RECORD_CREATED, ASSIGNED and DUPLICATE_FLAGGED are written in the same
 *     transaction as the row, stamped `SYSTEM_CAMPAIGN_INTAKE` with no
 *     fabricated person, so the timeline reads "System (Campaign Intake)";
 *   - duplicates are FLAGGED by the engine's own scan (spec §6.6) — never
 *     blocked, never auto-merged, and never re-implemented here.
 *
 * WHO IT RUNS AS. There is no human in the loop, so it runs as
 * `systemPrincipal('SYSTEM_CAMPAIGN_INTAKE')`: platform-wide scope (the
 * duplicate scan must see every record; the rota may hand the lead to
 * anyone), a NULL `createdBy`, and a system identity on every audit row.
 *
 * THE SPACE. Nothing in this file knows what an Integrately payload looks
 * like — the account does not exist and no real payload has been seen. The
 * shape lives in `WebhookSource.fieldMapping`, edited by the Admin; this job
 * only EXECUTES that mapping over the stored body. A source with no mapping
 * yet produces a FAILED event saying exactly that, and replay re-runs it the
 * day the mapping exists. No field name is guessed here, and none may be.
 *
 * ONE ATTEMPT. Every outcome is written onto the event row, and a payload the
 * mapping cannot digest is the same payload on the fifth retry — see the
 * queue options in `apps/web/src/lib/intake/queue.ts`. Replay is the retry.
 */
import { Worker, type Job } from 'bullmq';
import { ZodError } from 'zod';
import { prisma } from '@crm/db';
import {
  CAMPAIGN_INTAKE_QUEUE,
  campaignIntakeJobSchema,
  normalisePhone,
  parseIntakeDefaults,
  parseIntakeMapping,
  resolveDotPath,
  type FieldType,
  type IntakeMapping,
  type IntakeTransform,
} from '@crm/shared';
import {
  ConfigError,
  createRecord,
  listModuleRecords,
  storageFor,
  systemPrincipal,
  type Principal,
} from '@crm/records';
import { connection } from '../lib/redis.js';

/**
 * The Source stamp an intake record carries when its module has a source
 * column and the mapping did not set one.
 *
 * Read as an OPAQUE MARKER, exactly as `routeFor` in the assignment engine
 * reads `ARK_TERMINAL`: `LeadSource` is a database enum (spec §6.1, "a
 * permanent, immutable Source stamp"), not an Admin-editable picklist, and
 * every lead arriving through this pipeline is by definition a campaign lead.
 * Nothing else in this file names a field, a status or an option.
 */
const CAMPAIGN_SOURCE_STAMP = 'CAMPAIGN';

/** The honest state while Integrately is unknown — quoted by the events
 *  screen, so it has to tell the Admin what to do next. */
const NO_MAPPING_ERROR = 'No payload mapping configured for this source yet';

/** Event-row error cap: a Zod error over a 40-field module runs to
 *  kilobytes, and the events screen shows the first line. */
const ERROR_MAX_CHARS = 1000;

// ── what one run needs ────────────────────────────────────────────────────

interface IntakeField {
  key: string;
  type: FieldType;
  systemColumn: string | null;
  relatedModuleId: string | null;
}

interface RunContext {
  eventId: string;
  principal: Principal;
  module: { id: string; slug: string; isCore: boolean };
  fields: IntakeField[];
  mapping: IntakeMapping;
  defaults: Record<string, unknown>;
  raw: unknown;
}

type Outcome =
  | { status: 'PROCESSED'; recordId: string }
  | { status: 'FAILED' | 'IGNORED'; error: string };

// ── error text ────────────────────────────────────────────────────────────

/** Whatever went wrong, as one line the Admin can act on from the events
 *  screen: the generated schema names the field, the engine names its
 *  refusal, anything else is quoted as it came. */
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

// ── the mapping, executed ─────────────────────────────────────────────────

function applyTransform(value: unknown, transform: IntakeTransform): unknown {
  switch (transform) {
    case 'trim':
      return typeof value === 'string' ? value.trim() : value;
    case 'phone':
      // The engine normalises PHONE-typed fields itself; this transform exists
      // for a phone arriving in a field of another type, or as a number.
      return typeof value === 'string' || typeof value === 'number'
        ? normalisePhone(String(value))
        : value;
    case 'none':
      return value;
    default: {
      const _exhaustive: never = transform;
      return value;
    }
  }
}

/**
 * Payload → field-keyed values.
 *
 * A path that resolves to nothing is OMITTED, not written as null: on a
 * create that lets the field's configured default apply, and a required field
 * left empty then fails the schema with its own name — which is the message
 * the Admin needs ("phone: Required"), not a type error about null. Source
 * defaults fill what the payload did not, and the Source stamp fills the one
 * column no platform will ever send.
 */
function buildValues(ctx: RunContext): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const rule of ctx.mapping.rules) {
    const found = resolveDotPath(ctx.raw, rule.source);
    if (found === undefined || found === null) continue;
    const value = applyTransform(found, rule.transform);
    if (value === '' || value === undefined || value === null) continue;
    values[rule.target] = value;
  }

  for (const [key, value] of Object.entries(ctx.defaults)) {
    if (values[key] === undefined && value !== null && value !== undefined) values[key] = value;
  }

  const storage = storageFor(
    ctx.module,
    ctx.fields.map((f) => ({ key: f.key, type: f.type, systemColumn: f.systemColumn })),
  );
  const sourceColumn = storage.shape.sourceColumn;
  const sourceField = sourceColumn === null ? null : ctx.fields.find((f) => f.systemColumn === sourceColumn);
  if (sourceField && values[sourceField.key] === undefined) {
    values[sourceField.key] = CAMPAIGN_SOURCE_STAMP;
  }

  return values;
}

// ── the campaign link (spec §6.1, §9) ─────────────────────────────────────

/**
 * Which RECORD_LINK field on the source's module carries the campaign.
 *
 * The Admin's override wins; otherwise the module's single link field that
 * points at another module is it. Two or more without an override is a
 * question only the Admin can answer, so it is an error that names the fix
 * rather than a guess. Nothing here names the campaigns module: the TARGET
 * is whatever module the link field points at (`relatedModuleId`), which is
 * how a module an Admin invents next year links to a "Sources" module of
 * their own design.
 */
function campaignLinkField(ctx: RunContext): { field: IntakeField; targetModuleId: string } | string {
  const override = ctx.mapping.campaignLinkField;
  if (override !== undefined) {
    const field = ctx.fields.find((f) => f.key === override);
    if (!field) return `The campaign link field "${override}" does not exist on this module`;
    if (field.type !== 'RECORD_LINK' || field.relatedModuleId === null) {
      return `The campaign link field "${override}" is not a record link to another module`;
    }
    return { field, targetModuleId: field.relatedModuleId };
  }

  const candidates = ctx.fields.filter((f) => f.type === 'RECORD_LINK' && f.relatedModuleId !== null);
  const only = candidates[0];
  if (candidates.length !== 1 || !only || only.relatedModuleId === null) {
    return candidates.length === 0
      ? 'A campaign name was mapped, but this module has no record-link field to hold the campaign'
      : `This module has ${candidates.length} record-link fields — set "campaignLinkField" in the mapping to say which carries the campaign`;
  }
  return { field: only, targetModuleId: only.relatedModuleId };
}

/**
 * Find-or-create the campaign the payload names, THROUGH the record engine,
 * as the same system actor — so a campaign that appears for the first time
 * gets its own RECORD_CREATED entry from "System (Campaign Intake)" and
 * every guardrail the campaigns module has.
 *
 * Matched on the target module's title field (`recordTitleField`) with the
 * engine's own filter, never by a hand-written query: which table a campaign
 * lives in is `StorageResolver`'s business.
 *
 * `link` is null when the payload names no campaign — not an error, the link
 * is optional — and otherwise the field to write and the id to write there.
 */
type CampaignLink =
  | { ok: true; link: { fieldKey: string; id: string } | null }
  | { ok: false; error: string };

async function resolveCampaign(ctx: RunContext): Promise<CampaignLink> {
  const path = ctx.mapping.campaignNameSource;
  if (path === undefined) return { ok: true, link: null };

  const found = resolveDotPath(ctx.raw, path);
  const name = typeof found === 'string' ? found.trim() : typeof found === 'number' ? String(found) : '';
  if (name === '') return { ok: true, link: null };

  const link = campaignLinkField(ctx);
  if (typeof link === 'string') return { ok: false, error: link };

  const target = await prisma.moduleDefinition.findUnique({
    where: { id: link.targetModuleId },
    select: { id: true, slug: true, isEnabled: true, recordTitleField: true },
  });
  if (!target || !target.isEnabled) {
    return { ok: false, error: 'The module the campaign link points at is not available' };
  }

  const titleField = await prisma.fieldDefinition.findFirst({
    where: { moduleId: target.id, key: target.recordTitleField, isDeleted: false },
    select: { key: true, type: true },
  });
  if (!titleField) {
    return { ok: false, error: `The "${target.slug}" module has no live title field to match campaigns on` };
  }

  const existing = await listModuleRecords(ctx.principal, target.slug, {
    filters: { fieldKey: titleField.key, fieldType: titleField.type, operator: 'eq', value: name },
    take: 1,
  });
  const match = existing.records[0];
  if (match) return { ok: true, link: { fieldKey: link.field.key, id: match.id } };

  // Only the name is known from a payload; everything else on the campaign
  // (platform, details) comes from the module's configured defaults and is
  // the Admin's to fill in afterwards.
  const created = await createRecord(ctx.principal, target.slug, { [titleField.key]: name });
  return { ok: true, link: { fieldKey: link.field.key, id: created.id } };
}

// ── one event ─────────────────────────────────────────────────────────────

async function processEvent(ctx: RunContext): Promise<Outcome> {
  const values = buildValues(ctx);

  const campaign = await resolveCampaign(ctx);
  if (!campaign.ok) return { status: 'FAILED', error: campaign.error };
  if (campaign.link !== null) values[campaign.link.fieldKey] = campaign.link.id;

  const record = await createRecord(ctx.principal, ctx.module.slug, values);
  return { status: 'PROCESSED', recordId: record.id };
}

async function buildContext(eventId: string): Promise<RunContext | Outcome | null> {
  const event = await prisma.webhookEvent.findUnique({
    where: { id: eventId },
    include: { source: { include: { module: true } } },
  });
  if (!event) return null;

  // Idempotent: a job that somehow runs twice must not create twice. Every
  // other status — RECEIVED, REPLAYED, and FAILED from a queue outage — is
  // work to do.
  if (event.status === 'PROCESSED') return null;

  if (!event.source) {
    return { status: 'IGNORED', error: 'The source this event arrived on no longer exists' };
  }
  if (!event.source.isActive) {
    return { status: 'IGNORED', error: 'This source is paused — resume it and replay the event' };
  }
  if (!event.source.module.isEnabled) {
    return { status: 'FAILED', error: 'The module this source feeds is disabled' };
  }

  const mapping = parseIntakeMapping(event.source.fieldMapping);
  if (mapping === null) return { status: 'FAILED', error: NO_MAPPING_ERROR };

  const fields = await prisma.fieldDefinition.findMany({
    where: { moduleId: event.source.moduleId, isDeleted: false },
    select: { key: true, type: true, systemColumn: true, relatedModuleId: true },
  });

  return {
    eventId,
    principal: systemPrincipal('SYSTEM_CAMPAIGN_INTAKE'),
    module: {
      id: event.source.module.id,
      slug: event.source.module.slug,
      isCore: event.source.module.isCore,
    },
    fields,
    mapping,
    defaults: parseIntakeDefaults(event.source.defaultValues),
    raw: event.raw,
  };
}

async function settle(eventId: string, outcome: Outcome): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id: eventId },
    data: {
      status: outcome.status,
      error: outcome.status === 'PROCESSED' ? null : outcome.error,
      leadId: outcome.status === 'PROCESSED' ? outcome.recordId : null,
      processedAt: new Date(),
    },
    select: { id: true },
  });
}

async function processIntakeJob(job: Job): Promise<{ status: string; recordId?: string; error?: string }> {
  const { eventId } = campaignIntakeJobSchema.parse(job.data);

  const ctx = await buildContext(eventId);
  if (ctx === null) return { status: 'SKIPPED' };

  let outcome: Outcome;
  if ('status' in ctx) {
    outcome = ctx;
  } else {
    try {
      outcome = await processEvent(ctx);
    } catch (err) {
      // The wrap that keeps this job out of retry loops: a failed validation,
      // a status that does not belong to the module, a database that blinked
      // — all land on the EVENT with a message, where replay can reach them.
      outcome = { status: 'FAILED', error: describeError(err) };
    }
  }

  await settle(eventId, outcome);

  if (outcome.status === 'PROCESSED') {
    console.log(`[intake] event ${eventId}: record ${outcome.recordId}`);
    return { status: outcome.status, recordId: outcome.recordId };
  }
  console.warn(`[intake] event ${eventId}: ${outcome.status} — ${outcome.error}`);
  return { status: outcome.status, error: outcome.error };
}

export function startCampaignIntakeWorker(): Worker {
  const worker = new Worker(CAMPAIGN_INTAKE_QUEUE, processIntakeJob, {
    connection,
    // One event at a time. Each create holds the round-robin's row lock
    // until it commits, so parallel consumers would only queue on the rota
    // — and a find-or-create of the same campaign from two concurrent
    // events would race into two campaigns.
    concurrency: 1,
  });

  worker.on('failed', (job, err) => {
    // Only reachable when `processIntakeJob` itself threw — a job with
    // malformed data, or the settle write failing. The event row, if any,
    // still holds whatever status it had, and replay can reach it.
    console.error(`[intake] job ${job?.id ?? 'unknown'} failed:`, err.message);
  });

  return worker;
}
