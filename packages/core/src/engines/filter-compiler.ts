import {
  isGroup,
  NULLARY_OPERATORS,
  BINARY_OPERATORS,
  LIST_OPERATORS,
  type FilterNode,
  type FilterCondition,
  type FieldType,
} from '@crm/shared';

/**
 * Compiles a user-supplied filter tree into a Prisma `where` clause.
 *
 * Two rules, both security-critical:
 *   1. NEVER build SQL by string concatenation. Values always travel as
 *      parameters inside the Prisma object.
 *   2. The field key is validated against the module's field definitions by
 *      the caller BEFORE it reaches here. An unknown key must throw, not be
 *      silently dropped — silently dropping a condition widens a result set,
 *      which can leak records past a permission scope.
 */

export interface FieldLocation {
  /** real column on a core table, or null when the value lives in JSONB */
  column: string | null;
  /** JSONB container column, e.g. "custom" for core tables, "data" for generic records */
  jsonColumn: string;
  key: string;
  type: FieldType;
}

export type PrismaWhere = Record<string, unknown>;

const startOfToday = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate());

function dateWindow(op: string, value: unknown, now: Date): { gte?: Date; lte?: Date; lt?: Date } {
  const today = startOfToday(now);
  switch (op) {
    case 'today': {
      const end = new Date(today); end.setDate(end.getDate() + 1);
      return { gte: today, lt: end };
    }
    case 'thisWeek': {
      const start = new Date(today);
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Monday
      const end = new Date(start); end.setDate(end.getDate() + 7);
      return { gte: start, lt: end };
    }
    case 'thisMonth': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return { gte: start, lt: end };
    }
    case 'lastNDays': {
      const n = Number(value) || 0;
      const start = new Date(today); start.setDate(start.getDate() - n);
      return { gte: start };
    }
    case 'nextNDays': {
      const n = Number(value) || 0;
      const end = new Date(today); end.setDate(end.getDate() + n + 1);
      return { gte: today, lt: end };
    }
    default:
      return {};
  }
}

/** Build the comparison object for one condition, independent of where it's stored. */
function comparison(c: FilterCondition, now: Date): unknown {
  const { operator: op, value, value2 } = c;

  if (NULLARY_OPERATORS.has(op)) {
    switch (op) {
      case 'isEmpty':    return null;
      case 'isNotEmpty': return { not: null };
      case 'isTrue':     return true;
      case 'isFalse':    return false;
      case 'today':
      case 'thisWeek':
      case 'thisMonth':  return dateWindow(op, value, now);
      case 'isMe':       return value; // caller substitutes the actor's id
    }
  }

  if (BINARY_OPERATORS.has(op)) {
    const range = { gte: value, lte: value2 };
    return op === 'between' ? range : { not: range };
  }

  if (LIST_OPERATORS.has(op)) {
    const list = Array.isArray(value) ? value : [value];
    return op === 'in' ? { in: list } : { notIn: list };
  }

  switch (op) {
    case 'eq':          return value;
    case 'ne':          return { not: value };
    case 'contains':    return { contains: String(value), mode: 'insensitive' };
    case 'notContains': return { not: { contains: String(value), mode: 'insensitive' } };
    case 'startsWith':  return { startsWith: String(value), mode: 'insensitive' };
    case 'endsWith':    return { endsWith: String(value), mode: 'insensitive' };
    case 'gt':          return { gt: value };
    case 'lt':          return { lt: value };
    case 'gte':         return { gte: value };
    case 'lte':         return { lte: value };
    case 'on':          return dateWindow('today', value, new Date(value as string));
    case 'before':      return { lt: value };
    case 'after':       return { gt: value };
    case 'lastNDays':
    case 'nextNDays':   return dateWindow(op, value, now);
    default:
      throw new Error(`Unsupported operator: ${op}`);
  }
}

