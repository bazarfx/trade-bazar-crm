import { z } from 'zod';
import type { FieldType } from './field-types.js';

/**
 * The import contract — one definition of what an import batch IS, shared by
 * the wizard, the route handlers that stage a file and the worker that
 * processes the rows.
 *
 * It lives here for the same reason `buildRecordSchema` does: the import must
 * not become a second write path. A row arriving from a spreadsheet is
 * validated by the module's generated schema, assigned by the assignment
 * engine and logged by the audit logger, exactly as a row typed into the
 * create form is. What this file adds is only the shape of the INSTRUCTIONS —
 * which column feeds which field, what to do about a record that already
 * exists, and who ends up owning the result.
 *
 * Nothing here names a module, a field or a status. `dedupeKey` holds a field
 * KEY the Admin's own `FieldDefinition` rows supply; the wizard offers
 * whatever that module has.
 */

// ── stage 2: Actions ──────────────────────────────────────────────────────

/**
 * What to do when a source row matches a record that already exists,
 * decided by `dedupeKey`.
 *
 * `ADD_NEW`      — create every row. A match is created ANYWAY and flagged for
 *                  review; spec §6.6 is explicit that duplicates are never
 *                  blocked and never auto-merged, and an import is not an
 *                  exception to that.
 * `UPDATE_ONLY`  — update the matched record in place, field by field, through
 *                  the same `updateRecord` path a manual edit takes (so every
 *                  changed field lands in the timeline as before → after). A
 *                  row that matches NOTHING is SKIPPED, not created.
 * `BOTH`         — update on a match, create on a miss. The "upsert" the Zoho
 *                  user expects, and the reason `ImportRow.status` needs both
 *                  IMPORTED and SKIPPED as distinct outcomes.
 *
 * With `dedupeKey` set to NONE nothing can match, so `UPDATE_ONLY` skips
 * everything and `BOTH` degrades to `ADD_NEW`. The wizard should say so rather
 * than let a user run a no-op import.
 */
export const IMPORT_ACTIONS = ['ADD_NEW', 'UPDATE_ONLY', 'BOTH'] as const;
export type ImportAction = (typeof IMPORT_ACTIONS)[number];

export const importActionSchema = z.enum(IMPORT_ACTIONS);

/**
 * The field whose value identifies an existing record, or NONE.
 *
 * A FIELD KEY, never a fixed list of column names: any field the Admin marks
 * unique is a legitimate match key, including one created next year. `NONE`
 * is the literal opt-out and is deliberately upper-case so it cannot collide
 * with a derived key (`fieldKeyFromLabel` emits snake_case and strips leading
 * underscores, so it can never produce "NONE").
 */
export const IMPORT_DEDUPE_NONE = 'NONE';

export const importDedupeKeySchema = z
  .string()
  .min(1)
  .max(64)
  .describe('a FieldDefinition key on the target module, or the literal "NONE"');

// ── batch and row lifecycles ──────────────────────────────────────────────

/**
 * `ImportBatch.status`. The batch is a job: it waits, it runs, it ends.
 *
 * `FAILED` is reserved for a failure of the BATCH — the file could not be
 * decoded, the module vanished, the worker gave up. Rows that failed
 * individually do not fail the batch; they are counted in `failed` and the
 * batch still `COMPLETED`, because a 40,000-row import with 12 bad phone
 * numbers imported 39,988 records and saying otherwise would be a lie.
 */
export const IMPORT_STATUS = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type ImportStatus = (typeof IMPORT_STATUS)[number];

export const importStatusSchema = z.enum(IMPORT_STATUS);

/**
 * `ImportRow.status`. Every staged row ends in exactly one of these, which is
 * what makes the batch resumable: a worker restarted mid-run picks up the
 * PENDING rows and cannot touch the ones already decided.
 *
 * `SKIPPED` is not a failure — it is `UPDATE_ONLY` finding no match, or a row
 * the user chose not to bring across. Counting it as `failed` would put a red
 * number on a correct import.
 */
