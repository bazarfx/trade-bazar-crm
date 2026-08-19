'use client';

import type { LayoutTargetValue } from '@crm/shared';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import type { DraftField, DraftSection, EditorField, EditorSection } from './draft';

/**
 * Spec §13 "preview mode": the DRAFT rendered as a read-only form skeleton.
 * Purely client-side — nothing is persisted, and closing it changes nothing.
 *
 * Tailwind only sees classes written in full, so the grid/span classes are
 * spelled out in maps instead of interpolated.
 */
const GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
};
const COL_SPAN: Record<number, string> = {
  1: 'col-span-1',
  2: 'col-span-2',
  3: 'col-span-3',
};

interface LayoutPreviewProps {
  slug: string;
  moduleLabel: string;
  target: LayoutTargetValue;
  draft: DraftSection[];
  fieldById: Map<string, EditorField>;
  sectionById: Map<string, EditorSection>;
  onClose: () => void;
}

export function LayoutPreview({
  slug,
  moduleLabel,
  target,
  draft,
  fieldById,
  sectionById,
  onClose,
}: LayoutPreviewProps) {
  return (
    <FullScreenOverlay
      title={`Preview — ${moduleLabel} ${target === 'FORM' ? 'form' : 'detail'} layout`}
      onClose={onClose}
      trackPrefix={`${slug}.layout-preview`}
    >
      <div className="mx-auto max-w-4xl px-8 py-10">
        <p className="text-xs text-body">
          Read-only preview of the current draft — nothing here is published until you save.
        </p>

        {draft.map((ds) => {
          const meta = sectionById.get(ds.sectionId);
          if (!meta) return null;
          // clamp to the schema's 1-3 range so a bad value cannot break the grid
          const cols = Math.min(Math.max(meta.columns, 1), 3);
          return (
            <section key={ds.sectionId} className="mt-6 rounded border border-border bg-surface">
              <header className="border-b border-border px-6 py-3">
                <h2 className="truncate text-sm font-semibold text-heading" title={meta.label}>
                  {meta.label}
                </h2>
              </header>
              <div className={`grid gap-4 p-6 ${GRID_COLS[cols] ?? 'grid-cols-3'}`}>
                {ds.fields.map((df: DraftField) => {
                  const field = fieldById.get(df.fieldId);
                  if (!field) return null;
                  // a span wider than the grid would spill into implicit columns
                  const span = Math.min(Math.max(df.colSpan, 1), cols);
                  return (
                    <div key={df.fieldId} className={COL_SPAN[span] ?? 'col-span-1'}>
                      <label className="block truncate text-xs text-body" title={field.label}>
                        {field.label}
                        {field.isRequired ? ' *' : ''}
                      </label>
                      <input
                        disabled
                        placeholder={field.type}
                        className="mt-1 w-full rounded border border-border bg-background px-3 py-1.5 text-sm text-body"
                      />
                    </div>
                  );
                })}
                {ds.fields.length === 0 && (
                  <p className={`${COL_SPAN[cols] ?? 'col-span-3'} text-xs text-body`}>No fields in this section.</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </FullScreenOverlay>
  );
}
