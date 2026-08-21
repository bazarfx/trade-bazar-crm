/**
 * The import consumer — where 40,000 rows actually become records.
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP: a row from a spreadsheet takes the
 * SAME path as a row typed into the create form. It calls `createRecord` /
 * `updateRecord` from `@crm/records` and it may never write a lead, a deal or
 * a generic record itself. That is not tidiness — it is what makes the five
 * invariants hold for imported data:
 *
 *   - validation is the module's generated schema, so the import cannot accept
 *     what the form rejects;
 *   - assignment runs per row, so an imported lead is routed by the same four
 *     tiers a campaign lead is and NOTHING IS EVER UNASSIGNED;
 *   - the audit rows (RECORD_CREATED, ASSIGNED, FIELD_CHANGED) are written in
 *     the same transaction as the write, so the timeline of an imported record
 *     reads exactly like any other;
 *   - duplicates are FLAGGED by the same scan (spec §6.6) — never blocked,
 *     never auto-merged, even when the user chose "Add new" for a file full of
 *     records that already exist.
 *
 * A second write path here would break all four quietly, and quietly is the
 * problem: nobody notices an unassigned lead until the month's numbers are
 * short.
 *
 * WHO IT RUNS AS. The job has no request, no cookie and no session, so it
 * builds a `Principal` from `ImportBatch.userId` and runs as the person who
 * uploaded the file. Their view scope decides which existing records a dedupe
 * lookup can even see, their field rules decide which columns can be written,
 * their permissions decide whether an owner may be named. An import is not a
 * way to write records you could not write by hand.
 *
 * ONE BAD ROW IS ONE BAD ROW. Every row is wrapped: a thrown error marks that
 * ROW failed with a message the user can act on and the run continues. A file
 * with twelve bad phone numbers imports 39,988 records, which is the honest
 * outcome — aborting the batch would throw away good work to punish a typo.
 */
import { Worker, type Job } from 'bullmq';
import { ZodError } from 'zod';
import { prisma, Prisma } from '@crm/db';
import {
  IMPORT_DEDUPE_NONE,
  IMPORT_QUEUE,
  coerceImportCell,
  importJobDataSchema,
  mappedColumns,
  normalisePhone,
  type FieldType,
  type ImportAction,
  type ImportAssignment,
  type ImportMapping,
} from '@crm/shared';
import {
  ConfigError,
  createRecord,
  listModuleRecords,
  loadPrincipal,
  storageFor,
  updateRecord,
  type Principal,
} from '@crm/records';
import { connection } from '../lib/redis.js';

/**
 * Rows claimed per pass.
 *
 * Small on purpose. Each row is its own transaction (the record engine's, not
 * ours), and the counters are written once per chunk — so this is the
 * granularity of the progress bar and of what a crash can lose, not a
 * throughput knob. A hundred rows is a second or two of work.
 */
const ROW_CHUNK = 100;

/** Failures quoted verbatim in the batch's summary. The full list lives on the
 *  rows themselves and is paginated by the errors endpoint. */
const ERROR_SAMPLE = 20;

/** Per-row error text cap. A Zod error over a 40-field module can run to
 *  kilobytes, and 40,000 of those is a table nobody can read. */
const ERROR_MAX_CHARS = 500;

// ── what one run needs ────────────────────────────────────────────────────

interface ImportField {
  key: string;
  label: string;
  type: FieldType;
  systemColumn: string | null;
  /** picklist values, plus the labels a human types into a spreadsheet */
  options: { value: string; label: string }[];
}

interface RunContext {
  batchId: string;
  moduleSlug: string;
  principal: Principal;
  mapping: ImportMapping;
  action: ImportAction;
  fieldsByKey: Map<string, ImportField>;
  /** the field an existing record is matched on, or null for "never match" */
  dedupeField: ImportField | null;
  /** set only when stage 5 named an owner; null means the rules decide */
  ownerFieldKey: string | null;
  ownerId: string | null;
}

interface RowOutcome {
  status: 'IMPORTED' | 'SKIPPED' | 'FAILED';
  recordId?: string;
  error?: string;
}

