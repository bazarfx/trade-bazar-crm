'use client';

import { useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Select } from '@/components/ui';
import { PendingOverlay } from './pending-overlay';
import { FilterIcon, SortIcon } from './icons';

/**
 * The list panel's toolbar. The view selector is fed by `SavedView` rows, the
 * page size by the URL — neither this component nor anything under it knows
 * which module it is drawing.
 */
export interface ToolbarView {
  id: string;
  name: string;
}

export interface ListToolbarProps {
  slug: string;
  /** module.labelPlural — the default view is literally "All {these}". */
  labelPlural: string;
  views: ToolbarView[];
  pageSize: number;
  pageSizes: readonly number[];
}

type PendingAction = 'filter' | 'sort';

const PENDING_COPY: Record<PendingAction, { title: string; message: string }> = {
  filter: {
    title: 'Filter records',
    message:
      "The filter builder composes conditions from this module's own fields and the operators " +
      'each field type declares. It arrives with the filter engine slice.',
  },
  sort: {
    title: 'Sort records',
    message:
      'Sorting is part of a saved view, so it lands with the views slice — a sort that cannot be ' +
      'saved is a setting every user has to re-apply on every visit.',
  },
};

export function ListToolbar({ slug, labelPlural, views, pageSize, pageSizes }: ListToolbarProps) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingAction | null>(null);

  function changePageSize(e: ChangeEvent<HTMLSelectElement>) {
    // Always back to page one: row 40 of a 25-row page is not row 40 of a
    // 100-row page, so carrying the page number over lands somewhere arbitrary.
    router.push(`?size=${encodeURIComponent(e.target.value)}`);
  }

  const copy = pending ? PENDING_COPY[pending] : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-3">
        <Select
          // Disabled rather than live: switching views has to apply the view's
          // columns, filters and sort, and none of those exist yet. A select
          // that moves and changes nothing is the worse of the two.
          disabled
          defaultValue=""
          aria-label="View"
          title="Saved views arrive with the views slice."
          className="w-44"
          data-track={`${slug}.list.view.select`}
        >
          <option value="">All {labelPlural}</option>
          {views.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </Select>

        <div className="ml-auto flex items-center gap-3">
          <Button
            variant="ghost"
            iconLeft={<FilterIcon className="h-4 w-4" />}
            onClick={() => setPending('filter')}
            data-track={`${slug}.list.filter.open`}
          >
            Filter
          </Button>

          <Button
            variant="ghost"
            iconLeft={<SortIcon className="h-4 w-4" />}
            onClick={() => setPending('sort')}
            data-track={`${slug}.list.sort.open`}
          >
            Sort
          </Button>

          <Select
            value={String(pageSize)}
            onChange={changePageSize}
            aria-label="Rows per page"
            className="w-36"
            data-track={`${slug}.list.pagesize.select`}
          >
            {pageSizes.map((n) => (
              <option key={n} value={n}>
                Show {n} Rows
              </option>
            ))}
          </Select>
        </div>
      </div>

      {copy ? (
        <PendingOverlay
          title={copy.title}
          message={copy.message}
          trackPrefix={`${slug}.list`}
          onClose={() => setPending(null)}
        />
      ) : null}
    </>
  );
}
