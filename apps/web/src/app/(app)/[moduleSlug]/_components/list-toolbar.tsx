'use client';

import { useState, type ChangeEvent } from 'react';
import { Button, Select } from '@/components/ui';
import { NO_VIEW } from './list-query';
import { SortMenu } from './sort-menu';
import { FilterIcon, SortIcon } from './icons';

/**
 * The list panel's toolbar. The view selector is fed by `SavedView` rows, the
 * page size and the sort by the URL — neither this component nor anything
 * under it knows which module it is drawing.
 */
export interface ToolbarView {
  id: string;
  name: string;
  isShared: boolean;
  isDefault: boolean;
  isValid: boolean;
}

export interface ListToolbarProps {
  slug: string;
  /** module.labelPlural — the default entry is literally "All {these}". */
  labelPlural: string;
  views: ToolbarView[];
  /** the view in effect, or null for the unfiltered list */
  appliedViewId: string | null;
  onSelectView: (viewId: string) => void;
  /** the column the sort menu will act on, and which way it currently runs */
  sortLabel: string | null;
  sortDirection: 'asc' | 'desc';
  onSort: (direction: 'asc' | 'desc') => void;
  /** how many conditions the applied filter carries; 0 hides the badge */
  filterCount: number;
  onFocusFilters: () => void;
  pageSize: number;
  pageSizes: readonly number[];
  onChangePageSize: (size: number) => void;
  /**
   * PENDING duplicate flags in this module (spec §6.6) — 0 hides the button
   * entirely, and 0 is also what a module whose storage cannot carry flags, or
   * an actor who may not resolve them, receives from the page. A queue button
   * that opens onto "you may not do this" would be a door drawn shut.
   */
  duplicateCount: number;
  onOpenReview: () => void;
}

export function ListToolbar({
  slug,
  labelPlural,
  views,
  appliedViewId,
  onSelectView,
  sortLabel,
  sortDirection,
  onSort,
  filterCount,
  onFocusFilters,
  pageSize,
  pageSizes,
  onChangePageSize,
  duplicateCount,
  onOpenReview,
}: ListToolbarProps) {
  const [sortOpen, setSortOpen] = useState(false);

  function changePageSize(e: ChangeEvent<HTMLSelectElement>) {
    // Always back to page one: row 40 of a 25-row page is not row 40 of a
    // 100-row page, so carrying the page number over lands somewhere arbitrary.
    onChangePageSize(Number(e.target.value));
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-3">
      <Select
        value={appliedViewId ?? NO_VIEW}
        aria-label="View"
        className="w-44"
        onChange={(e) => onSelectView(e.target.value)}
        data-track={`${slug}.view.select`}
      >
        <option value={NO_VIEW}>All {labelPlural}</option>
        {views.map((v) => (
          // A view whose stored spec no longer parses stays listed — its owner
          // has to be able to see it to delete it — but it cannot be applied.
          <option key={v.id} value={v.id} disabled={!v.isValid}>
            {v.name}
            {v.isDefault ? ' (default)' : ''}
            {v.isValid ? '' : ' — unavailable'}
          </option>
        ))}
      </Select>

      {duplicateCount > 0 ? (
        // The review queue (spec §6.6), surfaced where the flagged records
        // live. Visible only while there is something to review — an empty
        // queue is not an action anyone needs offered.
        <Button
          variant="secondary"
          onClick={onOpenReview}
          data-track={`${slug}.review.open`}
        >
          Review duplicates ({duplicateCount})
        </Button>
      ) : null}

      <div className="ml-auto flex items-center gap-3">
        <Button
          variant="ghost"
          iconLeft={<FilterIcon className="h-4 w-4" />}
          onClick={onFocusFilters}
          // The rail is always on screen in this design, so this jumps to it
          // rather than opening a second filter surface that would then have
          // to be kept in step with the first.
          title="Go to the filter rail"
          data-track={`${slug}.list.filter.open`}
        >
          Filter
          {filterCount > 0 ? (
            <span className="ml-1 rounded-pill bg-primary px-2 py-0.5 text-overline text-surface">
              {filterCount}
            </span>
          ) : null}
        </Button>

        {/* relative: the menu is positioned against this button, not the panel */}
        <div className="relative">
          <Button
            variant="ghost"
            iconLeft={<SortIcon className="h-4 w-4" />}
            aria-haspopup="menu"
            aria-expanded={sortOpen}
            disabled={sortLabel === null}
            title={
              sortLabel === null
                ? 'This list has no columns to sort by.'
                : `Sorting by ${sortLabel}`
            }
            onClick={() => setSortOpen((open) => !open)}
            data-track={`${slug}.list.sort.open`}
          >
            Sort
          </Button>

          {sortOpen && sortLabel !== null ? (
            <SortMenu
              slug={slug}
              fieldLabel={sortLabel}
              direction={sortDirection}
              onSelect={(direction) => {
                setSortOpen(false);
                onSort(direction);
              }}
              onClose={() => setSortOpen(false)}
            />
          ) : null}
        </div>

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
  );
}