export const IMPORT_ROW_STATUS = ['PENDING', 'IMPORTED', 'SKIPPED', 'FAILED'] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUS)[number];

export const importRowStatusSchema = z.enum(IMPORT_ROW_STATUS);

// ── stage 1: Upload ───────────────────────────────────────────────────────

/**
 * The Charset selector in stage 1.
 *
 * A fixed list does NOT breach the prime directive: this is bounded by what
 * `TextDecoder` can decode, not by anything the client might invent, and a
 * charset is not a customer-visible business option. The encoding is recorded
 * on the batch because bytes are decoded ONCE — a Windows-1252 export re-read
 * as UTF-8 mangles every accented name silently, and a re-parse has to be able
 * to reproduce the same rows.
 */
export const IMPORT_CHARSETS = ['utf-8', 'utf-16le', 'windows-1252', 'iso-8859-1'] as const;
export type ImportCharset = (typeof IMPORT_CHARSETS)[number];

export const importCharsetSchema = z.enum(IMPORT_CHARSETS);

// ── caps ──────────────────────────────────────────────────────────────────

/** Matches the hard field cap in spec §13 — a file cannot map more columns
 *  than a module is allowed to have fields. */
export const IMPORT_MAX_COLUMNS = 250;

/**
 * Rows staged per batch. Not a comfort limit: every row becomes an `ImportRow`
 * holding its own raw copy, and the whole point of staging is that the set is
 * enumerable. A larger file is split into batches rather than accepted whole.
 */
export const IMPORT_MAX_ROWS = 100_000;

// ── stage 4: Fileld Mapping ───────────────────────────────────────────────

/**
 * One source column's instructions.
 *
 * Keyed by the header TEXT rather than by position so a saved mapping is a
 * reusable preset (`ImportBatch.mapping`): next month's export from the same
 * system has the same headers in a different order, and the preset still fits.
 */
export const importColumnMappingSchema = z
  .object({
    /** the header exactly as it appears in the file, before any trimming the
     *  UI does for display — the error report has to name what the user sees */
    column: z.string().min(1).max(200),
    /**
     * `FieldDefinition.key` on the target module, or null while the column is
     * still unmapped. Stage 4's "Unmapped Columns" tab is literally this being
     * null, so an unmapped column is a STATE, not a validation error.
     */
    field: z.string().min(1).max(64).nullable().default(null),
    /**
     * Leave this column out of the import.
     *
     * Kept separate from `field: null` and allowed to coexist with a mapping:
     * toggling skip in the UI must not silently discard the field the user
     * already chose, so that they can toggle it back. Skip WINS at import time.
     */
    skip: z.boolean().default(false),
    /**
     * Value to use when this column's cell is empty.
     *
     * A string because every cell out of a CSV is one — the import coerces per
     * field type through the module's generated schema, and a default has to
     * travel the same path as a real value or the two could disagree about
     * what "1" means for a NUMBER field.
     */
    defaultValue: z.string().max(1000).nullable().default(null),
  })
  .strict();

export type ImportColumnMapping = z.infer<typeof importColumnMappingSchema>;

/**
 * The whole file's mapping, in file order.
 *
 * Two columns may not feed one field. There is no correct answer to which one
 * wins, and silently taking the last would corrupt a 40,000-row import in a
 * way that only shows up as "some of the phone numbers are wrong".
 */
export const importMappingSchema = z
  .object({
    columns: z.array(importColumnMappingSchema).max(IMPORT_MAX_COLUMNS),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seenColumns = new Set<string>();
    const seenFields = new Map<string, number>();

    value.columns.forEach((col, index) => {
      if (seenColumns.has(col.column)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['columns', index, 'column'],
          message: `Column "${col.column}" appears twice in the mapping`,
        });
      }
      seenColumns.add(col.column);

      if (col.skip || col.field === null) return;

      const first = seenFields.get(col.field);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['columns', index, 'field'],
          message: `Two columns are mapped to the same field — "${value.columns[first]?.column ?? ''}" and "${col.column}"`,
        });
      } else {
        seenFields.set(col.field, index);
      }
    });
  });