// ── error text ────────────────────────────────────────────────────────────

/**
 * Whatever went wrong, as one line a user can act on.
 *
 * The three shapes that reach here are the module's generated schema
 * (`ZodError`, naming the field), the engine's own refusals (`ConfigError` —
 * a status that does not belong to the module, an inactive owner) and
 * genuinely unexpected faults. All three become a message on the ROW, because
 * the error report is the only place the user will look.
 */
function describeError(err: unknown): string {
  let text: string;

  if (err instanceof ZodError) {
    text = err.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
  } else if (err instanceof ConfigError) {
    text = err.message;
  } else if (err instanceof Error) {
    text = err.message;
  } else {
    text = String(err);
  }

  return text.length > ERROR_MAX_CHARS ? `${text.slice(0, ERROR_MAX_CHARS - 1)}…` : text;
}

// ── one row → values ──────────────────────────────────────────────────────

/**
 * Apply the mapping to one raw row.
 *
 * Empty cells are OMITTED rather than written as null. On a create that lets
 * the field's configured default apply (and the required-field check at commit
 * already proved every required field is fed); on an update it means "this
 * column had nothing to say", not "erase what is there" — which is what
 * `updateRecord`'s partial schema expects.
 */
function buildValues(ctx: RunContext, raw: Record<string, unknown>): { values: Record<string, unknown>; errors: string[] } {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const column of mappedColumns(ctx.mapping)) {
    if (column.field === null) continue;
    const field = ctx.fieldsByKey.get(column.field);
    // Proved at commit; a field deleted since then fails the whole batch
    // before any row is processed, so this is belt and braces.
    if (!field) continue;

    const cell = raw[column.column];
    const text = cell === null || cell === undefined ? '' : String(cell);
    const source = text.trim() === '' ? (column.defaultValue ?? '') : text;
    if (source.trim() === '') continue;

    const decoded = coerceImportCell(field.type, source, field.options);
    if (!decoded.ok) {
      errors.push(`${field.label}: ${decoded.message}`);
      continue;
    }
    if (decoded.value !== null) values[field.key] = decoded.value;
  }

  return { values, errors };
}

// ── finding the record a row refers to ────────────────────────────────────

/**
 * The existing record this row matches, if any.
 *
 * Through `listModuleRecords`, which means through the repository's scope
 * filter: a user who cannot SEE a record cannot silently overwrite it from a
 * spreadsheet either. That is the whole reason the job runs as the importer.
 *
 * Two matches is not a match. There is no correct answer to which of them the
 * row meant, and picking one would overwrite real data on a coin toss — so the
 * row fails and says so, and the duplicate review queue (spec §6.6) is where
 * that pair gets resolved.
 */
async function findMatch(
  ctx: RunContext,
  field: ImportField,
  value: unknown,
): Promise<{ id: string } | 'none' | 'ambiguous'> {
  // Phone values are stored normalised — it is the matching key the webhook
  // and the duplicate scan use — so the probe has to be normalised too or a
  // file of "98765 43210" would match nothing it should.
  const probe = field.type === 'PHONE' ? normalisePhone(String(value)) : value;

  const { records, total } = await listModuleRecords(ctx.principal, ctx.moduleSlug, {
    filters: { fieldKey: field.key, fieldType: field.type, operator: 'eq', value: probe },
    take: 2,
  });

  if (total === 0 || records.length === 0) return 'none';
  if (total > 1) return 'ambiguous';
  const first = records[0];
  return first ? { id: first.id } : 'none';
}

// ── one row ───────────────────────────────────────────────────────────────

