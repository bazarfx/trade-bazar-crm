import type { LayoutSpec } from '@crm/shared';

/**
 * Layout reconciliation.
 *
 * A saved layout is a SNAPSHOT of field ids — a hint, never the truth. The
 * field list is the truth. Reconciling at read time guarantees the two
 * classic layout-system failures cannot happen here:
 *
 *   1. a field created after the layout was saved is NEVER invisible — it is
 *      appended to its own FormSection (or the last section);
 *   2. a soft-deleted field NEVER renders, even if a stale layout lists it.
 *
 * Fields the actor may not see are stripped by the CALLER (PermissionEngine)
 * before this runs — a hidden field must never even reach the resolver.
 */

export interface ResolvableField {
  id: string;
  key: string;
  sectionId: string | null;
  displayOrder: number;
  isDeleted: boolean;
}

export interface ResolvableSection {
  id: string;
  label: string;
  columns: number;
  displayOrder: number;
  isDeleted: boolean;
}

export interface ResolvedSection {
  sectionId: string;
  label: string;
  columns: number;
  fields: { fieldId: string; key: string; colSpan: number }[];
}

export function resolveLayout(
  fields: ResolvableField[],
  sections: ResolvableSection[],
  spec: LayoutSpec | null,
): ResolvedSection[] {
  const liveFields = new Map(fields.filter((f) => !f.isDeleted).map((f) => [f.id, f]));
  const liveSections = sections
    .filter((s) => !s.isDeleted)
    .sort((a, b) => a.displayOrder - b.displayOrder);

  const out: ResolvedSection[] = [];
  const bySection = new Map<string, ResolvedSection>();
  for (const s of liveSections) {
    const row: ResolvedSection = { sectionId: s.id, label: s.label, columns: s.columns, fields: [] };
    out.push(row);
    bySection.set(s.id, row);
  }
  // records with no sections still render: one implicit section
  if (out.length === 0) {
    const implicit: ResolvedSection = { sectionId: '', label: '', columns: 3, fields: [] };
    out.push(implicit);
  }

  const placed = new Set<string>();

  // 1. place what the layout lists — skipping deleted fields and dead sections
  if (spec) {
    for (const sec of spec.sections) {
      const target = bySection.get(sec.sectionId) ?? out[0]!;
      for (const ref of sec.fields) {
        const f = liveFields.get(ref.fieldId);
        if (!f || placed.has(f.id)) continue;
        target.fields.push({ fieldId: f.id, key: f.key, colSpan: ref.colSpan ?? 1 });
        placed.add(f.id);
      }
    }
  }

  // 2. append every live field the layout does not know about
  const orphans = [...liveFields.values()]
    .filter((f) => !placed.has(f.id))
    .sort((a, b) => a.displayOrder - b.displayOrder);
  for (const f of orphans) {
    const target = (f.sectionId && bySection.get(f.sectionId)) || out[out.length - 1]!;
    target.fields.push({ fieldId: f.id, key: f.key, colSpan: 1 });
  }

  return out;
}