export type ImportMapping = z.infer<typeof importMappingSchema>;

/** The columns that will actually be written: mapped and not skipped. The one
 *  definition of "mapped", so the wizard's tab counts and the worker's row
 *  builder cannot drift apart. */
export function mappedColumns(mapping: ImportMapping): ImportColumnMapping[] {
  return mapping.columns.filter((c) => !c.skip && c.field !== null);
}

// ── stage 5: Assign ───────────────────────────────────────────────────────

/**
 * Who owns the imported records.
 *
 * `RULES` runs each row through `assignOwner` — the same four tiers a lead
 * arriving from a campaign takes, so an imported lead is routed exactly like a
 * manually created one and every one of them lands with an ASSIGNED audit row.
 * `OWNER` hands the whole batch to one named user, which the timeline records
 * with the `manual` reason.
 *
 * There is no third option and there must never be one: invariant 1 says a
 * record is never unassigned, so "leave it blank" is not a choice the wizard
 * can offer.
 */
export const IMPORT_ASSIGN_MODES = ['RULES', 'OWNER'] as const;
export type ImportAssignMode = (typeof IMPORT_ASSIGN_MODES)[number];

export const importAssignmentSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('RULES') }).strict(),
  z.object({ mode: z.literal('OWNER'), ownerId: z.string().uuid() }).strict(),
]);

export type ImportAssignment = z.infer<typeof importAssignmentSchema>;

// ── the two writes ────────────────────────────────────────────────────────

/**
 * CREATE — what accompanies the uploaded file (stages 1–3).
 *
 * The batch row exists before the wizard is finished because `ImportRow` hangs
 * off it: parsing and staging happen while the request is open, which is
 * allowed, and only ROW PROCESSING is the worker's (CLAUDE.md — a
 * multi-megabyte import is the example it gives). `action` and `dedupeKey`
 * carry defaults so a batch can be staged before stage 2 is answered; the
 * commit below is what settles them.
 *
 * The file's bytes and `headers` are NOT in this schema — the upload is
 * multipart and the headers are read out of the parse, not asserted by the
 * client.
 */
export const importCreateSchema = z
  .object({
    /** stage 3, Module-File Mapping: which module this file feeds */
    moduleSlug: z.string().min(1).max(64),
    /** shown in the batch list and in the error report; the user's own filename */
    filename: z.string().min(1).max(255),
    charset: importCharsetSchema.default('utf-8'),
    action: importActionSchema.default('ADD_NEW'),
    dedupeKey: importDedupeKeySchema.default(IMPORT_DEDUPE_NONE),
  })
  .strict();

export type ImportCreateInput = z.infer<typeof importCreateSchema>;

/**
 * COMMIT — what the wizard's final Next posts (stages 2, 4 and 5 settled).
 *
 * This is the enqueue. Everything above it ran in the request; everything
 * after it runs in the worker, one staged row at a time, through the record
 * engine. Re-sending `action` and `dedupeKey` rather than trusting what create
 * stored is deliberate: the user can walk back through the wizard with
 * Previous, and the run must use what is on screen when they press it.
 */
export const importCommitSchema = z
  .object({
    mapping: importMappingSchema,
    action: importActionSchema,
    dedupeKey: importDedupeKeySchema,
    assignment: importAssignmentSchema,
  })
  .strict();

export type ImportCommitInput = z.infer<typeof importCommitSchema>;

// ── the file itself ───────────────────────────────────────────────────────

/**
 * What the upload accepts, named ONCE so the wizard's copy and the parser's
 * 422 cannot drift apart.
 *
 * The Figma shows VCF and XLS in the file list. Neither is supported and both
 * are refused by name rather than accepted and failed later: a .vcf is a
 * contact card with no columns at all, and .xls is the pre-2007 BIFF binary,
 * a different format from .xlsx that would need a second parser to read. The
 * wizard says so on the drop target — silently accepting a file we cannot read
 * and reporting it as 40,000 failed rows is the worse answer.
 */
