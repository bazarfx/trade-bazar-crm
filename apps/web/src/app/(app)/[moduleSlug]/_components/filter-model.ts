import {
  BINARY_OPERATORS,
  FIELD_TYPE_SPECS,
  LIST_OPERATORS,
  NULLARY_OPERATORS,
  isGroup,
  type FieldType,
  type FilterCondition,
  type FilterNode,
  type Operator,
} from '@crm/shared';

/**
 * What the filter rail edits, and how it becomes a `FilterNode`.
 *
 * The rail holds RAW INPUT — the strings an `<input>` actually contains — and
 * converts to wire values only on Apply. Converting on every keystroke would
 * mean a half-typed number ("-") or a half-typed date ("2026-08") repeatedly
 * becoming NaN or an Invalid Date in state, and the difference between "not
 * filled in yet" and "filled in wrongly" would be lost exactly when the rail
 * needs to tell the user which one it is.
 *
 * Nothing in this file names a field, a module or a status. Every decision is
 * made from the field's TYPE through `FIELD_TYPE_SPECS`, which is the operator
 * registry (spec §10) — so a field type added next year gets a working filter
 * row the moment its entry exists, with nothing here to edit.
 */

export interface DraftCondition {
  fieldKey: string;
  fieldType: FieldType;
  operator: Operator;
  /** the single value, or the lower bound of a between */
  value: string;
  /** the upper bound of a between */
  value2: string;
  /** the chosen options, for `is any of` / `is none of` */
  values: string[];
}

/**
 * Plain-language operator names, ONE per operator rather than one per
 * (type, operator) pair.
 *
 * Spec §10's table prints `=` for numbers and "is" for text, which are the
 * same `eq`. Splitting the labels on type would mean a second registry to keep
 * in step with the first, and the words below read correctly against every
 * type that declares them — "is", "greater than", "before" all say the right
 * thing whether the field holds a name, an amount or a date.
 *
 * Exhaustive `Record` on purpose: adding an operator to the registry without
 * giving it a human name becomes a compile error rather than a select showing
 * "notContains" to a salesperson.
 */
export const OPERATOR_LABELS: Record<Operator, string> = {
  eq: 'is',
  ne: 'is not',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  gt: 'greater than',
  lt: 'less than',
  gte: 'at least',
  lte: 'at most',
  between: 'between',
  notBetween: 'not between',
  on: 'on',
  before: 'before',
  after: 'after',
  lastNDays: 'in the last (days)',
  nextNDays: 'in the next (days)',
  today: 'today',
  thisWeek: 'this week',
  thisMonth: 'this month',
  in: 'is any of',
  notIn: 'is none of',
  isMe: 'is me',
  isTrue: 'is checked',
  isFalse: 'is not checked',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
};

/** Which control the value side of a row draws. Decided by type + operator. */
export type ValueControl = 'none' | 'text' | 'number' | 'days' | 'date' | 'datetime' | 'select' | 'multi' | 'range';

export function valueControlFor(type: FieldType, operator: Operator): ValueControl {
  // Nullary operators carry their whole meaning in the operator itself —
  // "is empty", "today", "is checked". A value box beside one of those is a
  // box whose contents are ignored, which is worse than no box.
  if (NULLARY_OPERATORS.has(operator)) return 'none';
  if (operator === 'lastNDays' || operator === 'nextNDays') return 'days';
  if (LIST_OPERATORS.has(operator)) return 'multi';

  const storage = FIELD_TYPE_SPECS[type].storage;
  if (BINARY_OPERATORS.has(operator)) return 'range';
  if (storage === 'number') return 'number';
  if (storage === 'date') return type === 'DATE_TIME' ? 'datetime' : 'date';
  // A picklist, a status or a user field compares against a chosen id, so the
  // control is a picker whenever the caller could resolve one. Whether options
  // EXIST is the rail's question, not this one's — it falls back to text.
  if (FIELD_TYPE_SPECS[type].hasOptions || type === 'USER_LOOKUP' || type === 'RECORD_LINK') {
    return 'select';
  }
  return 'text';
}

/** A new row for a field: the first operator its type declares. */
export function newDraft(fieldKey: string, type: FieldType): DraftCondition {
  const operators = FIELD_TYPE_SPECS[type].operators;
  const first = operators[0];
  // A type with no operators is not filterable and the rail never lists it;
  // `isEmpty` is the honest fallback rather than a non-null assertion.
  return {
    fieldKey,
    fieldType: type,
    operator: first ?? 'isEmpty',
    value: '',
    value2: '',
    values: [],
  };
}

/**
 * Why this row cannot be applied yet, or null when it can.
 *
 * An incomplete row is NOT dropped on Apply. Dropping a condition widens the
 * result set — the documented reason the compiler throws on an unknown key —
 * and a filter that quietly matches more rows than it displays is the same
 * bug wearing friendlier clothes. So an incomplete row blocks the Apply and
 * says which one it is.
 */
export function draftError(draft: DraftCondition): string | null {
  const control = valueControlFor(draft.fieldType, draft.operator);
  switch (control) {
    case 'none':
      return null;
    case 'multi':
      return draft.values.length === 0 ? 'Choose at least one option' : null;
    case 'range':
      if (draft.value.trim() === '' || draft.value2.trim() === '') return 'Both bounds are needed';
      return rangeOrderError(draft);
    case 'days': {
      const n = Number(draft.value);
      return Number.isInteger(n) && n >= 0 ? null : 'Enter a whole number of days';
    }
    case 'number':
      return Number.isFinite(Number(draft.value)) && draft.value.trim() !== ''
        ? null
        : 'Enter a number';
    default:
      return draft.value.trim() === '' ? 'Enter a value' : null;
  }
}

