import type { LayoutSpec } from '@crm/shared';

/**
 * The editor's draft model, plus the client-side reconcile that builds it.
 *
 * The reconcile deliberately mirrors resolveLayout() in @crm/core: what the
 * admin sees before Save is exactly what the form renderer would resolve from
 * the same saved spec, so publishing never "moves" a field the admin did not
 * move. Two consequences fall out of that, same as on the server:
 *
 *   1. a field the spec does not know about appends to its OWN section
 *      (falling back to the last one), so new fields are never invisible;
 *   2. a spec entry pointing at a deleted field or a dead section drops out
 *      or re-homes to the first section — a stale layout cannot resurrect
 *      retired config.
 */

/** The slice of FieldDto the editor actually reads. */
export interface EditorField {
  id: string;
  key: string;
  label: string;
  type: string;
  sectionId: string | null;
  displayOrder: number;
  isDeleted: boolean;
  isRequired: boolean;
}

/** The slice of a FormSection row the editor actually reads. */
export interface EditorSection {
  id: string;
  label: string;
  columns: number;
  isCollapsible: boolean;
  displayOrder: number;
}

export interface RoleOption {
  id: string;
  name: string;
  isLocked: boolean;
}

export interface DraftField {
  fieldId: string;
  colSpan: number;
}

export interface DraftSection {
  sectionId: string;
  fields: DraftField[];
}

/** Where the loaded spec came from: the role's own row, the module default,
 *  or nowhere (plain field order). */
export type LayoutSource = 'role' | 'module' | 'none';

export function reconcile(
  fields: EditorField[],
  sections: EditorSection[],
  spec: LayoutSpec | null,
): DraftSection[] {
  const live = new Map(fields.filter((f) => !f.isDeleted).map((f) => [f.id, f]));
  const ordered = [...sections].sort((a, b) => a.displayOrder - b.displayOrder);

  const draft: DraftSection[] = ordered.map((s) => ({ sectionId: s.id, fields: [] }));
  const bySection = new Map(draft.map((d) => [d.sectionId, d]));
  const first = draft[0];
  const last = draft[draft.length - 1];

  const placed = new Set<string>();

  // 1. place what the spec lists — skipping deleted fields and dead sections
  if (spec && first) {
    for (const sec of spec.sections) {
      const target = bySection.get(sec.sectionId) ?? first;
      for (const ref of sec.fields) {
        const f = live.get(ref.fieldId);
        if (!f || placed.has(f.id)) continue;
        target.fields.push({ fieldId: f.id, colSpan: ref.colSpan ?? 1 });
        placed.add(f.id);
      }
    }
  }

  // 2. append every live field the spec does not know about
  if (last) {
    const orphans = [...live.values()]
      .filter((f) => !placed.has(f.id))
      .sort((a, b) => a.displayOrder - b.displayOrder);
    for (const f of orphans) {
      const target = (f.sectionId && bySection.get(f.sectionId)) || last;
      target.fields.push({ fieldId: f.id, colSpan: 1 });
    }
  }

  return draft;
}

/** Serialise the draft into the wire shape layoutSaveSchema expects. */
export function toSpec(draft: DraftSection[]): LayoutSpec {
  return {
    sections: draft.map((s) => ({
      sectionId: s.sectionId,
      fields: s.fields.map((f) => ({ fieldId: f.fieldId, colSpan: f.colSpan })),
    })),
  };
}