export const IMPORT_SUPPORTED_EXTENSIONS = ['.csv', '.xlsx'] as const;
export type ImportFormat = 'csv' | 'xlsx';

/** For the file input's `accept` attribute. */
export const IMPORT_ACCEPT = IMPORT_SUPPORTED_EXTENSIONS.join(',');

/**
 * Upload cap, in bytes.
 *
 * Parsing happens while the request is open (CLAUDE.md allows staging there;
 * only ROW PROCESSING is the worker's), and both parsers are whole-file:
 * papaparse materialises every row and exceljs unzips the entire workbook into
 * memory. 20 MB of CSV is roughly 100k lead rows — past that the request, not
 * the import, is what falls over, so the cap is stated instead of discovered.
 * A bigger file is split, which is a real answer; pretending is not.
 */
export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The Redis queue the commit enqueues onto and the worker drains.
 *
 * A literal string in two apps is a silent failure mode — the name is a Redis
 * key, so a typo on either side produces jobs that are accepted and never run.
 * `apps/worker/src/lib/queues.ts` reads this same constant.
 */
export const IMPORT_QUEUE = 'imports';

/** Separator for a MULTI_SELECT / LANGUAGE_PICKER cell. One character, stated
 *  in the error message, because guessing between `;` and `,` mangles any
 *  option value that contains a comma. */
export const IMPORT_MULTI_VALUE_SEPARATOR = ';';

// ── the wire, beyond create and commit ────────────────────────────────────

/**
 * PATCH — the wizard saving its way through stages 2 and 4.
 *
 * Every part optional because the wizard patches as the user moves: stage 2
 * settles `action` and `dedupeKey`, stage 4 settles the mapping, and Previous
 * lets them revisit either. The commit re-sends all of it, so this is a
 * convenience for resumability rather than the authority on what runs.
 */
export const importPatchSchema = z
  .object({
    mapping: importMappingSchema.optional(),
    action: importActionSchema.optional(),
    dedupeKey: importDedupeKeySchema.optional(),
  })
  .strict();

export type ImportPatchInput = z.infer<typeof importPatchSchema>;

/**
 * The BullMQ job payload.
 *
 * `assignment` travels on the JOB rather than on `ImportBatch` because the
 * batch table has no column for it and stage 5 is answered at the very last
 * step — it is an instruction for THIS run, not a property of the staged file.
 * A retry re-reads the same job data, so a re-run assigns the same way.
 */
export const importJobDataSchema = z
  .object({
    batchId: z.string().uuid(),
    assignment: importAssignmentSchema,
  })
  .strict();

export type ImportJobData = z.infer<typeof importJobDataSchema>;

// ── cells → values ────────────────────────────────────────────────────────

/**
 * One decoded cell, or the reason it could not be decoded.
 *
 * A RESULT rather than a throw: a bad cell fails its own ROW and the import
 * carries on (one bad phone number must never abort 40,000 rows), so the
 * message has to travel back as data.
 */
export type ImportCell = { ok: true; value: unknown } | { ok: false; message: string };

const TRUE_TEXT = new Set(['true', 'yes', 'y', '1', 'on']);
const FALSE_TEXT = new Set(['false', 'no', 'n', '0', 'off']);

/** `1,234.50` — a thousands-separated number, and ONLY that shape. Stripping
 *  commas unconditionally would turn the European `1,5` into fifteen. */
const THOUSANDS = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;

/** `31/12/2026`, `31-12-2026`, `31.12.2026` — day first. */
const DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

/** Resolve a picklist cell against the field's own options: the stored VALUE
 *  first, then the LABEL a human types into a spreadsheet. Matching the label
 *  is a lookup of user-supplied data, not system behaviour keyed on a name —
 *  what the row ends up storing is always the option's value. */
function pickOption(
  text: string,
  options: readonly { value: string; label?: string }[] | undefined,
): string | null {
  if (!options || options.length === 0) return text;
  const lowered = text.toLowerCase();
  const byValue = options.find((o) => o.value.toLowerCase() === lowered);
  if (byValue) return byValue.value;
  const byLabel = options.find((o) => (o.label ?? '').toLowerCase() === lowered);
  return byLabel ? byLabel.value : null;
}

