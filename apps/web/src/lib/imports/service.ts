/**
 * The import wizard's server side, minus the row processing.
 *
 * WHAT LIVES HERE AND WHY. The route handlers under
 * `app/api/modules/[slug]/imports` are thin adapters — they read a multipart
 * body or a JSON body and call one function in this file. Every rule an import
 * obeys is in here or in the worker, never in a route, because a route can be
 * forgotten and a second one can be written next year by somebody who has not
 * read this comment.
 *
 * THE PERMISSION MODEL, twice over:
 *
 *  1. `IMPORT_EXPORT` decides whether you may import AT ALL. Asserted in this
 *     file rather than in each route, so no endpoint can be added without it.
 *  2. Everything after that is the ordinary record permission model. The
 *     import is not a side door: the module read gate applies, a batch is
 *     visible only to the user who staged it (or an Admin), and the rows
 *     themselves are written by the worker through `createRecord` as the
 *     importing user, so their view scope, their field rules and their
 *     assignment permission all apply exactly as they would in the create
 *     form. An import that ran as a superuser would be a way to write records
 *     a user cannot see and hand them owners they cannot choose.
 *
 * WHAT IS VALIDATED WHERE. The commit is the last moment a human is watching,
 * so everything that would fail identically on all 40,000 rows is checked
 * THERE and reported as one clear 422: a required field nothing feeds, a
 * mapping pointing at a deleted field, a dedupe key on a field that cannot be
 * matched, an owner the importer may not assign to. What is left for the
 * worker is only what genuinely varies per row — the values.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import { PermissionEngine, type FieldMeta } from '@crm/core';
import {
  FIELD_TYPE_SPECS,
  IMPORT_DEDUPE_NONE,
  mappedColumns,
  type ImportAction,
  type ImportCommitInput,
  type ImportCreateInput,
  type ImportMapping,
  type ImportPatchInput,
  type ImportStatus,
} from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { ConfigError, requireModule } from '@/lib/config/service';
import { assertModuleReadAccess } from '@/lib/config/access';
import { storageFor } from '@/lib/records/list';
import { autoMap, isImportableType, type AutoMapField } from './automap';
import { assertUploadSize, parseImportFile } from './parse';
import { enqueueImport } from './queue';

/** Rows shown back to the user as the decoded preview in stage 1. Ten is what
 *  the design's file panel has room for, and the point is to catch a wrong
 *  charset by eye before 40,000 mangled names are written. */
const SAMPLE_ROWS = 10;

/** Rows per `createMany`. Postgres takes one parameter per column per row, so
 *  a single 100k-row insert would blow the 65,535-parameter limit long before
 *  it blew memory. */
const STAGE_CHUNK = 1_000;

const ERRORS_PAGE_SIZE = 50;
const ERRORS_MAX_PAGE_SIZE = 200;
const RECENT_BATCHES = 20;

// ── outbound shapes ───────────────────────────────────────────────────────