async function processRow(ctx: RunContext, raw: Record<string, unknown>): Promise<RowOutcome> {
  const { values, errors } = buildValues(ctx, raw);
  if (errors.length > 0) return { status: 'FAILED', error: errors.slice(0, 3).join(' · ') };

  // Stage 5, "Assign Owner": a named owner is written as a field value, so it
  // travels the record engine's ordinary owner path — permission-checked,
  // activity-checked and logged as an ASSIGNED entry with reason `manual`.
  // Applied to CREATES only: an update must not quietly take four thousand
  // records off the people currently working them.
  const forCreate = { ...values };
  if (ctx.ownerFieldKey !== null && ctx.ownerId !== null) forCreate[ctx.ownerFieldKey] = ctx.ownerId;

  const create = async (): Promise<RowOutcome> => {
    const record = await createRecord(ctx.principal, ctx.moduleSlug, forCreate);
    return { status: 'IMPORTED', recordId: record.id };
  };

  // No dedupe key: nothing can match, so every row is a create. `UPDATE_ONLY`
  // and `BOTH` are refused at commit in that state rather than run as no-ops.
  if (ctx.dedupeField === null) return create();

  const probe = values[ctx.dedupeField.key];
  if (probe === undefined || probe === null || probe === '') {
    // The row has no value in the match column. It cannot match anything, so
    // the action decides: create it, or skip it and say why.
    if (ctx.action === 'UPDATE_ONLY') {
      return { status: 'SKIPPED', error: `No value in "${ctx.dedupeField.label}" to match on` };
    }
    return create();
  }

  const match = await findMatch(ctx, ctx.dedupeField, probe);

  if (match === 'ambiguous') {
    return {
      status: 'FAILED',
      error: `More than one existing record matches "${ctx.dedupeField.label}" — resolve the duplicates first`,
    };
  }

  if (match === 'none') {
    if (ctx.action === 'UPDATE_ONLY') {
      return { status: 'SKIPPED', error: 'No matching record to update' };
    }
    return create();
  }

  // ADD_NEW imports a second record even though this one matched. Spec §6.6 is
  // explicit: duplicates are flagged, never blocked and never auto-merged —
  // and `createRecord`'s own scan is what raises the flag.
  if (ctx.action === 'ADD_NEW') return create();

  const record = await updateRecord(ctx.principal, ctx.moduleSlug, match.id, values);
  return { status: 'IMPORTED', recordId: record.id };
}

// ── the run ───────────────────────────────────────────────────────────────

/** Merge into whatever the batch already carries — staging may have recorded
 *  that the file was longer than a batch may hold, and overwriting that would
 *  erase the only trace of it. */
function mergeReport(existing: unknown, added: Record<string, unknown>): Prisma.InputJsonValue {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  return { ...(base as Record<string, unknown>), ...added } as Prisma.InputJsonValue;
}

/** Terminal failure of the BATCH — the file's module vanished, the importer
 *  was deactivated. Distinct from a row failing, and it does not retry:
 *  running the same job again would reach the same missing thing. */
async function failBatch(batchId: string, message: string): Promise<{ status: string; error: string }> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId }, select: { errorReport: true } });
  await prisma.importBatch.update({
    where: { id: batchId },
    data: {
      status: 'FAILED',
      finishedAt: new Date(),
      errorReport: mergeReport(batch?.errorReport, { error: message }),
    },
  });
  console.error(`[imports] batch ${batchId} failed: ${message}`);
  return { status: 'FAILED', error: message };
}

