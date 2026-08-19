/**
 * The field type registry — the single source of truth for what a field type
 * IS, how it validates, how it filters, and how it stores.
 *
 * Adding a field type means adding ONE entry here plus one renderer component.
 * Nothing else in the codebase changes. If you find yourself editing a switch
 * statement elsewhere, that switch is a bug.
 */

export const FIELD_TYPES = [
  'SINGLE_LINE', 'MULTI_LINE', 'EMAIL', 'PHONE',
  'NUMBER', 'DECIMAL', 'CURRENCY', 'PERCENT',
  'DROPDOWN', 'MULTI_SELECT', 'LANGUAGE_PICKER',
  'DATE', 'DATE_TIME', 'CHECKBOX', 'TOGGLE',
  'URL', 'FILE', 'IMAGE', 'USER_LOOKUP', 'RECORD_LINK',
  'FORMULA', 'AUTONUMBER',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** Every operator the platform supports. Filters are built from these. */
export const OPERATORS = [
  'eq', 'ne', 'contains', 'notContains', 'startsWith', 'endsWith',
  'gt', 'lt', 'gte', 'lte', 'between', 'notBetween',
  'on', 'before', 'after', 'lastNDays', 'nextNDays', 'today', 'thisWeek', 'thisMonth',
  'in', 'notIn', 'isMe',
  'isTrue', 'isFalse',
  'isEmpty', 'isNotEmpty',
] as const;

export type Operator = (typeof OPERATORS)[number];

/** How a value is physically stored for a core module. */
export type StorageKind = 'text' | 'number' | 'boolean' | 'date' | 'json' | 'array';

export interface FieldTypeSpec {
  /** shown in the drag-and-drop field builder palette */
  label: string;
  storage: StorageKind;
  /** operators derived automatically — never configured by hand */
  operators: readonly Operator[];
  /** does this type carry a picklist of options? */
  hasOptions: boolean;
  /** can the admin mark it unique? */
  canBeUnique: boolean;
  /** computed server-side, not user-editable */
  isDerived: boolean;
  /** included in the module's full-text search vector */
  searchable: boolean;
}

const TEXT_OPS = ['eq', 'ne', 'contains', 'notContains', 'startsWith', 'endsWith', 'isEmpty', 'isNotEmpty'] as const;
const NUM_OPS = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'between', 'notBetween', 'isEmpty', 'isNotEmpty'] as const;
const DATE_OPS = ['on', 'before', 'after', 'between', 'notBetween', 'lastNDays', 'nextNDays', 'today', 'thisWeek', 'thisMonth', 'isEmpty', 'isNotEmpty'] as const;
const PICK_OPS = ['eq', 'ne', 'in', 'notIn', 'isEmpty', 'isNotEmpty'] as const;
const BOOL_OPS = ['isTrue', 'isFalse'] as const;
const REF_OPS = ['eq', 'ne', 'in', 'notIn', 'isMe', 'isEmpty', 'isNotEmpty'] as const;

export const FIELD_TYPE_SPECS: Record<FieldType, FieldTypeSpec> = {
  SINGLE_LINE:     { label: 'Single Line',     storage: 'text',    operators: TEXT_OPS, hasOptions: false, canBeUnique: true,  isDerived: false, searchable: true  },
  MULTI_LINE:      { label: 'Multi Line',      storage: 'text',    operators: TEXT_OPS, hasOptions: false, canBeUnique: false, isDerived: false, searchable: true  },
  EMAIL:           { label: 'Email',           storage: 'text',    operators: TEXT_OPS, hasOptions: false, canBeUnique: true,  isDerived: false, searchable: true  },
  PHONE:           { label: 'Phone',           storage: 'text',    operators: TEXT_OPS, hasOptions: false, canBeUnique: true,  isDerived: false, searchable: true  },
  NUMBER:          { label: 'Number',          storage: 'number',  operators: NUM_OPS,  hasOptions: false, canBeUnique: true,  isDerived: false, searchable: false },
  DECIMAL:         { label: 'Decimal',         storage: 'number',  operators: NUM_OPS,  hasOptions: false, canBeUnique: false, isDerived: false, searchable: false },
  CURRENCY:        { label: 'Currency',        storage: 'number',  operators: NUM_OPS,  hasOptions: false, canBeUnique: false, isDerived: false, searchable: false },
  PERCENT:         { label: 'Percent',         storage: 'number',  operators: NUM_OPS,  hasOptions: false, canBeUnique: false, isDerived: false, searchable: false },
  DROPDOWN:        { label: 'Dropdown',        storage: 'text',    operators: PICK_OPS, hasOptions: true,  canBeUnique: false, isDerived: false, searchable: true  },
  MULTI_SELECT:    { label: 'Multi-Select',    storage: 'array',   operators: PICK_OPS, hasOptions: true,  canBeUnique: false, isDerived: false, searchable: true  },
  LANGUAGE_PICKER: { label: 'Language Picker', storage: 'array',   operators: PICK_OPS, hasOptions: true,  canBeUnique: false, isDerived: false, searchable: true  },
  DATE:            { label: 'Date',            storage: 'date',    operators: DATE_OPS, hasOptions: false, canBeUnique: false, isDerived: false, searchable: false },
  DATE_TIME:       { label: 'Date & Time',     storage: 'date',    operators: DATE_OPS, hasOptions: false, canBeUnique: false, isDerived: false, searchable: false },
  CHECKBOX:        { label: 'Checkbox',        storage: 'boolean', operators: BOOL_OPS, hasOptions: false, canBeUnique: false, isDerived: false, searchable: false },
  TOGGLE:          { label: 'Toggle',          storage: 'boolean', operators: BOOL_OPS, hasOptions: false, canBeUnique: false, isDerived: false, searchable: false },
  URL:             { label: 'URL',             storage: 'text',    operators: TEXT_OPS, hasOptions: false, canBeUnique: false, isDerived: false, searchable: true  },
  FILE:            { label: 'File Upload',     storage: 'json',    operators: ['isEmpty', 'isNotEmpty'], hasOptions: false, canBeUnique: false, isDerived: false, searchable: false },
  IMAGE:           { label: 'Image Upload',    storage: 'json',    operators: ['isEmpty', 'isNotEmpty'], hasOptions: false, canBeUnique: false, isDerived: false, searchable: false },
  USER_LOOKUP:     { label: 'User Lookup',     storage: 'text',    operators: REF_OPS,  hasOptions: false, canBeUnique: false, isDerived: false, searchable: false },
  RECORD_LINK:     { label: 'Record Link',     storage: 'text',    operators: REF_OPS,  hasOptions: false, canBeUnique: false, isDerived: false, searchable: false },
  FORMULA:         { label: 'Formula',         storage: 'text',    operators: TEXT_OPS, hasOptions: false, canBeUnique: false, isDerived: true,  searchable: false },
  AUTONUMBER:      { label: 'Auto-Number',     storage: 'text',    operators: TEXT_OPS, hasOptions: false, canBeUnique: true,  isDerived: true,  searchable: true  },
};

export function operatorsFor(type: FieldType): readonly Operator[] {
  return FIELD_TYPE_SPECS[type].operators;
}

/** Operators that take no value (the UI hides the value input). */
export const NULLARY_OPERATORS = new Set<Operator>([
  'isEmpty', 'isNotEmpty', 'isTrue', 'isFalse', 'today', 'thisWeek', 'thisMonth', 'isMe',
]);

/** Operators that take two values. */
export const BINARY_OPERATORS = new Set<Operator>(['between', 'notBetween']);

/** Operators that take a list. */
export const LIST_OPERATORS = new Set<Operator>(['in', 'notIn']);
