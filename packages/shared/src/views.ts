import { z } from 'zod';
import {
  BINARY_OPERATORS,
  FIELD_TYPES,
  FIELD_TYPE_SPECS,
  LIST_OPERATORS,
  NULLARY_OPERATORS,
  OPERATORS,
  type FieldType,
  type Operator,
} from './field-types.js';
import {
  isGroup,
  type FilterCondition,
  type FilterGroup,
  type FilterNode,
  type ViewSpec,
} from './filter.js';

/**
 * The saved-view contract — the ONE definition of what a filter tree, a sort
 * and a column set are allowed to be. The list screen, the filter rail, the
 * route handlers, `lib/config/views.ts` and (later) the worker's export job
 * all parse through here, so they cannot disagree about what a view is.
 *
 * Two jobs, deliberately split:
 *
 *   `viewSpecSchema`          — STRUCTURAL. Shape, caps, operator arity.
 *                               Knows nothing about a module's fields, so a
 *                               route can parse a body before it has read any
 *                               config.
 *   `buildViewSpecSchema(fs)` — FIELD-AWARE. Adds the checks that need the
 *                               module's live `FieldDefinition` rows: the key
 *                               exists, its declared type is the real one, and
 *                               the operator is one that type actually allows.
 *
 * The field-aware pass is not cosmetic. `FIELD_TYPE_SPECS[type].operators` is
 * the operator registry (spec §10) and the ONLY place operators are decided —
 * a `contains` on a MULTI_SELECT would reach Prisma as a substring match on an
 * array column, and a filter that errors or silently matches nothing is a
 * filter the user believes narrowed their list.
 */

// ── caps ─────────────────────────────────────────────────────────────────
/**
 * The filter tree is USER INPUT and is walked recursively by both the Zod
 * parser and `compileFilter`. Without a ceiling, a 10k-deep tree posted by
 * anyone with a session is a stack overflow in the request handler — cheap to
 * send, expensive to serve. These are the bounds; the UI never approaches them.
 */
export const MAX_FILTER_DEPTH = 8;
export const MAX_FILTER_CONDITIONS = 100;
export const MAX_FILTER_CHILDREN = 50;
/** One `in` list. 200 ids is already a filter nobody built by hand. */
export const MAX_FILTER_LIST_VALUES = 200;
/** A `contains` term longer than this is not a search, it is a payload. */
export const MAX_FILTER_VALUE_LENGTH = 500;
export const MAX_VIEW_COLUMNS = 60;
/** Beyond a handful, extra sort keys cost an index and change nothing. */
export const MAX_SORT_KEYS = 4;

// ── the pieces ───────────────────────────────────────────────────────────

export const sortSpecSchema = z
  .object({
    fieldKey: z.string().trim().min(1).max(80),
    direction: z.enum(['asc', 'desc']),
  })
  .strict();

export const columnSpecSchema = z
  .object({
    fieldKey: z.string().trim().min(1).max(80),
    width: z.number().int().min(40).max(1000).optional(),
    pinned: z.enum(['left', 'right']).optional(),
    order: z.number().int().min(0).max(MAX_VIEW_COLUMNS),
  })
  .strict();

/**
 * Does this operator's value make sense?
 *
 * Arity is structural — it needs no field list — and getting it wrong is not
 * merely untidy. Prisma treats `undefined` as "condition absent", so a
 * `between` with no bounds compiles to `{ gte: undefined, lte: undefined }`,
 * which matches EVERY row. Inside an OR branch that widens the user's own
 * result set to the whole (scoped) module while the UI still shows a filter
 * chip. Same for `notIn: []`. So both are rejected here rather than compiled.
 */
function checkOperatorArity(
  c: { operator: Operator; value?: unknown; value2?: unknown },
  ctx: z.RefinementCtx,
): void {
  const { operator: op, value, value2 } = c;

  const tooLong = (v: unknown) => typeof v === 'string' && v.length > MAX_FILTER_VALUE_LENGTH;
  if (tooLong(value) || tooLong(value2)) {
    ctx.addIssue({
      code: 'custom',
      path: ['value'],
      message: `Filter values are limited to ${MAX_FILTER_VALUE_LENGTH} characters`,
    });
  }

  // Nullary operators carry their whole meaning in the operator. `isMe` is one
  // of them: its value is the ACTOR's id, substituted server-side, never taken
  // from the client — a client-supplied id would make "is me" mean "is them".
  if (NULLARY_OPERATORS.has(op)) return;

  if (BINARY_OPERATORS.has(op)) {
    if (value === undefined || value === null || value2 === undefined || value2 === null) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `"${op}" needs both bounds` });
    }
    return;
  }

  if (LIST_OPERATORS.has(op)) {
    if (!Array.isArray(value) || value.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `"${op}" needs at least one value` });
    } else if (value.length > MAX_FILTER_LIST_VALUES) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `"${op}" accepts at most ${MAX_FILTER_LIST_VALUES} values`,
      });
    }
    return;
  }

  if (op === 'lastNDays' || op === 'nextNDays') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 36_500) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `"${op}" needs a number of days` });
    }
    return;
  }

  if (value === undefined) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: `"${op}" needs a value` });
  }
}