export interface ImportBatchDto {
  id: string;
  moduleSlug: string;
  filename: string;
  charset: string;
  headers: string[];
  mapping: ImportMapping;
  action: ImportAction;
  dedupeKey: string;
  total: number;
  succeeded: number;
  failed: number;
  status: ImportStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface StagedImport {
  batch: ImportBatchDto;
  headers: string[];
  sample: Record<string, string>[];
  suggestedMapping: ImportMapping;
  unmappedColumns: string[];
  unmappedFields: { key: string; label: string; isRequired: boolean }[];
  /** the file held more rows than a batch may stage; the tail was dropped */
  truncated: boolean;
  fileRows: number;
}

export interface ImportProgress {
  id: string;
  status: ImportStatus;
  total: number;
  succeeded: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ImportRowError {
  rowNumber: number;
  error: string;
  raw: Record<string, string>;
}

// ── plumbing ──────────────────────────────────────────────────────────────

type BatchRow = Awaited<ReturnType<typeof prisma.importBatch.findFirst>>;

const engineFor = (principal: Principal): PermissionEngine =>
  new PermissionEngine(principal.actor, principal.permissions);

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function asMapping(raw: unknown): ImportMapping {
  // Stored JSON, written by this file through the schema. Read back
  // structurally rather than re-parsed: a mapping that referenced a field an
  // Admin has since deleted must still be READABLE, so the wizard can show the
  // user which column lost its target instead of 500ing on the way to saying so.
  const columns = (raw as { columns?: unknown })?.columns;
  return { columns: Array.isArray(columns) ? (columns as ImportMapping['columns']) : [] };
}

function toDto(batch: NonNullable<BatchRow>, moduleSlug: string): ImportBatchDto {
  return {
    id: batch.id,
    moduleSlug,
    filename: batch.filename,
    charset: batch.charset,
    headers: Array.isArray(batch.headers) ? (batch.headers as string[]) : [],
    mapping: asMapping(batch.mapping),
    action: batch.action as ImportAction,
    dedupeKey: batch.dedupeKey,
    total: batch.total,
    succeeded: batch.succeeded,
    failed: batch.failed,
    status: batch.status as ImportStatus,
    createdAt: batch.createdAt.toISOString(),
    startedAt: iso(batch.startedAt),
    finishedAt: iso(batch.finishedAt),
  };
}

const progressOf = (batch: NonNullable<BatchRow>): ImportProgress => ({
  id: batch.id,
  status: batch.status as ImportStatus,
  total: batch.total,
  succeeded: batch.succeeded,
  failed: batch.failed,
  startedAt: iso(batch.startedAt),
  finishedAt: iso(batch.finishedAt),
});

/**
 * The gate on every endpoint in this slice.
 *
 * `hasSpecial` is true for Admin by construction, so this reads as "the
 * Import / Export special, or Admin" without naming the Admin role.
 */
export function assertImportAccess(principal: Principal): void {
  if (!engineFor(principal).hasSpecial('IMPORT_EXPORT')) {
    throw new ConfigError('You do not have permission to import records', 403, 'FORBIDDEN');
  }
}

/** A field as the import needs it: enough to map, to coerce and to validate. */
interface ImportField extends AutoMapField {
  systemColumn: string | null;
  hasDefault: boolean;
}

/**
 * The fields this ACTOR may import into.
 *
 * Hidden and read-only fields are dropped here rather than rejected later:
 * `writableFields` in the record engine strips them from the write, so a
 * mapping that pointed at one would be accepted by the wizard, run without
 * error, and quietly import nothing into that column. Not offering it is the
 * only honest option.
 */
async function importFields(
  principal: Principal,
  moduleId: string,
  moduleSlug: string,
): Promise<ImportField[]> {
  const engine = engineFor(principal);
  const hidden = engine.hiddenFields(moduleSlug);
  const readonly = engine.readonlyFields(moduleSlug);

  const fields = await prisma.fieldDefinition.findMany({
    where: { moduleId, isDeleted: false },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
  });

  return fields
    .filter((f) => !hidden.has(f.key) && !readonly.has(f.key))
    .map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      isRequired: f.isRequired,
      systemColumn: f.systemColumn,
      hasDefault: f.defaultValue !== null && f.defaultValue !== undefined,
    }));
}

const metasOf = (fields: ImportField[]): FieldMeta[] =>
  fields.map((f) => ({ key: f.key, type: f.type, systemColumn: f.systemColumn }));

/**
 * Load a batch the way the repository loads a record: scoped, and 404 when it
 * is out of scope.
 *
 * A batch holds a verbatim copy of somebody's spreadsheet — names, phone
 * numbers, whatever else was in it — so it is record data and fails closed the
 * same way. Your own batches, or all of them if you are an Admin.
 */
