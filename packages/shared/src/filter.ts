import type { FieldType, Operator } from './field-types.js';

/**
 * The filter tree. Arbitrary AND/OR nesting.
 * NEVER string-concatenated into SQL — this is user input.
 */
export type FilterNode = FilterGroup | FilterCondition;

export interface FilterGroup {
  op: 'AND' | 'OR';
  children: FilterNode[];
}

export interface FilterCondition {
  fieldKey: string;
  fieldType: FieldType;
  operator: Operator;
  value?: unknown;
  /** second value, for between / notBetween */
  value2?: unknown;
}

export const isGroup = (n: FilterNode): n is FilterGroup =>
  (n as FilterGroup).children !== undefined;

export interface SortSpec { fieldKey: string; direction: 'asc' | 'desc' }

export interface ColumnSpec {
  fieldKey: string;
  width?: number;
  pinned?: 'left' | 'right';
  order: number;
}

export interface ViewSpec {
  columns: ColumnSpec[];
  filters?: FilterNode;
  sort?: SortSpec[];
}

/** Walk every condition in a tree — used by the dependency checker. */
export function collectFieldKeys(node: FilterNode | undefined, out = new Set<string>()): Set<string> {
  if (!node) return out;
  if (isGroup(node)) { node.children.forEach((c) => collectFieldKeys(c, out)); }
  else out.add(node.fieldKey);
  return out;
}
