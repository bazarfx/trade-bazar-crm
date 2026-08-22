'use client';

import { useMemo } from 'react';
import type { StatusOption } from '@/app/(app)/[moduleSlug]/_components/cell';
import { cn, Panel, PanelBody, PanelHeader } from '@/components/ui';
import { renderValue, valueTooltip, type DetailField } from './value';

/**
 * The information panel — the record, read-only, in the sections and order an
 * Admin arranged in the layout editor.
 *
 * It is handed sections, fields and values and has no idea which module
 * produced them: the same component draws a Lead, a Deal and whatever module
 * exists in 2027. Editing happens in the full-screen form overlay, never
 * inline here — there is exactly one place a record is written from.
 *
 * Some values are IMMUTABLE by design — Closed By on a deal is "permanent
 * credit for the converting agent" (spec §7.1) and is never written again
 * after conversion. The page names those from the storage shape, and this
 * panel draws a lock beside them so the reader knows the value is a fact,
 * not a setting.
 */

export interface InfoSection {
  id: string;
  label: string;
  fields: DetailField[];
}

/** A field whose value can never be edited, with the reason a person reads. */
export interface LockedValue {
  key: string;
  reason: string;
}

export interface InfoPanelProps {
  title: string;
  sections: InfoSection[];
  /** flat, field-keyed values, already stripped of anything hidden */
  record: Record<string, unknown>;
  statuses: StatusOption[];
  /** [id, fullName] for every user this record references */
  userNames: [string, string][];
  /** immutable values, by field key — drawn with a lock */
  locked?: LockedValue[];
  className?: string;
}

export function InfoPanel({
  title,
  sections,
  record,
  statuses,
  userNames,
  locked = [],
  className,
}: InfoPanelProps) {
  // Maps, not `.find()` per row: a Leads record renders ~33 rows and both of
  // these are keyed on ids that never repeat.
  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);
  const userNameById = useMemo(() => new Map(userNames), [userNames]);
  const lockReason = useMemo(() => new Map(locked.map((l) => [l.key, l.reason])), [locked]);

  return (
    <Panel className={cn('flex flex-col overflow-hidden', className)}>
      <PanelHeader title={title} />

      {/* The panel is a fixed height and this is what scrolls inside it, so a
          module with 40 fields never pushes the timeline off the page. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PanelBody className="flex flex-col gap-6">
          {sections.length === 0 ? (
            <p className="text-sm text-body">
              This module has no fields you can see, so there is nothing to show here.
            </p>
          ) : (
            sections.map((section) => (
              <section key={section.id || section.label}>
                {section.label ? (
                  <h3
                    className="mb-3 truncate text-overline font-medium uppercase text-muted"
                    title={section.label}
                  >
                    {section.label}
                  </h3>
                ) : null}

                <dl className="flex flex-col gap-3">
                  {section.fields.map((field) => {
                    const value = record[field.key];
                    const args = { field, value, statusById, userNameById };
                    const reason = lockReason.get(field.key);
                    return (
                      <div key={field.key} className="grid grid-cols-3 items-baseline gap-3">
                        {/* Truncate, never wrap: field labels are Admin-authored
                            and have no length limit, and a wrapped label pushes
                            every row below it out of alignment. */}
                        <dt className="col-span-1 truncate text-xs text-body" title={field.label}>
                          {field.label}
                        </dt>
                        <dd
                          className="col-span-2 flex min-w-0 items-baseline gap-1.5 text-sm text-heading"
                          title={reason ?? valueTooltip(args)}
                        >
                          {reason !== undefined ? (
                            // The glyph carries the reason as its accessible
                            // name; sighted readers get the same text on hover.
                            <span role="img" aria-label={reason} className="shrink-0 text-xs text-muted">
                              🔒
                            </span>
                          ) : null}
                          <span className="min-w-0 truncate">{renderValue(args)}</span>
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
            ))
          )}
        </PanelBody>
      </div>
    </Panel>
  );
}
