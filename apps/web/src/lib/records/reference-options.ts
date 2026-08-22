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

/**
 * Retired rows are loaded TOO, and labelled as such. Soft delete (invariant 4)
 * keeps a user's `departmentId` and a lead's `groupId` pointing at a retired
 * row on purpose — restore brings the team back intact — so a live row can
 * legitimately reference one. Dropping those from the option list is what
 * made the Users screen print a raw uuid the moment an Admin retired a
 * department; the list must stay readable, and "Sales Floor (retired)" is
 * what the Admin can act on. Live rows sort first so a picker leads with the
 * choices that still accept new members.
 */
const RETIRED_SUFFIX = ' (retired)';

function toOptions(rows: ReadonlyArray<{ id: string; name: string; isDeleted: boolean }>): ReferenceOption[] {
  return [...rows]
    .sort((a, b) => Number(a.isDeleted) - Number(b.isDeleted) || a.name.localeCompare(b.name))
    .map((r) => ({ value: r.id, label: r.isDeleted ? `${r.name}${RETIRED_SUFFIX}` : r.name }));
}

const REF_SELECT = { id: true, name: true, isDeleted: true } as const;

const LOADERS: Record<string, Loader> = {
  // Group and campaign links are RECORD_LINK fields, but their targets are
  // small config/core tables a name lookup covers outright — the generic
  // cross-module record resolver the cell renderer defers to does not exist
  // yet, and an Admin reading "f257f831-7a13-…" under Group cannot act on it.
  groupId: async () => toOptions(await prisma.group.findMany({ select: REF_SELECT })),

  campaignId: async () => toOptions(await prisma.campaign.findMany({ select: REF_SELECT })),

  roleId: async () => toOptions(await prisma.role.findMany({ select: REF_SELECT })),

  departmentId: async () => toOptions(await prisma.department.findMany({ select: REF_SELECT })),
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