async function loadBatch(principal: Principal, moduleSlug: string, batchId: string) {
  const batch = await prisma.importBatch.findFirst({
    where: {
      id: batchId,
      module: { slug: moduleSlug },
      ...(principal.actor.isAdmin ? {} : { userId: principal.user.id }),
    },
  });
  if (!batch) throw new ConfigError('Import not found', 404, 'NOT_FOUND');
  return batch;
}

/** Only a batch that has not been handed to the worker can still be edited.
 *  After that the mapping is history: it is what the rows were imported WITH,
 *  and the error report is read against it. */
function assertEditable(batch: NonNullable<BatchRow>): void {
  if (batch.status !== 'PENDING') {
    throw new ConfigError('This import has already been submitted', 409, 'CONFLICT');
  }
}

// ── mapping validation, shared by PATCH and commit ────────────────────────

/**
 * Everything about a mapping that can be decided without reading a row.
 *
 * Deliberately strict about columns that are not in the file: a preset saved
 * from last month's export and replayed against a file with different headings
 * would otherwise map half the columns and silently drop the rest.
 */
function validateMapping(mapping: ImportMapping, headers: string[], fields: ImportField[]): void {
  const known = new Set(headers);
  const byKey = new Map(fields.map((f) => [f.key, f]));

  for (const column of mapping.columns) {
    if (!known.has(column.column)) {
      throw new ConfigError(
        `The mapping refers to a column "${column.column}" that is not in this file`,
        422,
        'VALIDATION',
      );
    }
    if (column.skip || column.field === null) continue;

    const field = byKey.get(column.field);
    if (!field) {
      throw new ConfigError(
        `"${column.column}" is mapped to a field that no longer exists on this module`,
        422,
        'VALIDATION',
      );
    }
    if (!isImportableType(field.type)) {
      throw new ConfigError(
        `"${field.label}" is ${FIELD_TYPE_SPECS[field.type].label} and cannot be filled from a file`,
        422,
        'VALIDATION',
      );
    }
  }
}

/**
 * Required fields nothing feeds.
 *
 * Three ways a required field is satisfied, and only three: a column is mapped
 * to it, that column carries a default for its empty cells, or the field
 * itself has a configured default the record engine applies. Anything else
 * would fail on EVERY row, which is a 422 for the person still watching rather
 * than 40,000 identical lines in an error report.
 *
 * Owner, group and status are excluded because the engine fills them itself —
 * assignment picks an owner (invariant 1: nothing is ever unassigned) and the
 * module's first live status is the default. Demanding a column for them would
 * make every import impossible.
 */
function assertRequiredCovered(
  mapping: ImportMapping,
  fields: ImportField[],
  engineFilled: ReadonlySet<string>,
): void {
  const fed = new Set<string>();
  for (const column of mappedColumns(mapping)) if (column.field) fed.add(column.field);

  const missing = fields.filter(
    (f) =>
      f.isRequired &&
      isImportableType(f.type) &&
      !fed.has(f.key) &&
      !f.hasDefault &&
      !(f.systemColumn !== null && engineFilled.has(f.systemColumn)),
  );

  if (missing.length > 0) {
    throw new ConfigError(
      `These fields are required and no column feeds them: ${missing.map((f) => f.label).join(', ')}`,
      422,
      'VALIDATION',
      { fields: { mapping: missing.map((f) => f.label) } },
    );
  }
}

// ── stage 1–3: upload and stage ───────────────────────────────────────────