export const filterConditionSchema = z
  .object({
    fieldKey: z.string().trim().min(1).max(80),
    /**
     * The type the CLIENT believes the field has. Carried so the UI can render
     * the right value editor without a second lookup — but never trusted:
     * `buildViewSpecSchema` re-checks it against the live FieldDefinition, and
     * `compileFilter` reads the type off the resolver, not off this.
     */
    fieldType: z.enum(FIELD_TYPES),
    operator: z.enum(OPERATORS),
    value: z.unknown().optional(),
    value2: z.unknown().optional(),
  })
  .strict()
  .superRefine(checkOperatorArity);

/**
 * The tree, recursive through `z.lazy`. Declared before the group schema it
 * names because the lazy body is evaluated at PARSE time, by which point both
 * bindings exist; the group's `children` array needs this one at CONSTRUCTION
 * time, which is why the order cannot be the other way round.
 */
export const filterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([filterGroupSchema, filterConditionSchema]),
);

export const filterGroupSchema: z.ZodType<FilterGroup> = z
  .object({
    op: z.enum(['AND', 'OR']),
    children: z.array(filterNodeSchema).max(MAX_FILTER_CHILDREN),
  })
  .strict();

/** Depth and total condition count, which no per-node rule can see. */
function checkFilterBounds(node: FilterNode, ctx: z.RefinementCtx): void {
  let conditions = 0;

  const walk = (n: FilterNode, depth: number, path: (string | number)[]): void => {
    if (depth > MAX_FILTER_DEPTH) {
      ctx.addIssue({
        code: 'custom',
        path,
        message: `Filters may nest at most ${MAX_FILTER_DEPTH} levels deep`,
      });
      return;
    }
    if (!isGroup(n)) {
      conditions += 1;
      if (conditions > MAX_FILTER_CONDITIONS) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `A filter may hold at most ${MAX_FILTER_CONDITIONS} conditions`,
        });
      }
      return;
    }
    n.children.forEach((child, i) => walk(child, depth + 1, [...path, 'children', i]));
  };

  walk(node, 1, []);
}

/** A whole tree: node rules, plus the bounds that only the root can enforce. */
export const filterTreeSchema = filterNodeSchema.superRefine(checkFilterBounds);

// ── the view spec ────────────────────────────────────────────────────────

/**
 * STRUCTURAL only — see the file header. A route parses this before it knows
 * which module it is serving; `buildViewSpecSchema` adds the field checks once
 * the module's fields are loaded.
 */
export const viewSpecSchema = z
  .object({
    columns: z.array(columnSpecSchema).max(MAX_VIEW_COLUMNS),
    filters: filterTreeSchema.optional(),
    sort: z.array(sortSpecSchema).max(MAX_SORT_KEYS).optional(),
  })
  .strict();

/** The minimum a field must declare for a view to be validated against it. */
export interface FilterableField {
  key: string;
  type: FieldType;
}

/**
 * `viewSpecSchema` plus the three checks that need the module's live fields.
 *
 * Callers pass the fields the ACTOR may see. A field hidden by the permission
 * matrix must not appear in this list: a filter on a hidden field is a value
 * oracle — narrow it repeatedly and you read a field you were never allowed to
 * see — so an unknown key and a hidden key give the same answer here, exactly
 * as the storage resolver gives the same answer for both.
 */
export interface FilterFieldIssue {
  path: (string | number)[];
  message: string;
}

/** The three field-aware checks for ONE condition. The single source. */
function conditionIssues(
  c: FilterCondition,
  typeByKey: Map<string, FieldType>,
): FilterFieldIssue[] {
  const realType = typeByKey.get(c.fieldKey);
  if (realType === undefined) {
    // Unknown and hidden give the same answer — callers pass only the fields
    // the actor may see, and a distinguishable refusal is itself a disclosure.
    return [{ path: ['fieldKey'], message: `Unknown field "${c.fieldKey}"` }];
  }
  const out: FilterFieldIssue[] = [];
  if (c.fieldType !== realType) {
    out.push({
      path: ['fieldType'],
      message: `"${c.fieldKey}" is a ${FIELD_TYPE_SPECS[realType].label} field`,
    });
  }
  // THE operator registry. Never a per-field list, never a switch elsewhere.
  if (!FIELD_TYPE_SPECS[realType].operators.includes(c.operator)) {
    out.push({
      path: ['operator'],
      message: `${FIELD_TYPE_SPECS[realType].label} fields do not support "${c.operator}"`,
    });
  }
  return out;
}

