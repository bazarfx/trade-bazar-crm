import {
  FIELD_TYPE_SPECS,
  mappedColumns,
  type ImportColumnMapping,
  type ImportMapping,
} from '@crm/shared';
import type { ModuleField } from './wire';

/**
 * Stage 4's arithmetic: which columns are mapped, which required fields
 * nothing feeds, and which fields can be matched on.
 *
 * Every rule in this file MIRRORS one the commit enforces server-side
 * (`assertRequiredCovered`, the dedupe checks in `lib/imports/service.ts`).
 * That duplication is deliberate and bounded: the server is the authority and
 * answers 422, but a 422 arrives after five stages of work, and the person who
 * has to fix it is looking at the mapping table right now. What must never
 * happen is the reverse — this file being LOOSER than the server, which would
 * offer a mapping that always fails. So each rule below says which server
 * check it shadows.
 */

/**
 * Physical columns the record engine fills for itself, so a required field
 * pointing at one needs no column in the file.
 *
 * Mirrors the commit's `engineFilled` set, which is built from
 * `shape.ownerColumn / groupColumn / statusColumn / createdByColumn`. Every
 * storage shape names those columns identically, which is why the four
 * literals below are safe — and they are COLUMNS, never field keys, labels or
 * module slugs, exactly as `cell.tsx` keys the status chip and
 * `record-form-screen.tsx` keys the owner. An Admin renaming "Lead Owner" to
 * "Relationship Manager" changes nothing here.
 */
const ENGINE_FILLED_COLUMNS: ReadonlySet<string> = new Set([
  'ownerId',
  'groupId',
  'statusId',
  'createdById',
]);

/** A column that will actually be written. The one definition, shared with the
 *  worker through `mappedColumns` — skip WINS over a remembered field. */
export function isMapped(column: ImportColumnMapping): boolean {
  return !column.skip && column.field !== null;
}

export function columnOf(mapping: ImportMapping, name: string): ImportColumnMapping | undefined {
  return mapping.columns.find((c) => c.column === name);
}

/** Field keys already claimed, so the picker can refuse to offer one twice —
 *  `importMappingSchema` rejects two columns feeding one field outright. */
export function claimedFields(mapping: ImportMapping): Map<string, string> {
  const claimed = new Map<string, string>();
  for (const column of mappedColumns(mapping)) {
    if (column.field !== null) claimed.set(column.field, column.column);
  }
  return claimed;
}

/** Replace one column's instructions, in file order. Immutable so React sees a
 *  new object and the tab counts recompute. */
export function patchColumn(
  mapping: ImportMapping,
  name: string,
  patch: Partial<ImportColumnMapping>,
): ImportMapping {
  return {
    columns: mapping.columns.map((c) => (c.column === name ? { ...c, ...patch } : c)),
  };
}

/**
 * Required fields nothing feeds — the warning that stops the commit's 422.
 *
 * Shadows `assertRequiredCovered`: satisfied by a mapped column, by that
 * column's default for empty cells, by the field's own configured default, or
 * by being a column the engine fills. `catalogue` is already the importable,
 * permitted set (see `ImportWizard`), so a required FILE field — which no
 * spreadsheet can feed and which the server also excludes — never appears.
 */
export function requiredGaps(
  catalogue: readonly ModuleField[],
  mapping: ImportMapping,
  systemColumns: Record<string, string | null>,
): ModuleField[] {
  const fed = new Set<string>();
  for (const column of mappedColumns(mapping)) {
    if (column.field !== null) fed.add(column.field);
  }

  return catalogue.filter((field) => {
    if (!field.isRequired || fed.has(field.key)) return false;
    if (field.defaultValue !== null && field.defaultValue !== undefined) return false;
    const column = systemColumns[field.key];
    return !(typeof column === 'string' && ENGINE_FILLED_COLUMNS.has(column));
  });
}

/**
 * Whether existing records can be matched on this field.
 *
 * Shadows the commit's check that the dedupe field's type carries an `eq`
 * operator — a MULTI_LINE note cannot identify a record, and offering it would
 * be offering a run that 422s. The operator registry decides, so a field type
 * added next year is answered without touching this file.
 */
export function canMatchOn(field: ModuleField): boolean {
  return FIELD_TYPE_SPECS[field.type].operators.includes('eq');
}

/** The first few values this column actually holds, for the mapper to look at
 *  before deciding what it is. Empty cells are skipped — a column whose first
 *  row is blank is exactly the one you need a sample of. */
export function sampleValues(
  sample: readonly Record<string, string>[],
  column: string,
  take = 3,
): string[] {
  const values: string[] = [];
  for (const row of sample) {
    const value = row[column];
    if (typeof value === 'string' && value.trim() !== '') values.push(value.trim());
    if (values.length === take) break;
  }
  return values;
}