/** A between whose bounds are the wrong way round matches nothing, silently. */
function rangeOrderError(draft: DraftCondition): string | null {
  const storage = FIELD_TYPE_SPECS[draft.fieldType].storage;
  if (storage === 'number') {
    const from = Number(draft.value);
    const to = Number(draft.value2);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return 'Enter two numbers';
    return from <= to ? null : 'The first value must be the lower one';
  }
  return draft.value <= draft.value2 ? null : 'The first date must be the earlier one';
}

/**
 * Raw input -> the value the compiler expects.
 *
 * Types matter here in a way they do not in the UI: Prisma compares a JSONB
 * number against a number and a `DateTime` column against a real timestamp, so
 * a string that merely looks numeric matches nothing. Dates leave as full ISO
 * — `2026-08-20` alone is not an ISO-8601 instant, and a `datetime-local`
 * value is in the user's own timezone until `toISOString` moves it.
 */
function coerce(type: FieldType, raw: string): unknown {
  const storage = FIELD_TYPE_SPECS[type].storage;
  if (storage === 'number') return Number(raw);
  if (storage === 'date') {
    if (type === 'DATE_TIME') {
      const at = new Date(raw);
      return Number.isNaN(at.getTime()) ? raw : at.toISOString();
    }
    // A plain DATE is a calendar day, read in UTC so the same link selects the
    // same day for a reader in Mumbai and one in London.
    return `${raw}T00:00:00.000Z`;
  }
  return raw;
}

/** One row as the wire wants it. Call only on a row `draftError` cleared. */
export function conditionFrom(draft: DraftCondition): FilterCondition {
  const base = {
    fieldKey: draft.fieldKey,
    fieldType: draft.fieldType,
    operator: draft.operator,
  };
  const control = valueControlFor(draft.fieldType, draft.operator);

  switch (control) {
    case 'none':
      // No `value` key at all, not an empty one: `undefined` is what the
      // schema's arity check reads as "this operator takes no value".
      return base;
    case 'multi':
      return { ...base, value: draft.values };
    case 'range':
      return {
        ...base,
        value: coerce(draft.fieldType, draft.value),
        value2: coerce(draft.fieldType, draft.value2),
      };
    case 'days':
      return { ...base, value: Number(draft.value) };
    default:
      return { ...base, value: coerce(draft.fieldType, draft.value) };
  }
}

/**
 * The rail's rows as one tree.
 *
 * An AND of the active conditions — the default the design implies, and the
 * only combination its checkbox-per-field rail can express. Deeper AND/OR
 * nesting is what `FilterNode` and the compiler already support and what a
 * later "advanced filter" surface will build; the rail never invents an OR
 * the user did not ask for.
 */
export function treeFrom(drafts: DraftCondition[]): FilterNode | null {
  if (drafts.length === 0) return null;
  return { op: 'AND', children: drafts.map(conditionFrom) };
}

// ── the other direction: a stored tree back into rows ─────────────────────

export interface DraftsFromTree {
  drafts: DraftCondition[];
  /**
   * False when the tree holds nesting or an OR the rail cannot draw. The rows
   * are still shown — a filter you cannot see is worse than one you cannot
   * edit — but the rail says that re-applying them will flatten the tree,
   * because it would.
   */
  exact: boolean;
}

/** Wire value -> the string an input holds. The inverse of `coerce`. */
function uncoerce(type: FieldType, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (FIELD_TYPE_SPECS[type].storage === 'date' && typeof value === 'string') {
    // `2026-08-20T00:00:00.000Z` -> `2026-08-20`, or `2026-08-20T09:30` for a
    // datetime input, which is the only shape those two controls accept.
    return type === 'DATE_TIME' ? value.slice(0, 16) : value.slice(0, 10);
  }
  return String(value);
}

function draftFrom(condition: FilterCondition): DraftCondition {
  const values = Array.isArray(condition.value) ? condition.value.map(String) : [];
  return {
    fieldKey: condition.fieldKey,
    fieldType: condition.fieldType,
    operator: condition.operator,
    value: Array.isArray(condition.value) ? '' : uncoerce(condition.fieldType, condition.value),
    value2: uncoerce(condition.fieldType, condition.value2),
    values,
  };
}

/**
 * Load a saved view's filter (or a link's) into the rail.
 *
 * Only ONE row per field survives: the rail is a field list, so two conditions
 * on the same field have nowhere to both live. The first wins and `exact` goes
 * false, which is what stops the rail from silently rewriting a filter it only
 * half understood.
 */
export function draftsFrom(node: FilterNode | null): DraftsFromTree {
  if (node === null) return { drafts: [], exact: true };

  const drafts: DraftCondition[] = [];
  const seen = new Set<string>();
  let exact = true;

  const walk = (n: FilterNode, depth: number): void => {
    if (isGroup(n)) {
      // A nested group, or an OR, is more than a flat list of ANDed rows.
      if (depth > 0 || n.op !== 'AND') exact = false;
      n.children.forEach((child) => walk(child, depth + 1));
      return;
    }
    if (seen.has(n.fieldKey)) {
      exact = false;
      return;
    }
    seen.add(n.fieldKey);
    drafts.push(draftFrom(n));
  };

  walk(node, 0);
  return { drafts, exact };
}