export async function stageImport(
  principal: Principal,
  moduleSlug: string,
  input: ImportCreateInput & { file: File },
): Promise<StagedImport> {
  assertImportAccess(principal);
  assertModuleReadAccess(principal, moduleSlug);

  // Checked against the declared size BEFORE `arrayBuffer()` copies the upload
  // into the heap — a 200 MB file should cost one comparison, not 200 MB.
  assertUploadSize(input.file.size);
  const module = await requireModule(moduleSlug);

  const parsed = await parseImportFile({
    filename: input.filename,
    bytes: await input.file.arrayBuffer(),
    charset: input.charset,
  });

  const fields = await importFields(principal, module.id, moduleSlug);
  const suggestion = autoMap(parsed.headers, fields);

  const batch = await prisma.importBatch.create({
    data: {
      userId: principal.user.id,
      moduleId: module.id,
      filename: input.filename,
      // What the bytes were ACTUALLY decoded with, which a BOM may have
      // overridden — the batch has to be able to reproduce its own rows.
      charset: parsed.charset,
      headers: parsed.headers,
      mapping: suggestion.mapping as unknown as Prisma.InputJsonValue,
      action: input.action,
      dedupeKey: input.dedupeKey,
      total: parsed.rows.length,
      status: 'PENDING',
      ...(parsed.truncated
        ? {
            // Recorded, not just returned: the user walks through five stages
            // before committing and will not remember a toast from stage 1.
            errorReport: {
              truncated: true,
              fileRows: parsed.fileRows,
              stagedRows: parsed.rows.length,
            } satisfies Prisma.InputJsonValue,
          }
        : {}),
    },
  });

  // Outside a transaction on purpose. A 100k-row insert cannot finish inside
  // Prisma's interactive-transaction timeout, and it does not need to: a batch
  // whose staging died halfway is still PENDING, still owned by its uploader
  // and never committed, so the worst case is an abandoned draft rather than a
  // half-imported file.
  for (let i = 0; i < parsed.rows.length; i += STAGE_CHUNK) {
    const slice = parsed.rows.slice(i, i + STAGE_CHUNK);
    await prisma.importRow.createMany({
      data: slice.map((raw, offset) => ({
        batchId: batch.id,
        // 1-based and counted from the first DATA row, because that is what a
        // spreadsheet's row numbers mean to the person fixing the file.
        rowNumber: i + offset + 1,
        raw: raw as unknown as Prisma.InputJsonValue,
        status: 'PENDING',
      })),
    });
  }

  return {
    batch: toDto(batch, moduleSlug),
    headers: parsed.headers,
    sample: parsed.rows.slice(0, SAMPLE_ROWS),
    suggestedMapping: suggestion.mapping,
    unmappedColumns: suggestion.unmappedColumns,
    unmappedFields: suggestion.unmappedFields,
    truncated: parsed.truncated,
    fileRows: parsed.fileRows,
  };
}

// ── stages 2 and 4: the wizard saving as it goes ──────────────────────────

export async function updateImportBatch(
  principal: Principal,
  moduleSlug: string,
  batchId: string,
  patch: ImportPatchInput,
): Promise<ImportBatchDto> {
  assertImportAccess(principal);
  assertModuleReadAccess(principal, moduleSlug);

  const batch = await loadBatch(principal, moduleSlug, batchId);
  assertEditable(batch);

  if (patch.mapping) {
    const fields = await importFields(principal, batch.moduleId, moduleSlug);
    const headers = Array.isArray(batch.headers) ? (batch.headers as string[]) : [];
    validateMapping(patch.mapping, headers, fields);
  }

  const updated = await prisma.importBatch.update({
    where: { id: batch.id },
    data: {
      ...(patch.mapping ? { mapping: patch.mapping as unknown as Prisma.InputJsonValue } : {}),
      ...(patch.action ? { action: patch.action } : {}),
      ...(patch.dedupeKey ? { dedupeKey: patch.dedupeKey } : {}),
    },
  });

  return toDto(updated, moduleSlug);
}

// ── stage 5: commit ───────────────────────────────────────────────────────

