'use client';

import { useState } from 'react';
import { NO_VIEW } from './list-query';
import { SortMenu } from './sort-menu';
import { SortIcon } from './icons';

/**
 * The list panel's toolbar. The view selector is fed by `SavedView` rows and
 * the sort by the URL — neither this component nor anything under it knows
 * which module it is drawing.
 *
 * Measured off `CRM _ Leads`, frame-relative (list panel `Rectangle 6`
 * @514,152 910x856). Every control in this row is **28 tall with 10px text**,
 * a step below the 38px band above it, and the row is 52 tall:
 *
 *   FRAME "Frame 6"   @526,164  89x28  bg:#ffffff border:#e5e7eb r:4 pad:10/12
 *                     → "All Leads" 10px Regular #111827 + Chevron 12, gap 4
 *   FRAME "Frame 10"  @1154,164 137x28 bg:#f6f8fa border:#e5e7eb r:4 pad:7/10
 *                     → search 14 + "Search Here", gap 8
 *   FRAME "Frame 12"  @1303,164 68x28  bg:#ffffff r:4 pad:10/12
 *                     → sort 14 + "Sort" 10px Regular, gap 4.
 *                       On `CRM _ Leads-Sort Filter` the SAME node is
 *                       bg:#f6f8fa + 1px #e5e7eb — that is its OPEN state.
 *   FRAME "Frame 13"  @1383,164 28x28  bg:#ffffff border:#e5e7eb r:4
 *                     → `prime:list` 14x14, icon only
 *
 * The row is 152…204 of the panel: 12 padding, a 28 control, 12 padding.
 *
 * ⚠️ Two of those nodes are deliberately NOT built here; see the report on
 * this slice. `Frame 10` is a SECOND search box (the rail already carries the
 * one at @284,190 that the page wires up), and `Frame 13` is a view-mode
 * switcher we have no config to fill. The page-size control is not in this row
 * at all — the file draws it as "Show [ N ] Row" inside the pagination
 * cluster, which is where `pagination.tsx` now renders it.
 *
 * ⚠️ There is NO Filter control in this row, and there used to be. Counted
 * across every Leads screen the file draws Filter exactly ONCE per screen and
 * never twice — but WHERE depends on whether the layout has a toolbar band:
 *
 *   with a band (`Rectangle 5` 1152x56 @272,84 — 11 screens, and ours):
 *     the band carries `Frame 482685` 122x38 @284,93, and this row is
 *     Frame 6 / Frame 10 / Frame 12 / Frame 13. No Filter.
 *   without a band (`Rectangle 5` IS the panel, 810x908 or 1154x908 @272,84 —
 *     2 screens): no band button, and this row gains `Frame 11` 68x28 "Filter"
 *     immediately left of Sort.
 *
 * We build the banded layout, so the band's `FilterToggle` is the one Filter
 * this screen gets. The button removed from here scrolled to and focused the
 * same always-on-screen rail that `FilterToggle` already scrolls to and
 * focuses, so nothing became unreachable; two identical "Filter" buttons 20px
 * apart vertically is a shape the file never draws. Removed 26 Aug 2026.
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
  /**
   * PENDING duplicate flags in this module (spec §6.6) — 0 hides the button
   * entirely, and 0 is also what a module whose storage cannot carry flags, or
   * an actor who may not resolve them, receives from the page. A queue button
   * that opens onto "you may not do this" would be a door drawn shut.
   */
  duplicateCount: number;
  onOpenReview: () => void;
}

/**
 * The shared recipe for this row: 28 tall, radius 4, 10px label, 12px padding.
 * 28 and 10 are both measured and neither is on the spacing/type scale, so
 * they are written as the file gives them rather than rounded onto it.
 */
const CONTROL =
  'h-[28px] rounded px-3 text-[10px] leading-4 text-heading transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-1 focus-visible:ring-offset-surface ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Buttons add the box; the `<select>` deliberately does not. A native select
 * given `display: inline-flex` hands its own internals to a flex formatting
 * context, which is where its arrow and its text stop agreeing about where the
 * middle of a 28px box is — so `CONTROL` above carries no display at all.
 */
const CONTROL_BUTTON = `${CONTROL} inline-flex shrink-0 items-center gap-1`;

export function ListToolbar({
  slug,
  labelPlural,
  views,
  appliedViewId,
  onSelectView,
  sortLabel,
  sortDirection,
  onSort,
  duplicateCount,
  onOpenReview,
}: ListToolbarProps) {
  const [sortOpen, setSortOpen] = useState(false);

  return (
    // 12/12 around a 28px control is the measured 52px row. No wrapping: the
    // file's row is a fixed height and a second line would push the table down
    // by exactly one row of records.
    <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-3">
      {/*
        A native <select> written out here rather than the shared `Select`
        primitive: that one is 36 tall on a #f6f8fa fill (the header search
        box it was measured from) and overriding its height from a className
        is the coin-flip that `PanelBody` and `Input` both document — two
        competing utilities resolve by stylesheet order, not attribute order.

        min-w rather than the measured 89: a saved view's name is Admin-typed
        and has no length limit, so 89 is the floor and the cap keeps a long
        one from eating the row. It is also the ONLY control here allowed to
        shrink — below the design's 1440 the buttons keep their measured size
        and this gives back the width, rather than the row wrapping onto a
        second line and pushing the table down by a record.
      */}
      <select
        value={appliedViewId ?? NO_VIEW}
        aria-label="View"
        onChange={(e) => onSelectView(e.target.value)}
        data-track={`${slug}.view.select`}
        className={`${CONTROL} min-w-[89px] max-w-44 border border-border bg-surface`}
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
      </select>

      {duplicateCount > 0 ? (
        // The review queue (spec §6.6), surfaced where the flagged records
        // live. Visible only while there is something to review — an empty
        // queue is not an action anyone needs offered. The file draws no such
        // control, so it borrows this row's measured 28px recipe rather than
        // inventing a size.
        <button
          type="button"
          onClick={onOpenReview}
          data-track={`${slug}.review.open`}
          className={`${CONTROL_BUTTON} border border-border bg-surface hover:bg-background`}
        >
          Review duplicates ({duplicateCount})
        </button>
      ) : null}

      {/* The row's right cluster. The file ends it at the panel's 12px gutter
          (`Frame 13` @1383 + 28 = 1411 against the panel edge at 1424) with 12
          between controls — this row's own `px-3` and `gap-3`. Sort is the only
          one of those three we build, so `ml-auto` carries it to that edge.
          relative: the menu is positioned against this button, not the panel. */}
      <div className="relative ml-auto">
        <button
          type="button"
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
          // Resting is a bare white chip; open takes the #f6f8fa fill and
          // the 1px border, which is exactly how the sort frame draws it.
          className={`${CONTROL_BUTTON} ${
            sortOpen ? 'border border-border bg-background' : 'bg-surface hover:bg-background'
          }`}
        >
          <SortIcon className="h-3.5 w-3.5" />
          Sort
        </button>

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
    </div>
  );
}
