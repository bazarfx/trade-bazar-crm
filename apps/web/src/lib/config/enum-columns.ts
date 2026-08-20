/**
 * Some system columns are backed by a Postgres enum rather than free text —
 * `Lead.source` is the only one today, carrying `LeadSource`.
 *
 * That creates the one place in this product where an Admin CAN reach a wall:
 * a picklist option whose value the enum does not contain is accepted at
 * config time and then fails at INSERT time, so every record using it dies on
 * save. The prime directive says adding a customer-visible option must never
 * need a migration — for these columns it does, and the honest answer is to
 * refuse the option up front with an explanation rather than let an Admin
 * create a broken one and discover it days later on a lead they cannot save.
 *
 * Derived from the Prisma DMMF so a future enum-backed column is covered
 * automatically and no list here can drift from the schema.
 */
import 'server-only';
import { Prisma } from '@crm/db';

/** column name -> the values its enum permits, per Prisma model. */
const enumColumnsByModel = new Map<string, Map<string, string[]>>();

for (const model of Prisma.dmmf.datamodel.models) {
  const columns = new Map<string, string[]>();
  for (const field of model.fields) {
    if (field.kind !== 'enum') continue;
    const values = Prisma.dmmf.datamodel.enums
      .find((e) => e.name === field.type)
      ?.values.map((v) => v.name);
    if (values) columns.set(field.name, values);
  }
  if (columns.size > 0) enumColumnsByModel.set(model.name.toLowerCase(), columns);
}

/**
 * The values a system column accepts, or null when it is not enum-backed.
 * `delegateName` is the Prisma delegate ('lead', 'deal', 'record', ...) —
 * resolved through StorageResolver by the caller, never from a module slug.
 */
export function enumValuesFor(delegateName: string, systemColumn: string | null): string[] | null {
  if (!systemColumn) return null;
  return enumColumnsByModel.get(delegateName.toLowerCase())?.get(systemColumn) ?? null;
}

/** True when this column's accepted values are fixed by the schema. */
export const isEnumBackedColumn = (delegateName: string, systemColumn: string | null): boolean =>
  enumValuesFor(delegateName, systemColumn) !== null;