export async function commitImport(
  principal: Principal,
  moduleSlug: string,
  batchId: string,
  input: ImportCommitInput,
): Promise<ImportProgress> {
  assertImportAccess(principal);
  assertModuleReadAccess(principal, moduleSlug);

  const batch = await loadBatch(principal, moduleSlug, batchId);
  assertEditable(batch);

  const module = await requireModule(moduleSlug);
  const fields = await importFields(principal, module.id, moduleSlug);
  const storage = storageFor({ id: module.id, slug: module.slug, isCore: module.isCore }, metasOf(fields));
  const shape = storage.shape;
  const engine = engineFor(principal);

  if (batch.total === 0) {
    throw new ConfigError('That file has no rows to import', 422, 'VALIDATION');
  }

  const headers = Array.isArray(batch.headers) ? (batch.headers as string[]) : [];
  validateMapping(input.mapping, headers, fields);

  if (mappedColumns(input.mapping).length === 0) {
    throw new ConfigError('Map at least one column to a field before importing', 422, 'VALIDATION');
  }

  const engineFilled = new Set(
    [shape.ownerColumn, shape.groupColumn, shape.statusColumn, shape.createdByColumn].filter(
      (c): c is string => c !== null,
    ),
  );
  assertRequiredCovered(input.mapping, fields, engineFilled);

  // ── what this action needs, in permissions and in storage ──
  const creates = input.action === 'ADD_NEW' || input.action === 'BOTH';
  const updates = input.action === 'UPDATE_ONLY' || input.action === 'BOTH';

  if (creates && !shape.canInsertRows) {
    // Users and deposits: rows here need something no FieldDefinition can
    // supply (an account, a settled payment), so they have their own create
    // paths and a field-driven insert would fail at the database.
    throw new ConfigError('Records in this module cannot be created from a file', 422, 'VALIDATION');
  }
  if (creates && !engine.can('create', moduleSlug)) {
    throw new ConfigError('You cannot create records in this module', 403, 'FORBIDDEN');
  }
  if (updates && !engine.can('edit', moduleSlug)) {
    throw new ConfigError('You cannot edit records in this module', 403, 'FORBIDDEN');
  }

  // ── the dedupe key ──
  if (input.dedupeKey === IMPORT_DEDUPE_NONE) {
    if (input.action !== 'ADD_NEW') {
      // Nothing can match, so UPDATE_ONLY would skip every row and BOTH would
      // create every row. Both are no-ops dressed as imports; say so now.
      throw new ConfigError(
        'Choose a field to match existing records on, or use "Add new" instead',
        422,
        'VALIDATION',
      );
    }
  } else {
    const dedupeField = fields.find((f) => f.key === input.dedupeKey);
    if (!dedupeField) {
      throw new ConfigError(`"${input.dedupeKey}" is not a field on this module`, 422, 'VALIDATION');
    }
    if (!FIELD_TYPE_SPECS[dedupeField.type].operators.includes('eq')) {
      throw new ConfigError(
        `"${dedupeField.label}" cannot be used to match records — it has no equals comparison`,
        422,
        'VALIDATION',
      );
    }
    const fed = mappedColumns(input.mapping).some((c) => c.field === input.dedupeKey);
    if (!fed) {
      throw new ConfigError(
        `Map a column to "${dedupeField.label}" — it is what existing records are matched on`,
        422,
        'VALIDATION',
      );
    }
  }

  // ── stage 5: who ends up owning the rows ──
  if (input.assignment.mode === 'OWNER') {
    if (shape.ownerColumn === null) {
      throw new ConfigError('Records in this module do not have an owner', 422, 'VALIDATION');
    }
    if (!engine.hasSpecial('REASSIGN_LEADS')) {
      // The record engine IGNORES a named owner from an actor without this
      // permission rather than rejecting it, so accepting the choice here
      // would silently round-robin the whole file instead.
      throw new ConfigError(
        'Assigning imported records to a chosen owner needs the Reassign leads permission',
        403,
        'FORBIDDEN',
      );
    }
    const owner = await prisma.user.findFirst({
      where: { id: input.assignment.ownerId, isActive: true },
      select: { id: true },
    });
    if (!owner) {
      throw new ConfigError('That user is not active and cannot own records', 422, 'VALIDATION');
    }
  }

  // ── hand off ──
  //
  // This write settles the instructions the run will use — the mapping, the
  // action and the match key as they stand on screen when Import is pressed,
  // which is not necessarily what the wizard last PATCHed (Previous exists).
  //
  // The `status: 'PENDING'` condition is what makes it safe to run twice: it
  // refuses once the worker has claimed the batch, so a stale tab cannot
  // rewrite the mapping of an import that is already half done. Two clicks
  // BEFORE the worker claims it are handled a layer down — `enqueueImport`
  // keys the job on the batch id, and the worker claims each row exactly once.
  // A batch left PENDING because Redis dropped the job stays re-committable,
  // which is the behaviour we want: pressing Import again is the fix.
  const { count } = await prisma.importBatch.updateMany({
    where: { id: batch.id, status: 'PENDING' },
    data: {
      mapping: input.mapping as unknown as Prisma.InputJsonValue,
      action: input.action,
      dedupeKey: input.dedupeKey,
    },
  });
  if (count === 0) throw new ConfigError('This import has already been submitted', 409, 'CONFLICT');

  await enqueueImport({ batchId: batch.id, assignment: input.assignment });

  return progressOf({ ...batch, status: 'PENDING' });
}