/**
 * Decode one spreadsheet cell into the shape `buildRecordSchema` validates.
 *
 * This is NOT a second validation path — it is the reverse of rendering: a
 * file gives every cell as text, and the generated schema expects a boolean
 * for a TOGGLE and an array for a MULTI_SELECT. Everything that decides
 * whether a value is ACCEPTABLE still happens once, in `buildRecordSchema`.
 * What lives here is only how text becomes a candidate value, keyed off the
 * type registry so a new field type needs no change in the import.
 *
 * An empty cell decodes to `null` and the caller OMITS it, rather than writing
 * an empty string: on a create that lets the field's configured default apply,
 * and on an update it means "this column had nothing to say", not "erase it".
 */
export function coerceImportCell(
  type: FieldType,
  raw: string,
  options?: readonly { value: string; label?: string }[],
): ImportCell {
  const text = raw.trim();
  if (text === '') return { ok: true, value: null };

  switch (type) {
    case 'CHECKBOX':
    case 'TOGGLE': {
      const lowered = text.toLowerCase();
      if (TRUE_TEXT.has(lowered)) return { ok: true, value: true };
      if (FALSE_TEXT.has(lowered)) return { ok: true, value: false };
      return { ok: false, message: `"${text}" is not yes/no (accepted: yes, no, true, false, 1, 0)` };
    }

    case 'NUMBER':
    case 'DECIMAL':
    case 'CURRENCY':
    case 'PERCENT': {
      const cleaned = (THOUSANDS.test(text) ? text.replace(/,/g, '') : text).replace(/^[₹$€£]\s?/, '');
      const n = Number(cleaned);
      if (!Number.isFinite(n)) return { ok: false, message: `"${text}" is not a number` };
      return { ok: true, value: n };
    }

    case 'DATE':
    case 'DATE_TIME': {
      const dmy = DMY.exec(text);
      // Day first, because a slashed date is ambiguous and something has to
      // decide: the client is Indian and every export they produce is
      // dd/mm/yyyy. ISO (yyyy-mm-dd) is read natively and is what the wizard
      // recommends — it is the only form that cannot be misread.
      const iso = dmy
        ? `${dmy[3]}-${(dmy[2] ?? '').padStart(2, '0')}-${(dmy[1] ?? '').padStart(2, '0')}`
        : text;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) {
        return { ok: false, message: `"${text}" is not a date (use YYYY-MM-DD)` };
      }
      return { ok: true, value: d.toISOString() };
    }

    case 'MULTI_SELECT':
    case 'LANGUAGE_PICKER': {
      const parts = text
        .split(IMPORT_MULTI_VALUE_SEPARATOR)
        .map((p) => p.trim())
        .filter((p) => p !== '');
      const values: string[] = [];
      for (const part of parts) {
        const resolved = pickOption(part, options);
        if (resolved === null) return { ok: false, message: `"${part}" is not one of the allowed values` };
        values.push(resolved);
      }
      return { ok: true, value: values };
    }

    case 'DROPDOWN': {
      const resolved = pickOption(text, options);
      if (resolved === null) return { ok: false, message: `"${text}" is not one of the allowed values` };
      return { ok: true, value: resolved };
    }

    case 'FILE':
    case 'IMAGE':
      // A field value is an AttachmentRef pointing at stored bytes; a
      // spreadsheet cell has no bytes to point at.
      return { ok: false, message: 'attachments cannot be imported from a file' };

    case 'FORMULA':
    case 'AUTONUMBER':
      return { ok: false, message: 'this field is computed and cannot be imported' };

    default:
      // Text-shaped: EMAIL, PHONE, URL, SINGLE_LINE, MULTI_LINE, USER_LOOKUP,
      // RECORD_LINK. The generated schema decides whether the text is valid;
      // phone values are normalised by the record engine on the way in, so
      // they must NOT be pre-normalised here or the two would disagree.
      return { ok: true, value: text };
  }
}