async function buildContext(batchId: string, assignment: ImportAssignment): Promise<RunContext | string> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) return 'That import no longer exists';

  const module = await prisma.moduleDefinition.findUnique({ where: { id: batch.moduleId } });
  if (!module || !module.isEnabled) return 'The module this file was imported into is no longer available';

  // The importer's own permissions, not a superuser's. Null means they were
  // deactivated between pressing Import and the worker picking the job up —
  // and a deactivated user's work does not get to run.
  const principal = await loadPrincipal(batch.userId);
  if (!principal) return 'The user who started this import is no longer active';

  const rows = await prisma.fieldDefinition.findMany({
    where: { moduleId: module.id, isDeleted: false },
    include: { options: { where: { isDeleted: false }, orderBy: { displayOrder: 'asc' } } },
  });

  const storage = storageFor(
    { id: module.id, slug: module.slug, isCore: module.isCore },
    rows.map((f) => ({ key: f.key, type: f.type, systemColumn: f.systemColumn })),
  );
  const shape = storage.shape;

  /**
   * Statuses are a picklist whose values live in their own table, so a cell
   * saying "Contacted" has to resolve to a Status id. Resolving a value the
   * USER typed is a lookup, not system behaviour keyed on a name — what the
   * record stores is the id, and nothing in this file branches on what a
   * status is called.
   */
  const statusOptions =
    shape.statusColumn === null
      ? []
      : (await prisma.status.findMany({
          where: { moduleId: module.id, isDeleted: false },
          orderBy: { displayOrder: 'asc' },
          select: { id: true, name: true },
        })).map((s) => ({ value: s.id, label: s.name }));

  const fields: ImportField[] = rows.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    systemColumn: f.systemColumn,
    options:
      f.systemColumn !== null && f.systemColumn === shape.statusColumn
        ? statusOptions
        : f.options.map((o) => ({ value: o.value, label: o.label })),
  }));
  const fieldsByKey = new Map(fields.map((f) => [f.key, f]));

  const mapping = {
    columns: Array.isArray((batch.mapping as { columns?: unknown })?.columns)
      ? ((batch.mapping as { columns: ImportMapping['columns'] }).columns)
      : [],
  };

  // A field deleted between commit and run would otherwise be dropped from
  // every row silently — 40,000 records missing a column nobody notices until
  // someone tries to call one of them.
  for (const column of mappedColumns(mapping)) {
    if (column.field !== null && !fieldsByKey.has(column.field)) {
      return `The field "${column.field}" was deleted after this import was submitted`;
    }
  }

  const dedupeField =
    batch.dedupeKey === IMPORT_DEDUPE_NONE ? null : (fieldsByKey.get(batch.dedupeKey) ?? null);
  if (batch.dedupeKey !== IMPORT_DEDUPE_NONE && dedupeField === null) {
    return `The field this import matches on ("${batch.dedupeKey}") no longer exists`;
  }

  let ownerFieldKey: string | null = null;
  if (assignment.mode === 'OWNER') {
    const ownerField = fields.find((f) => f.systemColumn !== null && f.systemColumn === shape.ownerColumn);
    if (!ownerField) return 'This module has no Owner field to assign imported records through';
    ownerFieldKey = ownerField.key;
  }

  return {
    batchId,
    moduleSlug: module.slug,
    principal,
    mapping,
    action: batch.action as ImportAction,
    fieldsByKey,
    dedupeField,
    ownerFieldKey,
    ownerId: assignment.mode === 'OWNER' ? assignment.ownerId : null,
  };
}

interface RunSummary {
  status: string;
  succeeded?: number;
  failed?: number;
  skipped?: number;
  error?: string;
}