// ── progress, errors, history ─────────────────────────────────────────────

export async function getImportProgress(
  principal: Principal,
  moduleSlug: string,
  batchId: string,
): Promise<ImportProgress> {
  assertImportAccess(principal);
  assertModuleReadAccess(principal, moduleSlug);
  return progressOf(await loadBatch(principal, moduleSlug, batchId));
}

export async function getImportBatch(
  principal: Principal,
  moduleSlug: string,
  batchId: string,
): Promise<ImportBatchDto> {
  assertImportAccess(principal);
  assertModuleReadAccess(principal, moduleSlug);
  return toDto(await loadBatch(principal, moduleSlug, batchId), moduleSlug);
}

/**
 * The error report: the rows that failed, with the row number the user sees in
 * their spreadsheet and the raw values that were in it.
 *
 * Paginated because "40,000 rows failed" is a real outcome — a file mapped to
 * the wrong module produces exactly that — and answering it with 40,000 rows
 * in one response would take the browser down with it.
 */
export async function listImportErrors(
  principal: Principal,
  moduleSlug: string,
  batchId: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ rows: ImportRowError[]; total: number; page: number; pageSize: number }> {
  assertImportAccess(principal);
  assertModuleReadAccess(principal, moduleSlug);
  const batch = await loadBatch(principal, moduleSlug, batchId);

  const pageSize = Math.min(Math.max(opts.pageSize ?? ERRORS_PAGE_SIZE, 1), ERRORS_MAX_PAGE_SIZE);
  const page = Math.max(opts.page ?? 1, 1);

  const [rows, total] = await Promise.all([
    prisma.importRow.findMany({
      where: { batchId: batch.id, status: 'FAILED' },
      orderBy: { rowNumber: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { rowNumber: true, error: true, raw: true },
    }),
    prisma.importRow.count({ where: { batchId: batch.id, status: 'FAILED' } }),
  ]);

  return {
    rows: rows.map((r) => ({
      rowNumber: r.rowNumber,
      error: r.error ?? 'Unknown error',
      raw: (r.raw ?? {}) as Record<string, string>,
    })),
    total,
    page,
    pageSize,
  };
}

/** Recent batches for this module — the "previous imports" list. Scoped the
 *  same way a single batch is: your own, or everyone's for an Admin. */
export async function listImportBatches(
  principal: Principal,
  moduleSlug: string,
  opts: { take?: number } = {},
): Promise<ImportBatchDto[]> {
  assertImportAccess(principal);
  assertModuleReadAccess(principal, moduleSlug);

  const batches = await prisma.importBatch.findMany({
    where: {
      module: { slug: moduleSlug },
      ...(principal.actor.isAdmin ? {} : { userId: principal.user.id }),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(opts.take ?? RECENT_BATCHES, 1), 100),
  });

  return batches.map((b) => toDto(b, moduleSlug));
}