/**
 * Walk a filter TREE and report every field-aware problem in it.
 *
 * The same three checks `buildViewSpecSchema` runs when a view is SAVED, in a
 * form the query path can call when a tree is RUN. Both matter, and neither
 * substitutes for the other: a tree can be posted to
 * `POST /records/query` without ever being saved, and the structural schema
 * that guards that route knows nothing about a module's fields.
 *
 * Why running an unchecked tree is not merely untidy — `compileFilter` maps
 * an operator onto Prisma by NAME, not by the field's type, so a mismatch
 * compiles to a comparison that is legal SQL and wrong:
 *
 *   - `gt` on a text field became a lexicographic `>` and matched EVERY row,
 *     while the screen still showed a filter chip. That is a filter the user
 *     believes narrowed their list and it narrowed nothing.
 *   - `contains` on a MULTI_SELECT became a substring match against an array
 *     and matched none, which reads as "no results" rather than "bad filter".
 *
 * Returns issues rather than throwing so each caller can raise its own error
 * type — this package knows nothing about HTTP status codes.
 */
export function filterFieldIssues(
  node: FilterNode,
  fields: readonly FilterableField[],
): FilterFieldIssue[] {
  const typeByKey = new Map(fields.map((f) => [f.key, f.type]));
  const out: FilterFieldIssue[] = [];
  const walk = (n: FilterNode, path: (string | number)[]): void => {
    if (isGroup(n)) {
      n.children.forEach((child, i) => walk(child, [...path, 'children', i]));
      return;
    }
    for (const issue of conditionIssues(n, typeByKey)) {
      out.push({ path: [...path, ...issue.path], message: issue.message });
    }
  };
  walk(node, []);
  return out;
}

export function buildViewSpecSchema(fields: readonly FilterableField[]) {
  const typeByKey = new Map(fields.map((f) => [f.key, f.type]));

  const checkCondition = (c: FilterCondition, path: (string | number)[], ctx: z.RefinementCtx) => {
    for (const issue of conditionIssues(c, typeByKey)) {
      ctx.addIssue({ code: 'custom', path: [...path, ...issue.path], message: issue.message });
    }
  };

  return viewSpecSchema.superRefine((spec, ctx) => {
    const walk = (n: FilterNode, path: (string | number)[]): void => {
      if (isGroup(n)) {
        n.children.forEach((child, i) => walk(child, [...path, 'children', i]));
        return;
      }
      checkCondition(n, path, ctx);
    };
    if (spec.filters) walk(spec.filters, ['filters']);

    spec.sort?.forEach((s, i) => {
      if (!typeByKey.has(s.fieldKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sort', i, 'fieldKey'],
          message: `Unknown field "${s.fieldKey}"`,
        });
      }
    });

    spec.columns.forEach((c, i) => {
      if (!typeByKey.has(c.fieldKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['columns', i, 'fieldKey'],
          message: `Unknown field "${c.fieldKey}"`,
        });
      }
    });
  });
}

// ── saved-view payloads ──────────────────────────────────────────────────

/**
 * Shared between create and update so the two can never drift. `isShared`,
 * `isDefault` and `roleId` are PRIVILEGED — publishing a view to everyone or
 * pinning it as a role's default is a configuration act, and `lib/config/
 * views.ts` gates them. Validation says what the shape is; it never says who
 * may send it.
 */
const viewShape = {
  name: z.string().trim().min(1, 'Name is required').max(80),
  columns: z.array(columnSpecSchema).min(1, 'A view needs at least one column').max(MAX_VIEW_COLUMNS),
  filters: filterTreeSchema.nullish(),
  sort: z.array(sortSpecSchema).max(MAX_SORT_KEYS).nullish(),
  isShared: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  roleId: z.string().uuid().nullish(),
};

export const viewCreateSchema = z.object(viewShape).strict();
/** Partial: a rename must not have to resend the whole tree. */
export const viewUpdateSchema = z.object(viewShape).partial().strict();

export type SortSpecInput = z.infer<typeof sortSpecSchema>;
export type ColumnSpecInput = z.infer<typeof columnSpecSchema>;
export type ViewSpecInput = z.infer<typeof viewSpecSchema>;
export type ViewCreateInput = z.infer<typeof viewCreateSchema>;
export type ViewUpdateInput = z.infer<typeof viewUpdateSchema>;

/** What a saved view looks like on the wire. */
export interface SavedViewDto extends ViewSpec {
  id: string;
  name: string;
  isShared: boolean;
  isDefault: boolean;
  roleId: string | null;
  /** the actor owns it — only then may they edit or delete it */
  isOwn: boolean;
  /**
   * False when the stored spec no longer parses — a seed written to an older
   * shape, or a cap tightened since. Such a view is still listed, with an
   * empty spec, so it can be renamed or deleted; it just cannot be applied.
   */
  isValid: boolean;
  /** live match count. Absent when not requested, or not computable. */
  matchCount?: number;
}

// ── the query envelope ───────────────────────────────────────────────────

/**
 * What `POST /api/modules/:slug/records/query` accepts.
 *
 * A filter tree travels in a BODY, not a query string — see the route handler
 * for the two reasons (URL length, and filter values are record data).
 */
export const recordQuerySchema = z
  .object({
    filters: filterTreeSchema.nullish(),
    sort: z.array(sortSpecSchema).max(MAX_SORT_KEYS).nullish(),
    search: z.string().trim().max(MAX_FILTER_VALUE_LENGTH).nullish(),
    page: z.number().int().min(1).max(100_000).optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
  })
  .strict();
export type RecordQueryInput = z.infer<typeof recordQuerySchema>;
