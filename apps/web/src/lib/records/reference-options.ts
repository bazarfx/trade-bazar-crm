/**
 * Options for the dropdowns whose choices live in a CONFIG TABLE rather than
 * in `PicklistOption`.
 *
 * The status column already works this way — the list substitutes the
 * module's `Status` rows for its (empty) option list — but the user module's
 * role and department columns never got the same treatment, so the Users
 * screen rendered `985a771c-3521-…` where it should say "Senior Tele Sales".
 *
 * Keyed by the PHYSICAL COLUMN, never by module slug: any module whose field
 * maps onto one of these columns resolves the same way, and a module created
 * tomorrow with a `departmentId` column needs nothing here.
 */
import 'server-only';
import { prisma } from '@crm/db';

export interface ReferenceOption {
  value: string;
  label: string;
}

type Loader = () => Promise<ReferenceOption[]>;

const LOADERS: Record<string, Loader> = {
  roleId: async () =>
    (
      await prisma.role.findMany({
        where: { isDeleted: false },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      })
    ).map((r) => ({ value: r.id, label: r.name })),

  departmentId: async () =>
    (
      await prisma.department.findMany({
        where: { isDeleted: false },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      })
    ).map((d) => ({ value: d.id, label: d.name })),
};

/**
 * field key → options, for every field on the page whose system column is
 * reference-backed. One query per distinct column, not per field.
 */
export async function referenceOptionsFor(
  fields: ReadonlyArray<{ key: string; systemColumn: string | null }>,
): Promise<Map<string, ReferenceOption[]>> {
  const out = new Map<string, ReferenceOption[]>();
  const byColumn = new Map<string, string[]>();

  for (const f of fields) {
    if (f.systemColumn && LOADERS[f.systemColumn]) {
      byColumn.set(f.systemColumn, [...(byColumn.get(f.systemColumn) ?? []), f.key]);
    }
  }

  await Promise.all(
    [...byColumn].map(async ([column, keys]) => {
      const options = await LOADERS[column]!();
      for (const key of keys) out.set(key, options);
    }),
  );

  return out;
}
