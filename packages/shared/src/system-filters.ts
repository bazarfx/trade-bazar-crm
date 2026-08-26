/**
 * System-defined filters — the second group on the list screen's filter rail.
 *
 * These are NOT filters over a module's fields. A field filter names a
 * `FieldDefinition` and compiles through `compileFilter`; a system filter names
 * a QUESTION ABOUT THE RECORD ITSELF that no field can answer — "has anyone
 * touched this since it was created", "what was the last thing that happened
 * to it". The answer lives in the audit log or in a storage column, never in
 * the module's field list, which is why the two are separate groups on the
 * rail and separate keys in the query envelope.
 *
 * WHY THE IDS ARE A FIXED VOCABULARY, when nothing else in this product is.
 * Every other list on the rail is Admin data — fields, statuses, saved views.
 * These nine are the questions the ENGINE can ask, one per capability the
 * engine has; an Admin cannot invent a tenth any more than they can invent a
 * new column on `AuditLog`. So the ids are code, and what varies per module is
 * only whether that module can ANSWER each one — `available` below, computed
 * per module from its storage shape, never hardcoded.
 *
 * The labels are the Figma file's, verbatim.
 */
import { z } from 'zod';

/**
 * The nine rows the file draws, in the file's order. The rail renders this
 * array; it does not sort, filter or re-order it, so a row that a module
 * cannot answer still DRAWS — disabled, with its reason — rather than
 * vanishing. A row that quietly disappears reads as a bug; a row that says
 * why it is off reads as an answer.
 */
export const SYSTEM_FILTER_IDS = [
  'activities',
  'cadences',
  'campaigns',
  'latestEmailStatus',
  'locked',
  'recordAction',
  'relatedRecordAction',
  'touched',
  'untouched',
] as const;

export type SystemFilterId = (typeof SYSTEM_FILTER_IDS)[number];

/**
 * Is this string one of the nine?
 *
 * The narrowing every caller needs and nobody should re-spell: a ticked id
 * read back out of a URL fragment, a saved view or `localStorage` is a
 * `string`, and the only safe way to turn one into a `SystemFilterId` is to
 * check it against the vocabulary. Lives here because the vocabulary lives
 * here — a second copy of this test is a second place for it to fall behind.
 */
export function isSystemFilterId(value: unknown): value is SystemFilterId {
  return typeof value === 'string' && (SYSTEM_FILTER_IDS as readonly string[]).includes(value);
}

/** One choice for a row that needs a value. `value` is what travels back. */
export interface SystemFilterOption {
  value: string;
  label: string;
}

/** One row of the group, as the rail receives it. */
export interface SystemFilterDto {
  id: SystemFilterId;
  /** the file's label, verbatim */
  label: string;
  /** can this module answer it right now? */
  available: boolean;
  /** why not, in a sentence a person reads; null when available */
  reason: string | null;
  /** when the row needs a value (recordAction), the choices; else null */
  options: SystemFilterOption[] | null;
}

/** A row the caller has switched on, with its value when it needs one. */
export interface SystemFilterSelection {
  id: SystemFilterId;
  value?: string;
}

/**
 * Nine rows, so nine selections. There is no legal query that names one twice
 * — `touched` AND `touched` is either a duplicate or a contradiction, and both
 * are a client bug worth a 400 rather than a guess.
 */
export const MAX_SYSTEM_FILTERS = SYSTEM_FILTER_IDS.length;

/**
 * A system filter's value, structurally.
 *
 * Structural ONLY, exactly like `recordQuerySchema`'s field filters: which
 * values a row actually accepts depends on the module and on a vocabulary the
 * database owns (`recordAction` takes an `AuditAction`), and neither is
 * readable before any config has loaded. The semantic check therefore happens
 * in the engine, where the module's shape is known — and it THROWS on anything
 * it does not recognise rather than dropping the condition, for the same
 * reason an unknown field key throws: a dropped condition widens the result
 * set, and a widened result set can cross a permission scope.
 */
export const systemFilterSelectionSchema = z
  .object({
    id: z.enum(SYSTEM_FILTER_IDS),
    value: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

/** The `system` array on a record query: capped, and unique by id. */
export const systemFilterListSchema = z
  .array(systemFilterSelectionSchema)
  .max(MAX_SYSTEM_FILTERS)
  .superRefine((rows, ctx) => {
    const seen = new Set<string>();
    for (const [i, row] of rows.entries()) {
      if (seen.has(row.id)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'id'],
          message: `System filter "${row.id}" is named twice`,
        });
      }
      seen.add(row.id);
    }
  });
