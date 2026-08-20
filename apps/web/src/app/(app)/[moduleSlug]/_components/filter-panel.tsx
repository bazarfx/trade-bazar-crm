'use client';

import { useState, type ReactNode } from 'react';
import { Panel } from '@/components/ui';
import { ChevronDownIcon } from './icons';

/**
 * The left filter rail. Three collapsible groups, exactly the three the
 * reference frame draws — but nothing inside them is written by hand: the
 * field list is this module's `FieldDefinition` rows and the related-module
 * list is whichever modules actually point at this one.
 *
 * The rows are disabled on purpose. The filter compiler is a later slice, and
 * a control that looks live and silently does nothing is worse than one that
 * says why it cannot yet.
 */
export interface FilterField {
  key: string;
  label: string;
}

export interface RelatedModule {
  slug: string;
  labelPlural: string;
}

export interface FilterPanelProps {
  slug: string;
  /** module.labelPlural — the panel title is "Filter by {these}". */
  labelPlural: string;
  fields: FilterField[];
  relatedModules: RelatedModule[];
}

/** The reason every row in here is inert today, said once. */
const PENDING_REASON = 'Filtering arrives with the filter engine slice.';

export function FilterPanel({ slug, labelPlural, fields, relatedModules }: FilterPanelProps) {
  // Open by default, as the frame draws them: a rail that starts collapsed
  // hides the one thing it exists to show.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups: { id: string; label: string; body: ReactNode }[] = [
    {
      id: 'system',
      label: 'System Defined Filters',
      body: (
        <EmptyNote>
          Untouched records, locked records and the other system filters are defined by the filter
          engine, not by this module. {PENDING_REASON}
        </EmptyNote>
      ),
    },
    {
      id: 'fields',
      label: 'Filter By fields',
      body:
        fields.length === 0 ? (
          <EmptyNote>This module has no fields yet, so there is nothing to filter on.</EmptyNote>
        ) : (
          <ul className="flex flex-col gap-1">
            {fields.map((f) => (
              <FilterRow key={f.key} label={f.label} />
            ))}
          </ul>
        ),
    },
    {
      id: 'related',
      label: 'Filter By Related Modules',
      body:
        relatedModules.length === 0 ? (
          <EmptyNote>No other module links to this one yet.</EmptyNote>
        ) : (
          <ul className="flex flex-col gap-1">
            {relatedModules.map((m) => (
              <FilterRow key={m.slug} label={m.labelPlural} />
            ))}
          </ul>
        ),
    },
  ];

  return (
    // shrink-0 so a wide table can never squeeze the rail below its 230px.
    <Panel className="flex w-filters shrink-0 flex-col overflow-hidden">
      {/* 12px padding, not the panel default of 24: at 230px wide the standard
          padding would leave 182px for a field label, and these truncate. */}
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <h2 className="truncate text-sm font-medium text-heading" title={`Filter by ${labelPlural}`}>
          Filter by {labelPlural}
        </h2>

        {/* min-h-0 + overflow-y-auto: the rail scrolls, the page does not. */}
        <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {groups.map((group) => {
            const isOpen = collapsed[group.id] !== true;
            const regionId = `filter-${slug}-${group.id}`;
            return (
              <section key={group.id}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={regionId}
                  onClick={() =>
                    setCollapsed((prev) => ({ ...prev, [group.id]: prev[group.id] !== true }))
                  }
                  data-track={`${slug}.list.filter.group.toggle`}
                  className="flex w-full items-center gap-2 rounded text-left text-xs font-medium text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <ChevronDownIcon
                    // One chevron rotated, so open and closed can never drift
                    // into two differently-shaped glyphs.
                    className={`h-4 w-4 shrink-0 transition-transform ${isOpen ? '' : '-rotate-90'}`}
                  />
                  <span className="truncate" title={group.label}>
                    {group.label}
                  </span>
                </button>

                {isOpen ? (
                  <div id={regionId} className="mt-2 pl-2">
                    {group.body}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-xs text-body">{children}</p>;
}

/**
 * A filter row, hand-rolled rather than the `Checkbox` primitive: that one is
 * built for form density (20px control, 14px label) and this rail runs at the
 * frame's list density (16px control, 12px label, 20px pitch). It is also
 * permanently disabled, so it carries no `data-track` — a control that cannot
 * be interacted with cannot produce an interaction to log.
 */
function FilterRow({ label }: { label: string }) {
  return (
    <li>
      <label className="flex cursor-not-allowed items-center gap-2 text-xs text-body opacity-70" title={`${label} — ${PENDING_REASON}`}>
        <input type="checkbox" disabled className="h-4 w-4 shrink-0 rounded accent-primary" />
        <span className="truncate">{label}</span>
      </label>
    </li>
  );
}
