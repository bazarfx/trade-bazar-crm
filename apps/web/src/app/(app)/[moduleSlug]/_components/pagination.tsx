'use client';

import Link from 'next/link';
import type { ChangeEvent } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from './icons';

/**
 * The list panel's footer row, measured off `CRM _ Leads` (frame-relative,
 * panel `Rectangle 6` @514,152 910x856):
 *
 *   FRAME "Pagination"        @526,959  849x37  flex-row gap:24
 *     FRAME "Page Indicator"  @526,959  145x37  flex-row gap:12
 *       TEXT  "Show"          12px Medium #111827
 *       INSTANCE "Buttons"    @570,959  64x37   bg:#ffffff  border:#f6f8fa  r:4
 *       TEXT  "Row"           12px Medium #111827
 *     FRAME "Pagination"      @695,961  680x33  flex-row gap:12  main:MAX
 *       INSTANCE "Buttons"    @1056,962 32x32   bg:#f9f9f9  r:4   ← prev
 *       FRAME    "Buttons"    @1100,961 231x33  flex-row gap:0    ← 7 × 33
 *         current            bg:#00667a, the rest unfilled
 *       INSTANCE "Buttons"    @1343,962 32x32   bg:#f6f8fa  r:4   ← next
 *
 * Two things the build had wrong until this was re-measured on 26 Aug 2026:
 * the cluster is **justify-between**, not centred (the page-size control sits
 * at the panel's left edge and the pager ends at its right), and the page-size
 * control lives HERE rather than in the toolbar — the file draws it as
 * "Show [ N ] Row", three nodes inside `Page Indicator`, not as one
 * "Show N Rows" select.
 *
 * ⚠️ The 849 above does NOT mean a 49px right inset, and a reviewer measuring
 * only the 910-wide panel will conclude it does (526+849 = 1375 against the
 * panel's right edge at 1424). Every OTHER panel width in the file insets the
 * cluster symmetrically:
 *
 *     panel  778 → pager @642 w754   inset 12 / 12
 *     panel  873 → pager @538 w849   inset 12 / 12   ← same 849 frame
 *     panel 1122 → pager @304 w1090  inset 16 / 16
 *     panel 1152 → pager @284 w1128  inset 12 / 12
 *     panel  910 → pager @526 w849   inset 12 / 49   ← the odd one out
 *
 * 910 − 873 = 37 = 49 − 12: the 849-wide frame that fits the 873 panel exactly
 * was carried onto the 910 one without being resized. `justify-between` inside
 * the panel's own 12px gutter is the rule the other four widths agree on, so
 * that is what this renders. Re-measured and rejected 26 Aug 2026.
 *
 * The page buttons stay `<Link>`s: the page number lives in the URL, so a
 * paged list can be bookmarked, shared and re-entered by the browser's back
 * button — none of which survives holding it in component state. The
 * component is a client one only because the page-size control is a live
 * `<select>`; the pager itself is still pure markup.
 */
export interface PaginationProps {
  slug: string;
  /** 1-based. */
  page: number;
  pageCount: number;
  /**
   * Builds the href for a page number. Passed in rather than assembled here:
   * the rest of the query state — the saved view, the sort, the search term
   * and the fragment carrying an ad-hoc filter — has to survive a page click,
   * and a pager that rebuilds the URL from two of those parameters silently
   * drops the others. One builder, in the screen that owns the state.
   */
  hrefFor: (page: number) => string;
  /** rows per page, in effect now — the "Show [ N ] Row" box */
  pageSize: number;
  /** the sizes this module offers; config, never a literal in this file */
  pageSizes: readonly number[];
  onChangePageSize: (size: number) => void;
}

/** Page buttons drawn at once. Measured: the file draws exactly seven. */
const WINDOW = 7;

function pageWindow(page: number, pageCount: number): number[] {
  const size = Math.min(WINDOW, pageCount);
  // Keep the current page centred until the window hits either end.
  const start = Math.min(Math.max(1, page - Math.floor(size / 2)), pageCount - size + 1);
  return Array.from({ length: size }, (_, i) => start + i);
}

/** 33x33 in the file — off the 4px scale, so it is written as measured. */
const PAGE_BUTTON =
  'inline-flex h-[33px] min-w-[33px] items-center justify-center rounded px-2 ' +
  'text-xs font-medium ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

/** The two arrows are 32x32, a step smaller than the numbers they flank. */
const STEP =
  'inline-flex h-8 w-8 items-center justify-center rounded ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