export interface CompileOptions {
  /** resolves a field key to its physical location. Throws on unknown keys. */
  resolve: (fieldKey: string) => FieldLocation;
  /** injected for testability — never call Date.now() inline */
  now?: Date;
  /**
   * The ORM's "this JSON path is absent OR holds a JSON null" sentinel —
   * `Prisma.AnyNull`. REQUIRED, and deliberately not defaulted.
   *
   * A plain `null` here does not mean what it reads as. Postgres distinguishes
   * a missing JSONB key (`#>` yields SQL NULL) from a stored JSON `null`, and
   * Prisma exposes that split as DbNull / JsonNull. `equals: null` compiles to
   * the JsonNull half only, so `isEmpty` on a custom field matched ZERO rows —
   * every record that simply never had the field set was invisible to the one
   * filter meant to find them. It is a silent wrong answer, not an error.
   *
   * This package must not import Prisma (framework-agnostic, per CLAUDE.md's
   * layout), so the sentinel is injected. It has no default because a
   * forgotten default is exactly how the bug came back.
   */
  jsonAnyNull: unknown;
  /**
   * Is this real column NULLABLE in the database?
   *
   * Optional, and "assume nullable" is the safe default because that is what
   * every previous caller assumed. Supplying it fixes a 500: Prisma refuses
   * `null` in ANY form — bare, `equals`, or `not` — against a NOT NULL scalar
   * ("Argument `phone` is missing"), so "is empty" on a required column was a
   * crashed request rather than an answer. The operator is legal for the type,
   * the rail offers it, and there is no way for a user to know which columns
   * are required.
   */
  columnIsNullable?: (column: string) => boolean;
}

/**
 * The two constant answers, as WHERE objects rather than as `{}` / absent.
 *
 * `compileFilter` drops empty children from a group, so a tautology written as
 * `{}` inside an OR would vanish and quietly narrow the branch. Both of these
 * are non-empty, parameterised, and true on every table — every model has an
 * `id`.
 */
const MATCH_NONE: PrismaWhere = { id: { in: [] as string[] } };
const MATCH_ALL: PrismaWhere = { NOT: { id: { in: [] as string[] } } };

/** Does this comparison ask "is (not) null"? The only two an isEmpty produces. */
function nullTest(cmp: unknown): 'isNull' | 'isNotNull' | null {
  if (cmp === null) return 'isNull';
  if (typeof cmp === 'object' && cmp !== null) {
    const keys = Object.keys(cmp as object);
    if (keys.length === 1 && keys[0] === 'not' && (cmp as { not: unknown }).not === null) {
      return 'isNotNull';
    }
  }
  return null;
}

export function compileFilter(node: FilterNode | undefined, opts: CompileOptions): PrismaWhere {
  if (!node) return {};
  const now = opts.now ?? new Date();

  if (isGroup(node)) {
    const children = node.children
      .map((c) => compileFilter(c, opts))
      .filter((w) => Object.keys(w).length > 0);
    if (children.length === 0) return {};
    if (children.length === 1) return children[0]!;
    return node.op === 'AND' ? { AND: children } : { OR: children };
  }

  const loc = opts.resolve(node.fieldKey); // throws on unknown key — deliberate
  const cmp = comparison(node, now);

  // real column → direct comparison, hits the btree index
  if (loc.column) {
    // A NOT NULL column is never null, so the question has a constant answer
    // and the database never needs to be asked. Answering it here is not an
    // optimisation — see `columnIsNullable`, the alternative is a 500.
    //
    // Note this reads the column's nullability, NOT `FieldDefinition
    // .isRequired`: an Admin can clear "required" without a migration, and the
    // column would still be NOT NULL underneath. Only the database's own
    // answer is safe to compile against.
    const test = nullTest(cmp);
    if (test && opts.columnIsNullable && !opts.columnIsNullable(loc.column)) {
      return test === 'isNull' ? MATCH_NONE : MATCH_ALL;
    }
    return { [loc.column]: cmp };
  }

  // JSONB path. Prisma's JSON filters are narrower than column filters, so we
  // express equality/containment via `path` and fall back to raw-safe forms.
  return {
    [loc.jsonColumn]: { path: [loc.key], ...asJsonFilter(cmp, opts.jsonAnyNull) },
  };
}

/**
 * Map a column-style comparison onto Prisma's JSON filter vocabulary.
 *
 * `anyNull` replaces every plain `null` that reaches this layer. On a real
 * column `null` means "no value" and Postgres agrees; on a JSONB path it means
 * only "a stored JSON null", which is not the same set — see `jsonAnyNull`.
 * Substituting it in both the `equals` (isEmpty) and `not` (isNotEmpty) forms
 * is what keeps the two exact complements of each other.
 */
function asJsonFilter(cmp: unknown, anyNull: unknown): Record<string, unknown> {
  if (cmp === null) return { equals: anyNull };
  if (typeof cmp !== 'object') return { equals: cmp };

  const o = cmp as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    switch (k) {
      case 'contains':   out['string_contains'] = v; break;
      case 'startsWith': out['string_starts_with'] = v; break;
      case 'endsWith':   out['string_ends_with'] = v; break;
      case 'in':         out['array_contains'] = v; break;
      case 'not':        out['not'] = v === null ? anyNull : v; break;
      default:           out[k] = v;
    }
  }
  return out;
}