async function processImportBatch(job: Job): Promise<RunSummary> {
  const { batchId, assignment } = importJobDataSchema.parse(job.data);

  /**
   * Claim the batch.
   *
   * A conditional update rather than a read-then-write: two workers reaching
   * the same batch would otherwise both see PENDING and both start. Finding it
   * already RUNNING means a previous ATTEMPT of this job died mid-file (BullMQ
   * keeps one active job per id), and resuming is safe because every row that
   * was decided is already out of PENDING and cannot be touched twice.
   */
  const claimed = await prisma.importBatch.updateMany({
    where: { id: batchId, status: 'PENDING' },
    data: { status: 'RUNNING', startedAt: new Date() },
  });

  if (claimed.count === 0) {
    const current = await prisma.importBatch.findUnique({
      where: { id: batchId },
      select: { status: true },
    });
    if (!current) return { status: 'MISSING' };
    if (current.status !== 'RUNNING') {
      // Already finished, or cancelled. A duplicate job is a no-op, never a
      // second pass over the same file.
      return { status: current.status };
    }
    console.warn(`[imports] resuming batch ${batchId} after an interrupted run`);
  }

  const ctx = await buildContext(batchId, assignment);
  if (typeof ctx === 'string') return failBatch(batchId, ctx);

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const sample: { rowNumber: number; error: string }[] = [];

  /**
   * A cursor, not just a `status: PENDING` filter.
   *
   * The filter alone would loop forever on a row whose own status update
   * failed. Advancing past every row we have LOOKED at guarantees the run
   * terminates; a retry starts from zero again and picks up anything still
   * PENDING, so nothing is lost by moving on.
   */
  let cursor = 0;

  for (;;) {
    const rows = await prisma.importRow.findMany({
      where: { batchId, status: 'PENDING', rowNumber: { gt: cursor } },
      orderBy: { rowNumber: 'asc' },
      take: ROW_CHUNK,
      select: { id: true, rowNumber: true, raw: true },
    });
    if (rows.length === 0) break;

    const last = rows[rows.length - 1];
    if (last) cursor = last.rowNumber;

    let chunkSucceeded = 0;
    let chunkFailed = 0;

    for (const row of rows) {
      let outcome: RowOutcome;
      try {
        const raw = row.raw && typeof row.raw === 'object' ? (row.raw as Record<string, unknown>) : {};
        outcome = await processRow(ctx, raw);
      } catch (err) {
        // The wrap that keeps invariant "one bad row is one bad row": anything
        // the engine throws — a failed validation, a status that does not
        // belong to the module, a deactivated owner — lands on THIS row.
        outcome = { status: 'FAILED', error: describeError(err) };
      }

      try {
        await prisma.importRow.update({
          where: { id: row.id },
          data: {
            status: outcome.status,
            error: outcome.error ?? null,
            recordId: outcome.recordId ?? null,
          },
        });
      } catch (err) {
        // The record may well have been written; only the bookkeeping failed.
        // Leaving the row PENDING and moving on is the safer of two bad
        // options — the cursor means this run will not retry it, and a manual
        // re-run would flag any second copy as a duplicate rather than merge it.
        console.error(`[imports] row ${row.rowNumber} of ${batchId}: status not recorded`, err);
      }

      if (outcome.status === 'IMPORTED') chunkSucceeded += 1;
      else if (outcome.status === 'FAILED') {
        chunkFailed += 1;
        if (sample.length < ERROR_SAMPLE) {
          sample.push({ rowNumber: row.rowNumber, error: outcome.error ?? 'Unknown error' });
        }
      } else skipped += 1;
    }

    succeeded += chunkSucceeded;
    failed += chunkFailed;

    // Counters written per chunk so the wizard's progress bar is live rather
    // than jumping from 0 to done. Incremented, not set, so a resumed run adds
    // to what the interrupted one had already counted.
    if (chunkSucceeded > 0 || chunkFailed > 0) {
      await prisma.importBatch.update({
        where: { id: batchId },
        data: {
          succeeded: { increment: chunkSucceeded },
          failed: { increment: chunkFailed },
        },
      });
    }
  }

  const existing = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { errorReport: true },
  });

  /**
   * COMPLETED even with failed rows.
   *
   * A 40,000-row import with twelve bad phone numbers imported 39,988 records,
   * and calling that FAILED would be a lie that hides the 39,988. `failed` is
   * the number that says otherwise, and the errors endpoint lists every one.
   * FAILED stays reserved for a failure of the BATCH.
   *
   * Skipped rows are neither: they are `UPDATE_ONLY` finding nothing to
   * update, which is a correct outcome. `total - succeeded - failed` is the
   * count, which is why it needs no column of its own.
   */
  await prisma.importBatch.update({
    where: { id: batchId },
    data: {
      status: 'COMPLETED',
      finishedAt: new Date(),
      errorReport: mergeReport(existing?.errorReport, {
        failed,
        skipped,
        ...(sample.length > 0 ? { sample } : {}),
      }),
    },
  });

  console.log(`[imports] batch ${batchId}: ${succeeded} imported, ${skipped} skipped, ${failed} failed`);
  return { status: 'COMPLETED', succeeded, failed, skipped };
}

export function startImportsWorker(): Worker {
  const worker = new Worker(IMPORT_QUEUE, processImportBatch, {
    connection,
    // One batch at a time per worker process. Each row is already a
    // transaction with an assignment inside it, and the round-robin counter
    // that assignment reads is the one thing in the system that does not want
    // to be raced by four concurrent files.
    concurrency: 1,
  });

  worker.on('failed', (job, err) => {
    console.error(`[imports] job ${job?.id ?? 'unknown'} failed:`, err.message);
  });

  return worker;
}