export function Pagination({
  slug,
  page,
  pageCount,
  hrefFor,
  pageSize,
  pageSizes,
  onChangePageSize,
}: PaginationProps) {
  // An empty module still shows page 1 of 1 — a pager that vanishes reads as a
  // broken screen, and this one is telling the truth.
  const total = Math.max(1, pageCount);
  const current = Math.min(Math.max(1, page), total);

  function changePageSize(e: ChangeEvent<HTMLSelectElement>) {
    // Always back to page one: row 40 of a 25-row page is not row 40 of a
    // 100-row page, so carrying the page number over lands somewhere arbitrary.
    // (The caller does the reset; this only reports the new size.)
    onChangePageSize(Number(e.target.value));
  }

  return (
    // 10 above / 12 below and a 12px gutter — the cluster sits at y=959 under a
    // scrollbar band ending at 949, inside a panel whose floor is 1008.
    <div className="flex shrink-0 items-center justify-between gap-6 px-3 pb-3 pt-[10px]">
      {/* `Page Indicator` — "Show [ N ] Row", gap 12. */}
      <div className="flex items-center gap-3">
        {/*
          The label is split around the control exactly as the file draws it,
          so the number reads as an editable value rather than as part of a
          sentence. `htmlFor` is not available without an id we would have to
          generate, so the accessible name rides on the select itself.
        */}
        <span aria-hidden="true" className="text-xs font-medium text-heading">
          Show
        </span>
        <select
          value={String(pageSize)}
          onChange={changePageSize}
          aria-label="Rows per page"
          data-track={`${slug}.list.pagesize.select`}
          // 64x37, white, r:4, pad 8/12. The border is #f6f8fa in the file —
          // the same value as `background`, i.e. an edge that reads as none.
          // min-w rather than w: a four-digit page size must not clip.
          className={
            'h-[37px] min-w-16 rounded border border-background bg-surface px-3 ' +
            'text-xs font-medium text-heading ' +
            'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary'
          }
        >
          {pageSizes.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span aria-hidden="true" className="text-xs font-medium text-heading">
          Row
        </span>
      </div>

      <nav aria-label="Pagination" className="flex items-center gap-3">
        <Step
          slug={slug}
          href={hrefFor(current - 1)}
          enabled={current > 1}
          label="Previous page"
          icon={<ChevronLeftIcon className="h-4 w-4" />}
        />

        {/* gap:0 — the seven 33px buttons abut, measured @1100…1331. */}
        <div className="flex items-center">
          {pageWindow(current, total).map((n) =>
            n === current ? (
              <span key={n} aria-current="page" className={`${PAGE_BUTTON} bg-primary text-surface`}>
                {n}
              </span>
            ) : (
              <Link
                key={n}
                href={hrefFor(n)}
                data-track={`${slug}.list.page.open`}
                className={`${PAGE_BUTTON} text-heading hover:bg-background`}
              >
                {n}
              </Link>
            ),
          )}
        </div>

        <Step
          slug={slug}
          href={hrefFor(current + 1)}
          enabled={current < total}
          label="Next page"
          icon={<ChevronRightIcon className="h-4 w-4" />}
        />
      </nav>
    </div>
  );
}

function Step({
  slug,
  href,
  enabled,
  label,
  icon,
}: {
  slug: string;
  href: string;
  enabled: boolean;
  label: string;
  icon: React.ReactNode;
}) {
  // A disabled arrow renders as a span, not a dimmed link: a link that goes
  // nowhere is still in the tab order and still announces as a link.
  //
  // The two fills are measured, and they are not the same: the frame is on
  // page 1, so its LEFT arrow (disabled) is #f9f9f9 → `subtle` and its RIGHT
  // arrow (live) is #f6f8fa → `background`.
  //
  // No `opacity` on the wrapper. The disabled arrow is the `Buttons` SYMBOL
  // `Size=Small, Hierarchy=Secondary, State=Disable, Icon Only=True` — a SOLID
  // #f9f9f9 chip — and a blanket 40% would resolve that fill to ~#fdfdfd over
  // the white panel, i.e. paint it away and leave a floating glyph. The state
  // is carried by the CONTENT colour instead, which is what the same symbol
  // family does: every `State=Disable` label in the frame is #d8d8d8
  // (`--globalcolors-neutral-60`), the value `button.tsx` already disables to.
  if (!enabled) {
    return (
      <span
        aria-disabled="true"
        className={`${STEP} bg-subtle text-[var(--globalcolors-neutral-60)]`}
      >
        {icon}
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-label={label}
      data-track={`${slug}.list.page.open`}
      className={`${STEP} bg-background text-heading hover:bg-subtle`}
    >
      {icon}
    </Link>
  );
}
